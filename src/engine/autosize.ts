// "Size wires and fuses": take a hand-drawn design (often just one part of the job, such as the
// charging or the AC) and set what the design check would otherwise ask for:
//   1. add a fuse where a battery, charging source or load has none (and rate an unrated panel or
//      fuse-block position a load hangs on);
//   2. rate every fuse and breaker that has no rating, and raise one that would blow at its
//      circuit's current;
//   3. size every wire with no size, and upsize every wire too small for its current, its fuse or
//      breaker, or its voltage-drop limit.
// It never makes a wire smaller or lowers a rating the owner entered: the drawing is the boat.
// It works on the design in place, so the caller can make it one undo step. Pure otherwise.

import { makeNode, NODE_DEFS } from '../model/nodeDefs';
import { uid } from '../model/examples';
import { GAUGES, VDROP } from '../model/standards';
import type { Design, DNode, Finding, Wire, WireEnd } from '../model/types';
import { fmtLen, fmtSize, type Units } from '../model/units';
import { audit, CHARGE_LINKS, circuitVolts, estimateCurrents, protectionOf } from './audit';
import { ampacity, fuseClassFor, gaugeIndex, nextStandard, PROTECTION_SIZES, protectionFor, protectionNeeded, sizeConductor, type ProtectionKind } from './calc';
import { BATTERY_FUSE_DRAFT_FT } from './existing';
import { buildGraph, key, passThrough, SOURCE_TERMS, walk, type Graph } from './graph';

export interface SizeResult {
  /** One line per change, in the order made, for the owner to read. */
  changes: string[];
  /** Things sizing could not settle, e.g. a load with no current entered. */
  notes: string[];
  /** Errors and warnings the design check still reports afterwards (sizing cannot add a switch or a galvanic isolator). */
  remaining: Finding[];
  counts: { fusesAdded: number; rated: number; raised: number; sized: number; upsized: number };
}

export interface SizeOptions {
  acVolts?: number;
  units?: Units;
  /** Only work on these components and the wires between them (a Focus). Undefined: the whole drawing. */
  only?: Set<string>;
}

const name = (n: DNode | undefined) => n?.label ?? '?';
/**
 * A solar array's protection is rated from its short-circuit current, about 1.1 × its working current,
 * times 1.25 (US NEC 690.8) before the usual 1.25: 1.1 × 1.56 × the working current in all, as the
 * ideal design rates its PV disconnect (src/engine/ideal/renewables.ts). Not from Blue Sea Systems.
 */
const PV_CURRENT_FACTOR = 1.1 * 1.25;
/**
 * The positive terminal each negative terminal returns current for. A negative wire is sized for the
 * fuse on its own positive (PV− with PV+, BAT− with BAT+), not for the biggest fuse on the part.
 */
const NEG_PAIR: Record<string, Record<string, string[]>> = {
  load: { neg: ['pos'] },
  engine: { neg: ['pos'] },
  alternator: { neg: ['b'] },
  apd: { neg: ['b'] },
  mppt: { pvneg: ['pvpos'], batneg: ['bat'] },
  controller: { neg: ['bat'] },
  dcdc: { inneg: ['in'], outneg: ['out'] },
  converter: { inneg: ['in'], outneg: ['out'] },
  inverter: { dcneg: ['dcpos'] },
  'inverter-charger': { dcneg: ['dcpos'] },
  charger: { neg: ['out1', 'out2', 'out3'] },
};

/** Parts a feed passes straight through on its way to a load (they protect nothing). */
const INLINE = new Set(['switch', 'contactor', 'bilge-switch']);

/**
 * Where a component's own feed first meets the rest of the system. Every load and every charging
 * source needs its own fuse or breaker there, at the bus or battery end: a branch protected only by a
 * big main fuse further back is not protected for its own (smaller) wire. Follows the feed through a
 * switch or contactor. Returns the wire and end that need the fuse, or nothing when a fuse, breaker
 * or rated panel position is already the first thing reached (or the feed is not a simple chain).
 */
function branchEnd(g: Graph, n: DNode, term: string): { w: Wire; at: 'from' | 'to' } | undefined {
  let cur = { node: n.id, term };
  for (let hop = 0; hop < 8; hop++) {
    const ws = (g.at.get(key(cur.node, cur.term)) ?? []).filter((w) => w.kind === 'pos');
    if (ws.length !== 1) return undefined;
    const w = ws[0];
    const at = w.from.node === cur.node && w.from.term === cur.term ? 'to' : 'from';
    const fe = w[at];
    const far = g.node.get(fe.node);
    if (!far || NODE_DEFS[far.type].protective || far.type === 'battery') return undefined;
    if (INLINE.has(far.type)) {
      const through = passThrough(far, fe.term);
      // anything else on that terminal makes it a junction: the fuse goes there
      if (through.length !== 1 || (g.at.get(key(far.id, fe.term)) ?? []).filter((x) => x.kind === 'pos').length > 1) return { w, at };
      cur = { node: far.id, term: through[0] };
      continue;
    }
    // A charging relay or isolator is fused on its own sides; a non-conducting part ends the feed.
    if (!NODE_DEFS[far.type].conducts || far.type === 'acr' || far.type === 'isolator') return undefined;
    return { w, at }; // a bus, or another junction
  }
  return undefined;
}
const runsOf = (w: Wire) => (w.cable?.match(/^(\d+)× /) ? Number(w.cable.split('×')[0]) : 1);

export function sizeDrawing(d: Design, opts: SizeOptions = {}): SizeResult {
  const units = opts.units ?? 'imperial';
  const acVolts = opts.acVolts ?? 120;
  const only = opts.only;
  const inScope = (id: string) => !only || only.has(id);
  const wireInScope = (w: Wire) => inScope(w.from.node) && inScope(w.to.node);
  const res: SizeResult = { changes: [], notes: [], remaining: [], counts: { fusesAdded: 0, rated: 0, raised: 0, sized: 0, upsized: 0 } };
  const fresh = new Set<string>();

  /**
   * Put a fuse into a wire, next to one of its ends. The end's side keeps the wire's other
   * properties; the new short link is in the same location as that end's component.
   */
  const insertFuse = (w: Wire, at: 'from' | 'to', why: string) => {
    const end = w[at];
    const endNode = d.nodes.find((n) => n.id === end.node)!;
    const far = d.nodes.find((n) => n.id === w[at === 'from' ? 'to' : 'from'].node);
    const fuse = makeNode('fuse', uid('n'), `Fuse for ${far?.label ?? 'circuit'}`, { zone: endNode.zone, data: {} });
    const p = endNode.pos ?? { x: 0, y: 0 };
    const q = far?.pos ?? { x: p.x + 200, y: p.y };
    fuse.pos = { x: Math.round((p.x + (q.x - p.x) * 0.35) / 10) * 10, y: Math.round((p.y + (q.y - p.y) * 0.35) / 10) * 10 };
    d.nodes.push(fuse);
    fresh.add(fuse.id);
    if (only) only.add(fuse.id);
    const linkFt = endNode.type === 'battery' ? BATTERY_FUSE_DRAFT_FT : 1;
    const link: Wire = { ...structuredClone(w), id: uid('w'), lengthFt: linkFt, lengthEstimated: true };
    delete link.vdropPct;
    link[at === 'from' ? 'from' : 'to'] = end;
    link[at === 'from' ? 'to' : 'from'] = { node: fuse.id, term: 'in' } as WireEnd;
    w[at] = { node: fuse.id, term: 'out' };
    w.lengthFt = Math.max(0.5, Math.round((w.lengthFt - linkFt) * 10) / 10);
    delete w.vdropPct;
    d.wires.push(link);
    res.counts.fusesAdded++;
    res.changes.push(`Added a fuse ${why}.`);
  };

  // ---- 1. missing protection
  // a. a battery positive cable to anything but a fuse or breaker
  let g = buildGraph(d);
  for (const bat of d.nodes.filter((n) => n.type === 'battery' && inScope(n.id))) {
    for (const w of [...(g.at.get(key(bat.id, 'pos')) ?? [])]) {
      if (w.kind !== 'pos' || !wireInScope(w)) continue;
      const at = w.from.node === bat.id ? 'from' : 'to';
      const o = g.node.get(w[at === 'from' ? 'to' : 'from'].node)!;
      // two batteries joined in one bank: a link, not a feed (the check is to learn this, T28)
      if (NODE_DEFS[o.type].protective || o.type === 'battery') continue;
      insertFuse(w, at, `at ${name(bat)}, on its cable to ${name(o)}`);
    }
  }
  // b. every load and charging source gets its own fuse where its feed meets a bus
  g = buildGraph(d);
  for (const n of d.nodes.filter((x) => inScope(x.id))) {
    const terms = n.type === 'load' ? ['pos'] : (SOURCE_TERMS[n.type] ?? []).filter((t) => n.terminals.some((x) => x.id === t));
    for (const t of terms) {
      const b = branchEnd(g, n, t);
      if (!b || !wireInScope(b.w)) continue;
      const far = g.node.get(b.w[b.at].node);
      insertFuse(b.w, b.at, n.type === 'load' ? `for ${name(n)}, where its feed meets ${name(far)}` : `on ${name(n)}'s output, where it meets ${name(far)}`);
      g = buildGraph(d);
    }
  }
  // c. a charging source that still reaches a battery with no fuse: fuse its cable at the far end
  g = buildGraph(d);
  for (const n of d.nodes.filter((x) => inScope(x.id))) {
    for (const t of SOURCE_TERMS[n.type] ?? []) {
      if (!n.terminals.some((x) => x.id === t)) continue;
      const unprotected = walk(g, { node: n.id, term: t }, ['pos']).some((r) => r.node.type === 'battery' && !r.protectedPath);
      if (!unprotected) continue;
      const w = (g.at.get(key(n.id, t)) ?? []).find((x) => x.kind === 'pos' && wireInScope(x));
      if (!w) continue;
      const farEnd = w.from.node === n.id && w.from.term === t ? 'to' : 'from';
      const far = g.node.get(w[farEnd].node);
      if (far && NODE_DEFS[far.type].protective) continue; // e.g. an unrated panel position: rated below
      insertFuse(w, farEnd, `on ${name(n)}'s output, at the ${name(far)} end`);
      g = buildGraph(d);
    }
  }
  // d. a load that still has no fuse or breaker between it and the battery, or hangs on an unrated
  //    panel or fuse-block position
  g = buildGraph(d);
  const ratePositions: { n: DNode; term: string }[] = [];
  for (const n of d.nodes.filter((x) => x.type === 'load' && inScope(x.id))) {
    const toBat = walk(g, { node: n.id, term: 'pos' }, ['pos']).filter((r) => r.node.type === 'battery');
    if (!toBat.some((r) => !r.protectedPath)) continue;
    const w = (g.at.get(key(n.id, 'pos')) ?? []).find((x) => x.kind === 'pos' && wireInScope(x));
    if (!w) continue;
    const farEnd = w.from.node === n.id ? 'to' : 'from';
    const far = g.node.get(w[farEnd].node)!;
    if (far.type === 'dc-panel' || far.type === 'fuse-block') {
      // a position on a panel or fuse block: its rating is the protection
      if (w[farEnd].term !== 'in') ratePositions.push({ n: far, term: w[farEnd].term });
      continue;
    }
    insertFuse(w, farEnd, `for ${name(n)}, at the ${name(far)} end of its feed`);
    g = buildGraph(d);
  }
  // AC loads with no breaker need an AC panel position; there is no inline AC breaker to add.
  for (const n of d.nodes.filter((x) => x.type === 'ac-load' && inScope(x.id))) {
    const w = (g.at.get(key(n.id, 'l')) ?? []).find((x) => x.kind === 'ac');
    const far = w ? g.node.get(w.from.node === n.id ? w.to.node : w.from.node) : undefined;
    if (far?.type === 'ac-panel' && w) {
      const term = w.from.node === n.id ? w.to.term : w.from.term;
      if (term !== 'in') ratePositions.push({ n: far, term });
    }
  }

  // ---- 2. ratings
  g = buildGraph(d);
  const amps = estimateCurrents(d, acVolts);
  const current = (w: Wire) => w.amps ?? amps.get(w.id);
  const atTerm = (n: DNode, term: string) => (g.at.get(key(n.id, term)) ?? []).filter((w) => w.kind === 'pos' || w.kind === 'ac');
  const sumAt = (n: DNode, term: string) => {
    const ws = atTerm(n, term);
    if (!ws.length) return undefined;
    let total = 0;
    for (const w of ws) {
      const a = current(w);
      if (a === undefined) return undefined;
      total += a;
    }
    return total;
  };
  const batteryAt = (n: DNode) => n.terminals.flatMap((t) => atTerm(n, t.id)).map((w) => g.node.get(w.from.node === n.id ? w.to.node : w.from.node)).find((o) => o?.type === 'battery');
  /** A fuse or breaker between a solar array and its controller (it reaches a panel and no battery). */
  const onSolarSide = (n: DNode) => {
    const reach = ['in', 'out'].flatMap((t) => walk(g, { node: n.id, term: t }, ['pos'], { stopAt: CHARGE_LINKS }));
    return reach.some((r) => r.node.type === 'solar-panel') && !reach.some((r) => r.node.type === 'battery');
  };
  /**
   * The starter current a fuse carries while cranking: when a battery is on one side of it and an
   * engine's starter on the other. Not through a charging relay or isolator, which carry charge only.
   */
  const starterThrough = (n: DNode): number => {
    const sides = ['in', 'out'].map((t) => walk(g, { node: n.id, term: t }, ['pos'], { stopAt: CHARGE_LINKS }));
    let most = 0;
    for (const [a, b] of [[sides[0], sides[1]], [sides[1], sides[0]]]) {
      if (!a.some((r) => r.node.type === 'battery')) continue;
      for (const r of b) if (r.node.type === 'engine' && r.term === 'pos') most = Math.max(most, Number(r.node.data.amps ?? 0));
    }
    return most;
  };

  /** Rate a device, or one position of a panel. Returns nothing; records the change. */
  const rate = (n: DNode, through: number | undefined, kind: ProtectionKind, label: string, get: () => number | undefined, set: (r: number) => void) => {
    if (through === undefined || through <= 0) {
      if (get() === undefined) res.notes.push(`${label}: no rating set, because the current through it is not known. Enter the current of what it feeds, then size again.`);
      return;
    }
    // A solar array's own circuit is rated for 1.25 × its current before the usual 1.25 ×, as the
    // ideal design does (US NEC 690.8: panels can briefly give more than their rated current).
    const pv = (n.type === 'fuse' || n.type === 'breaker') && onSolarSide(n);
    let need = protectionFor(pv ? through * PV_CURRENT_FACTOR : through, kind);
    // A starter draws several times its running current while cranking; the ideal design fuses a
    // starter cable at twice the starter's current, so the fuse does not blow on every start.
    const starter = n.type === 'fuse' ? starterThrough(n) : 0;
    if (starter > 0) need = nextStandard(Math.max(protectionNeeded(through), 2 * starter), PROTECTION_SIZES['feeder-fuse']);
    if (need === undefined) {
      res.notes.push(`${label}: about ${Math.round(through)} A is more than the largest standard ${kind === 'breaker-ac' || kind === 'breaker-dc' ? 'breaker' : 'fuse'}. Split the circuit or use a larger class of device.`);
      return;
    }
    const was = get();
    if (was === undefined) {
      set(need);
      res.counts.rated++;
      res.changes.push(`${label}: set to ${need} A (about ${Math.round(through)} A through it).`);
    } else if (was < through) {
      set(need);
      res.counts.raised++;
      res.changes.push(`${label}: raised from ${was} A to ${need} A; about ${Math.round(through)} A through it would blow ${was} A.`);
    }
  };
  for (const n of d.nodes.filter((x) => (x.type === 'fuse' || x.type === 'breaker') && inScope(x.id))) {
    const through = Math.max(sumAt(n, 'in') ?? -1, sumAt(n, 'out') ?? -1);
    const bat = batteryAt(n);
    const kind: ProtectionKind = n.type === 'breaker' ? 'breaker-dc' : bat ? 'feeder-fuse' : 'fuse';
    const label = `${name(n)}${fresh.has(n.id) ? ' (new)' : ''}`;
    rate(n, through < 0 ? undefined : through, kind, label, () => (typeof n.data.rating === 'number' ? n.data.rating : undefined), (r) => (n.data.rating = r));
    const r = n.data.rating;
    if (n.type === 'fuse' && typeof r === 'number') {
      const cls = fuseClassFor(r, { atBattery: !!bat, lithium: bat?.data.chemistry === 'lifepo4' });
      if (!n.data.fuseClass) n.data.fuseClass = cls;
      n.sublabel = `${r} A ${n.data.fuseClass}`;
    } else if (typeof r === 'number') n.sublabel = `${r} A`;
  }
  // a shore main breaker is rated for its inlet
  for (const n of d.nodes.filter((x) => x.type === 'elci' && inScope(x.id) && typeof x.data.rating !== 'number')) {
    const inlet = atTerm(n, 'in').map((w) => g.node.get(w.from.node === n.id ? w.to.node : w.from.node)).find((o) => o?.type === 'shore-inlet' || o?.type === 'generator');
    const r = Number(inlet?.data.amps ?? 0);
    if (r > 0) {
      n.data.rating = r;
      res.counts.rated++;
      res.changes.push(`${name(n)}: set to ${r} A, the rating of ${name(inlet)}.`);
    } else res.notes.push(`${name(n)}: no rating set; connect it to the shore inlet and enter the inlet's rating.`);
  }
  const seen = new Set<string>();
  for (const { n, term } of ratePositions) {
    if (seen.has(key(n.id, term))) continue;
    seen.add(key(n.id, term));
    const t = n.terminals.find((x) => x.id === term);
    if (!t) continue;
    const kind: ProtectionKind = n.type === 'ac-panel' ? 'breaker-ac' : n.type === 'dc-panel' ? 'breaker-dc' : 'fuse';
    rate(n, sumAt(n, term), kind, `${name(n)} position ${t.label ?? t.id}`, () => t.rating, (r) => {
      t.rating = r;
      t.label = `${r} A`;
    });
  }

  // ---- 3. wire sizes
  g = buildGraph(d);
  const nodeOf = (id: string) => g.node.get(id);
  for (const w of d.wires) {
    if (!(w.kind === 'pos' || w.kind === 'neg' || w.kind === 'ac') || !wireInScope(w)) continue;
    const a = current(w);
    const ends = [nodeOf(w.from.node), nodeOf(w.to.node)];
    const names = `${name(ends[0])} → ${name(ends[1])}`;
    // A negative has no fuse of its own; it is sized like the positive of the same component, so the
    // return can carry whatever that positive's fuse lets through.
    const pairedFuses = () =>
      [w.from, w.to].flatMap((e) => {
        const n = nodeOf(e.node);
        const pos = n ? NEG_PAIR[n.type]?.[e.term] ?? [] : [];
        return pos.flatMap((t) => (g.at.get(key(e.node, t)) ?? []).filter((x) => x.kind === 'pos').flatMap((x) => protectionOf(x, nodeOf).map((p) => p.rating)));
      });
    const fuse = Math.max(0, ...(w.kind === 'neg' ? pairedFuses() : protectionOf(w, nodeOf).map((p) => p.rating)));
    // the small ground lead of a charging relay or isolator carries next to nothing: smallest size
    const controlLead = [w.from, w.to].some((e) => e.term === 'neg' && CHARGE_LINKS.has(nodeOf(e.node)?.type ?? ''));
    if ((a === undefined || a <= 0) && !fuse && !controlLead) {
      if (!w.gauge) res.notes.push(`${names}: not sized, because neither its current nor a fuse on it is known.`);
      continue;
    }
    const ac = w.kind === 'ac';
    let runs = runsOf(w);
    const volts = circuitVolts(g, w, d.systemVoltage, acVolts);
    const critical = ends.some((n) => n?.data.critical === true);
    const limit = w.vdropLimit ?? (critical ? VDROP.critical : VDROP.nonCritical);
    const bundled = ac ? 0 : Math.max(0, Math.floor(w.bundledWith ?? 0));
    const carry = Math.max(a ?? 0, fuse);
    const fit = (k: number) => {
      const s = sizeConductor({ designAmps: (a ?? 0) / k, protectAmps: carry / k, oneWayFt: w.lengthFt, volts, vdropLimit: limit, inEngineSpace: w.inEngineSpace, ac });
      let i = gaugeIndex(s.gauge);
      // sizeConductor rates a cable on its own; one in a bundle carries less (DC only)
      while (bundled && i < GAUGES.length - 1 && ampacity(GAUGES[i].awg, w.inEngineSpace, false, bundled) < carry / k) i++;
      const ok = !s.overflow && ampacity(GAUGES[i].awg, w.inEngineSpace, ac, bundled) >= carry / k - 1e-9;
      return { s, i, ok };
    };
    let { s, i, ok } = fit(runs);
    // A DC cable beyond the largest size is run as two or three in parallel, as the ideal design does.
    for (let k = runs + 1; !ok && !ac && runs === 1 && !w.gauge && k <= 3; k++) {
      const f = fit(k);
      if (f.ok) {
        ({ s, i, ok } = f);
        runs = k;
      }
    }
    if (!ok) {
      res.notes.push(`${names}: even ${fmtSize(GAUGES[GAUGES.length - 1].awg, units)} is not enough for ~${Math.round(carry)} A over ${fmtLen(w.lengthFt, units)}. Run parallel cables, shorten the run or split the circuit.`);
      continue;
    }
    const target = GAUGES[i].awg;
    if (w.gauge && gaugeIndex(w.gauge) >= i) continue; // big enough already: never make a wire smaller
    const why =
      bundled && i > gaugeIndex(s.gauge)
        ? `bundled with ${bundled} other wire${bundled === 1 ? '' : 's'}`
        : s.limitedBy === 'vdrop'
          ? `${limit}% voltage drop over ${fmtLen(w.lengthFt, units)}`
          : s.limitedBy === 'minimum'
            ? 'the smallest size used outside a panel'
            : fuse >= (a ?? 0)
              ? `its ${fuse} A ${ends.some((n) => n?.type === 'breaker' || n?.type === 'dc-panel' || n?.type === 'ac-panel') ? 'breaker' : 'fuse'}`
              : `~${Math.round(a ?? 0)} A`;
    const was = w.gauge;
    w.gauge = target;
    delete w.vdropPct; // the stored figure was for the old size
    if (runs > 1) {
      w.cable = `${runs}× ${target}`;
      // the check works the drop out for one conductor carrying it all; record it per conductor
      if (a) w.vdropPct = Math.round(s.vdropPct * 100) / 100;
    } else delete w.cable;
    if (was) {
      res.counts.upsized++;
      res.changes.push(`${names}: ${fmtSize(was, units)} → ${fmtSize(target, units)} (${why}).`);
    } else {
      res.counts.sized++;
      res.changes.push(`${names}: ${fmtSize(target, units)} (${why}).`);
    }
  }

  // ---- what the check still says (within the focus, when there is one)
  const W = new Map(d.wires.map((w) => [w.id, w]));
  const touches = (f: Finding) => {
    if (!only) return true;
    if (!f.nodes?.length && !f.wires?.length) return true;
    return (f.nodes ?? []).some((id) => only.has(id)) || (f.wires ?? []).some((id) => W.has(id) && wireInScope(W.get(id)!));
  };
  // "N wires have no size" counts the whole drawing; in a focus, count only the wires in it
  res.remaining = audit(d, { acVolts, units })
    .filter((f) => f.severity !== 'info' && touches(f))
    .flatMap((f) => {
      if (f.rule !== 'unsized-wire' || !only) return [f];
      const mine = (f.wires ?? []).filter((id) => W.has(id) && wireInScope(W.get(id)!));
      return mine.length ? [{ ...f, wires: mine, message: `${mine.length} wire${mine.length === 1 ? ' has' : 's have'} no size set, so ${mine.length === 1 ? 'it is' : 'they are'} not checked.` }] : [];
    });
  return res;
}
