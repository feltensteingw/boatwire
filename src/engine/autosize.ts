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
import { audit, CHARGE_LINKS, circuitVolts, estimateCurrents, feedProtection, INLINE, otherEnd as other, upstreamEnds, type End } from './audit';
import { ampacity, fuseClassFor, gaugeIndex, nextStandard, PROTECTION_SIZES, protectionFor, protectionNeeded, sizeConductor, type ProtectionKind } from './calc';
import { BATTERY_FUSE_MAX_IN } from '../model/standards';
import { BATTERY_FUSE_DRAFT_FT } from './existing';
import { buildGraph, key, passThrough, SOURCE_TERMS, walk } from './graph';

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
  battery: { neg: ['pos'] },
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

/** Parts whose output positions carry their own rating (the input does not protect anything). */
const PANELS = new Set(['dc-panel', 'fuse-block', 'ac-panel']);

/** Stands for a fuse that is there but not rated yet. */
const UNRATED = 1e9;

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
    // mounted at the battery or bus, within the 7 in a battery fuse must be (the owner is asked to measure it)
    const linkFt = endNode.type === 'battery' || endNode.type === 'bus-pos' ? BATTERY_FUSE_DRAFT_FT : 1;
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
  // a. a battery positive cable to anything but a fuse or breaker (a panel's input protects nothing)
  let g = buildGraph(d);
  for (const bat of d.nodes.filter((n) => n.type === 'battery' && inScope(n.id))) {
    for (const w of [...(g.at.get(key(bat.id, 'pos')) ?? [])]) {
      if (w.kind !== 'pos' || !wireInScope(w)) continue;
      const at = w.from.node === bat.id ? 'from' : 'to';
      const o = g.node.get(w[at === 'from' ? 'to' : 'from'].node)!;
      // two batteries joined in one bank: a link, not a feed (the check is to learn this, T28)
      if (o.type === 'fuse' || o.type === 'breaker' || o.type === 'elci' || o.type === 'battery') continue;
      insertFuse(w, at, `at ${name(bat)}, on its cable to ${name(o)}`);
    }
  }
  // b. every branch gets its own fuse where it leaves a bus: a load, a charging source, a feed to a
  //    panel, fuse block, sub-bus, charging relay or DC-DC charger. A branch protected only by a big
  //    fuse further back is not protected for its own (smaller) wire. Not a starter cable, which
  //    needs no fuse of its own (it is still fused at the battery, above).
  g = buildGraph(d);
  let up = upstreamEnds(g, d);
  const ratePositions: { n: DNode; term: string }[] = [];
  /** What a wire reaches beyond one of its ends (not back through itself). */
  const beyond = (w: Wire, end: End) => {
    const e = w[end];
    const n = g.node.get(e.node)!;
    if (!NODE_DEFS[n.type].conducts) return [{ node: n, term: e.term }];
    if (CHARGE_LINKS.has(n.type)) return [{ node: n, term: e.term }];
    const opts = { exclude: w.id, stopAt: CHARGE_LINKS };
    return walk(g, e, ['pos'], opts).concat(passThrough(n, e.term).flatMap((t) => walk(g, { node: n.id, term: t }, ['pos'], opts)));
  };
  /**
   * A cranking circuit: beyond this end there are only engine starters and batteries (a starter
   * cable, or an emergency parallel switch between two start batteries). Marine practice exempts
   * cranking conductors from a fuse of their own, and so does the ideal design.
   */
  const cranking = (w: Wire, end: End) => {
    if (w.notes?.includes('starter-exempt')) return true;
    const reach = beyond(w, end);
    return reach.some((r) => r.node.type === 'engine' && r.term === 'pos') && reach.every((r) => (r.node.type === 'engine' && r.term === 'pos') || r.node.type === 'battery');
  };
  /**
   * Is this wire a cranking circuit? Either what it feeds is only starters and batteries (a starter
   * cable), or it is one side of an emergency parallel: a link through a switch, with a battery at
   * each end and one end a start side. An ordinary branch off a start bus (an alternator, a load, a
   * charging relay) has no battery beyond its far end, so it is not one; nor is a permanent tie wired
   * straight from bus to bus, which carries load current all the time.
   */
  const crankingLink = (w: Wire, at: End) => {
    if (cranking(w, other(at))) return true;
    const viaSwitch = [w.from, w.to].some((e) => g.node.get(e.node)?.type === 'switch');
    return viaSwitch && beyond(w, other(at)).some((r) => r.node.type === 'battery') && cranking(w, at);
  };
  const isDevice = (n: DNode) => n.type === 'fuse' || n.type === 'breaker';
  /**
   * What can feed a wire from beyond one of its ends: for each battery there, the smallest fuse or
   * breaker on the way to it. A battery reached with none on the way makes the wire unprotected from
   * that side.
   */
  function backFeed(w: Wire, end: End): { unprotected: boolean; ratings: number[] } {
    const out = { unprotected: false, ratings: [] as number[] };
    const start = g.node.get(w[end].node);
    if (!start) return out;
    const best = new Map<string, number>([[start.id, Infinity]]);
    const stack: [DNode, number][] = [[start, Infinity]];
    while (stack.length) {
      const [n, lim0] = stack.pop()!;
      let lim = lim0;
      if (n.type === 'battery') {
        if (lim === Infinity) out.unprotected = true;
        else out.ratings.push(lim);
        continue;
      }
      // a fuse not rated yet (one this run has just added) still protects; its size comes later
      if (isDevice(n)) lim = Math.min(lim, typeof n.data.rating === 'number' ? n.data.rating : UNRATED);
      if (n.id !== start.id && (!NODE_DEFS[n.type].conducts || CHARGE_LINKS.has(n.type))) continue;
      for (const t of n.terminals) {
        for (const x of g.at.get(key(n.id, t.id)) ?? []) {
          if (x.kind !== 'pos' || x.id === w.id) continue;
          const o = g.node.get(x.from.node === n.id ? x.to.node : x.from.node);
          if (!o) continue;
          // revisit only on a less-protected path, so the worst case wins
          if ((best.get(o.id) ?? -1) >= lim) continue;
          best.set(o.id, lim);
          stack.push([o, lim]);
        }
      }
    }
    return out;
  }
  /** A bus or other part where several feeds meet, so a wire leaving it needs its own fuse there. */
  const junction = (n: DNode, term: string) =>
    NODE_DEFS[n.type].conducts && !isDevice(n) && !PANELS.has(n.type) && !CHARGE_LINKS.has(n.type) && !(INLINE.has(n.type) && (g.at.get(key(n.id, term)) ?? []).filter((x) => x.kind === 'pos').length === 1);
  const branches: { w: Wire; at: End; why: string }[] = [];
  for (const w of d.wires) {
    const at = up.get(w.id);
    if (!at || !wireInScope(w)) continue;
    const U = g.node.get(w[at].node)!;
    const D = g.node.get(w[other(at)].node)!;
    if (U.type === 'battery' || D.type === 'battery') continue; // a battery cable: handled above
    if (PANELS.has(U.type)) {
      if (w[at].term !== 'in') ratePositions.push({ n: U, term: w[at].term });
      continue;
    }
    // The end it is fed from. A fuse already at the far end counts only on a short link (a fuse
    // mounted at the bus): on a longer run the run itself is not protected for its own size.
    const shortToDevice = isDevice(D) && w.lengthFt * 12 <= BATTERY_FUSE_MAX_IN;
    // A cranking circuit is one from both ends: no fuse of its own at either (as in the ideal design).
    const crank = crankingLink(w, at);
    if (junction(U, w[at].term) && !shortToDevice && !crank) {
      const why = isDevice(D) ? `where the run to ${name(D)} leaves ${name(U)} (a fuse at the far end of a run does not protect the run)` : `where ${name(D)}${D.type === 'load' ? '' : "'s feed"} leaves ${name(U)}`;
      branches.push({ w, at, why });
    }
    // The other end too, when a battery can feed the wire from there with no fuse on the way (a tie
    // between two buses). Through a fuse it is covered by that fuse instead: see backFeed below.
    if (junction(D, w[other(at)].term) && !crank && backFeed(w, other(at)).unprotected) {
      branches.push({ w, at: other(at), why: `at the ${name(D)} end of the tie to ${name(U)}, which a battery feeds from both ends` });
    }
  }
  for (const b of branches) insertFuse(b.w, b.at, b.why);
  // c. a charging source that still reaches a battery with no fuse (it is not wired to any battery
  //    through a bus, e.g. an alternator straight into an isolator): fuse its cable at the far end
  g = buildGraph(d);
  for (const n of d.nodes.filter((x) => inScope(x.id))) {
    for (const t of SOURCE_TERMS[n.type] ?? []) {
      if (!n.terminals.some((x) => x.id === t)) continue;
      const unprotected = walk(g, { node: n.id, term: t }, ['pos']).some((r) => r.node.type === 'battery' && !r.protectedPath);
      if (!unprotected) continue;
      const w = (g.at.get(key(n.id, t)) ?? []).find((x) => x.kind === 'pos' && wireInScope(x));
      if (!w) continue;
      const farEnd: End = w.from.node === n.id && w.from.term === t ? 'to' : 'from';
      const far = g.node.get(w[farEnd].node);
      if (far && NODE_DEFS[far.type].protective) continue;
      insertFuse(w, farEnd, `on ${name(n)}'s output, at the ${name(far)} end`);
      g = buildGraph(d);
    }
  }
  // d. every rated position on a panel or fuse block that something hangs on is checked too
  g = buildGraph(d);
  up = upstreamEnds(g, d);
  for (const n of d.nodes.filter((x) => PANELS.has(x.type) && inScope(x.id))) {
    for (const t of n.terminals) if (t.id !== 'in' && (g.at.get(key(n.id, t.id)) ?? []).length) ratePositions.push({ n, term: t.id });
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

  /** Devices (and panel positions, "id|term") whose rating this run set or raised. */
  const changed = new Set<string>();
  /** Rate a device, or one position of a panel. Returns nothing; records the change. */
  const rate = (n: DNode, through: number | undefined, kind: ProtectionKind, label: string, get: () => number | undefined, set: (r: number) => void, id = n.id) => {
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
      changed.add(id);
      res.counts.rated++;
      res.changes.push(`${label}: set to ${need} A (about ${Math.round(through)} A through it).`);
    } else if (was < through) {
      set(need);
      changed.add(id);
      res.counts.raised++;
      res.changes.push(`${label}: raised from ${was} A to ${need} A; about ${Math.round(through)} A through it would blow ${was} A.`);
    }
  };
  for (const n of d.nodes.filter((x) => (x.type === 'fuse' || x.type === 'breaker') && inScope(x.id))) {
    const through = Math.max(sumAt(n, 'in') ?? -1, sumAt(n, 'out') ?? -1);
    const bat = batteryAt(n);
    // fuse sizes go on up to the largest Class T (an 800 A inverter fuse), as the ideal design's do
    const kind: ProtectionKind = n.type === 'breaker' ? 'breaker-dc' : 'feeder-fuse';
    const label = `${name(n)}${fresh.has(n.id) ? ' (new)' : ''}`;
    rate(n, through < 0 ? undefined : through, kind, label, () => (typeof n.data.rating === 'number' ? n.data.rating : undefined), (r) => (n.data.rating = r));
    const r = n.data.rating;
    if (n.type === 'fuse' && typeof r === 'number') {
      const cls = fuseClassFor(r, { atBattery: !!bat, lithium: bat?.data.chemistry === 'lifepo4', mainFeeder: true });
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
      changed.add(n.id);
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
    rate(
      n,
      sumAt(n, term),
      kind,
      `${name(n)} position ${t.label ?? t.id}`,
      () => t.rating,
      (r) => {
        t.rating = r;
        t.label = `${r} A`;
      },
      key(n.id, term),
    );
  }

  // ---- 3. wire sizes
  g = buildGraph(d);
  up = upstreamEnds(g, d);
  const nodeOf = (id: string) => g.node.get(id);
  /**
   * The fuses and breakers a positive wire is held to: one on either end of it (as the check sees
   * it), or the one further back when the wire leaves a switch or contactor that only passes the feed
   * through. Each with the id the ratings above use for it.
   */
  const cover = (w: Wire): { rating: number; id: string }[] =>
    feedProtection(w, g, up).map((p) => ({ rating: p.rating, id: PANELS.has(p.n.type) ? key(p.n.id, p.wire.from.node === p.n.id ? p.wire.from.term : p.wire.to.term) : p.n.id }));
  /**
   * A battery beyond the far end of a wire can push fault current into it through its own fuse: the
   * wire must carry that fuse's rating as well (a tie between two buses, a second bank on one bus).
   */
  const feedFromBeyond = (w: Wire): { rating: number; id: string }[] => {
    const at = up.get(w.id);
    if (!at || w.kind !== 'pos' || crankingLink(w, at)) return [];
    const U = nodeOf(w[at].node)!;
    const D = nodeOf(w[other(at)].node)!;
    // The end it is fed from is already covered by cover() when it is a fuse, a breaker, a panel
    // position or a switch; a bare bus there (the fuse of a tie went in at the other end) is not.
    // Nor is a bus with its fuse mounted on a short link at the far end: that link is accepted as is.
    const shortToDevice = isDevice(D) && w.lengthFt * 12 <= BATTERY_FUSE_MAX_IN;
    const ends: End[] = [other(at)];
    if (junction(U, w[at].term) && !shortToDevice) ends.push(at);
    return ends
      .flatMap((e) => backFeed(w, e).ratings)
      .filter((r) => r < UNRATED)
      .map((r) => ({ rating: r, id: '' }));
  };
  // A negative has no fuse of its own; it is sized like the positive of the same component, so the
  // return can carry whatever that positive's fuse lets through.
  const pairedCover = (w: Wire) =>
    [w.from, w.to].flatMap((e) => {
      const n = nodeOf(e.node);
      if (n?.type === 'shunt') {
        // the main negative through a battery monitor shunt carries what the battery's positive does
        const bats = (g.at.get(key(n.id, 'bat')) ?? []).map((x) => nodeOf(x.from.node === n.id ? x.to.node : x.from.node)).filter((b): b is DNode => b?.type === 'battery');
        return bats.flatMap((b) => (g.at.get(key(b.id, 'pos')) ?? []).filter((x) => x.kind === 'pos').flatMap((x) => cover(x)));
      }
      const pos = n ? NEG_PAIR[n.type]?.[e.term] ?? [] : [];
      return pos.flatMap((t) => (g.at.get(key(e.node, t)) ?? []).filter((x) => x.kind === 'pos').flatMap((x) => cover(x)));
    });
  for (const w of d.wires) {
    if (!(w.kind === 'pos' || w.kind === 'neg' || w.kind === 'ac')) continue;
    const covers = w.kind === 'neg' ? pairedCover(w) : cover(w).concat(feedFromBeyond(w));
    // In a focus, a wire outside it is still resized when a fuse it hangs on was raised or set here.
    if (!wireInScope(w) && !covers.some((c) => changed.has(c.id))) continue;
    const a = current(w);
    const ends = [nodeOf(w.from.node), nodeOf(w.to.node)];
    const names = `${name(ends[0])} → ${name(ends[1])}`;
    const fuse = Math.max(0, ...covers.map((c) => c.rating));
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
