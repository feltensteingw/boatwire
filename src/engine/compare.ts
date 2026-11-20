// Connection-by-connection comparison of an existing drawing with the ideal design.
//
// Components are matched first (by equipment, by role, by name, then by what they are wired to),
// then every wire of the ideal design is looked for on the drawing between the same two
// components. What differs becomes upgrade-plan lines and a set of wires to mark on the drawing.
//
// A difference that only changes the layout (another stud on the same bus, another breaker
// position on the same panel) is not reported. A different route that the design check accepts
// is an "improvement" at most: real problems are reported by the design check (audit.ts).

import { NODE_DEFS } from '../model/nodeDefs';
import type { Design, DNode, Wire, WireEnd } from '../model/types';
import { cableLabel, fmtLen, fmtSize, type Units } from '../model/units';
import { GAUGES } from '../model/standards';
import { estimateCurrents, protectionOf } from './audit';
import { ampacity, gaugeIndex, gaugeSpec } from './calc';

export interface Change {
  priority: 'safety' | 'recommended' | 'improvement';
  title: string;
  detail?: string;
  rule?: string;
  /** Parts the change needs, where they are known: price-list entry and how many of its units. Used for the cost estimate. */
  parts?: [key: string, qty: number][];
  /** Wires of the existing drawing this change is about. */
  wires?: string[];
}

export interface IdealDiff {
  /** Plan lines for the differences in connections, wire sizes and fuse or breaker ratings. */
  changes: Change[];
  /** Existing-drawing wire id → why it differs from the ideal design, for marking on the drawing. */
  wires: Map<string, string>;
  /** Ideal node id → the existing node it was matched to. */
  matched: Map<string, string>;
}

/** Parts a wire can pass through on its way between two components: followed when tracing a route. */
const SERIES: DNode['type'][] = ['fuse', 'breaker', 'switch', 'contactor', 'shunt'];
const MAX_HOPS = 3;

/** Two-ended parts that work the same either way round: their two power terminals are interchangeable. */
const EITHER_WAY: Partial<Record<DNode['type'], [string, string]>> = {
  fuse: ['in', 'out'],
  breaker: ['in', 'out'],
  switch: ['in', 'out'],
  contactor: ['in', 'out'],
  elci: ['in', 'out'],
  'bilge-switch': ['in', 'out'],
  'galvanic-isolator': ['a', 'b'],
  acr: ['a', 'b'],
};

const isLoad = (n: DNode) => n.type === 'load' || n.type === 'ac-load' || n.type === 'engine';

/**
 * Are two terminals of one component interchangeable? The studs of a bus bar are, and so are the
 * positions of a panel or fuse block (their ratings are compared separately). Fixed terminals
 * (a battery's + and −, an isolator's B1 and B2) are not, except the two ends of a part that works
 * either way round (a fuse, a switch, a relay between two banks).
 */
export function sameTerminal(n: DNode, a: string, b: string): boolean {
  if (a === b) return true;
  const pair = EITHER_WAY[n.type];
  if (pair && pair.includes(a) && pair.includes(b)) return true;
  const def = NODE_DEFS[n.type];
  if (!def.growable) return false;
  const fixed = new Set(def.terminals.map((t) => t[0]));
  return !fixed.has(a) && !fixed.has(b);
}

/** Match components of the ideal design to components of the existing drawing. Ideal id → existing id. */
export function matchNodes(existing: Design, ideal: Design): Map<string, string> {
  const m = new Map<string, string>();
  const taken = new Set<string>();
  const eNodes = existing.nodes.filter((n) => n.type !== 'note');
  const iNodes = ideal.nodes.filter((n) => n.type !== 'note');
  const pair = (i: DNode, e: DNode) => {
    m.set(i.id, e.id);
    taken.add(e.id);
  };
  const free = (e: DNode) => !taken.has(e.id);
  const open = () => iNodes.filter((i) => !m.has(i.id));

  // 1. The same item of the equipment list, drawn as the same kind of component.
  for (const i of iNodes) {
    if (!i.equipmentId) continue;
    const e = eNodes.find((x) => free(x) && x.equipmentId === i.equipmentId && x.type === i.type);
    if (e) pair(i, e);
  }
  // 2. The same part of the design (a drawing copied from the ideal design keeps each part's role).
  for (const i of open()) {
    if (!i.role) continue;
    const e = eNodes.find((x) => free(x) && x.role === i.role && x.type === i.type);
    if (e) pair(i, e);
  }
  // 3. The same name, where only one component of that kind has it on each side.
  for (const i of open()) {
    const sameI = iNodes.filter((x) => x.type === i.type && x.label === i.label);
    const sameE = eNodes.filter((x) => free(x) && x.type === i.type && x.label === i.label);
    if (sameI.length === 1 && sameE.length === 1) pair(i, sameE[0]);
  }
  // 4. Wired to a matched component in the same way, then 5. the only one of its kind left on each side.
  const wiresAt = (d: Design, id: string) => d.wires.filter((w) => w.from.node === id || w.to.node === id);
  const far = (w: Wire, id: string): [WireEnd, WireEnd] => (w.from.node === id ? [w.from, w.to] : [w.to, w.from]);
  const eById = new Map(eNodes.map((n) => [n.id, n]));
  const iById = new Map(iNodes.map((n) => [n.id, n]));
  const propagate = () => {
    let grew = true;
    while (grew) {
      grew = false;
      for (const [iid, eid] of [...m]) {
        const me = eById.get(eid)!;
        for (const iw of wiresAt(ideal, iid)) {
          const [near, other] = far(iw, iid);
          const x = iById.get(other.node);
          if (!x || m.has(x.id)) continue;
          const cands = (strict: boolean) =>
            new Set(
              wiresAt(existing, eid)
                .filter((ew) => ew.kind === iw.kind)
                .map((ew) => far(ew, eid))
                .filter(([en]) => !strict || sameTerminal(me, en.term, near.term))
                .map(([, eo]) => eById.get(eo.node))
                .filter((n): n is DNode => !!n && free(n) && n.type === x.type),
            );
          let c = cands(true);
          if (c.size === 0) c = cands(false);
          if (c.size === 1) {
            pair(x, [...c][0]);
            grew = true;
          }
        }
      }
    }
  };
  propagate();
  for (const i of open()) {
    const leftI = open().filter((x) => x.type === i.type);
    const leftE = eNodes.filter((x) => free(x) && x.type === i.type);
    if (leftI.length === 1 && leftE.length === 1) pair(i, leftE[0]);
  }
  propagate();
  return m;
}

/** Cross-section of a wire in circular mils, parallel runs included. */
function copper(w: Wire): number | undefined {
  if (!w.gauge) return undefined;
  const g = gaugeSpec(w.gauge);
  if (!g) return undefined;
  return g.cm * runs(w);
}

/** Number of parallel runs in a wire's cable ("2× 4/0" is 2). */
function runs(w: Wire): number {
  return w.cable?.match(/^(\d+)×/) ? Number(w.cable.split('×')[0]) : 1;
}

export function compareWithIdeal(existing: Design, ideal: Design, units: Units = 'imperial'): IdealDiff {
  const matched = matchNodes(existing, ideal);
  const back = new Map([...matched].map(([i, e]) => [e, i]));
  const EN = new Map(existing.nodes.map((n) => [n.id, n]));
  const IN = new Map(ideal.nodes.map((n) => [n.id, n]));
  const changes: Change[] = [];
  const marks = new Map<string, string>();
  const mark = (ids: string[], why: string) => ids.forEach((id) => !marks.has(id) && marks.set(id, why));
  const used = new Set<string>();

  /** "DC panel 15 A breaker", "House switch (1)", "House busbar". */
  const where = (N: Map<string, DNode>, e: WireEnd) => {
    const n = N.get(e.node);
    if (!n) return '?';
    const t = n.terminals.find((x) => x.id === e.term);
    if (t?.rating) return `${n.label} ${t.rating} A ${n.type === 'fuse-block' ? 'fuse' : 'breaker'}`;
    const def = NODE_DEFS[n.type];
    const named = t?.label && !/^\d+ A/.test(t.label);
    return named && !def.growable && n.terminals.length > 2 ? `${n.label} (${t!.label})` : n.label;
  };
  const circuit = (N: Map<string, DNode>, w: Wire) => {
    const a = N.get(w.from.node);
    const b = N.get(w.to.node);
    const load = [b, a].find((n) => n && isLoad(n));
    return load?.label ?? `${a?.label ?? '?'} → ${b?.label ?? '?'}`;
  };
  /** Wires of a design at a terminal (or an interchangeable one), of one kind. */
  const at = (d: Design, N: Map<string, DNode>, e: WireEnd, kind: Wire['kind']) =>
    d.wires.filter((w) => w.kind === kind && [w.from, w.to].some((x) => x.node === e.node && sameTerminal(N.get(e.node)!, x.term, e.term)));
  const otherEnd = (w: Wire, e: WireEnd): WireEnd => (w.from.node === e.node && (w.to.node !== e.node || w.from.term === e.term) ? w.to : w.from);

  /**
   * Follow a wire from a terminal through parts that are not matched on the other side
   * (an extra fuse, a switch), to where it ends up.
   */
  const trace = (d: Design, N: Map<string, DNode>, start: Wire, from: WireEnd, unmatched: (id: string) => boolean) => {
    const path = [start];
    const via: DNode[] = [];
    let end = otherEnd(start, from);
    for (let hop = 0; hop < MAX_HOPS; hop++) {
      const n = N.get(end.node);
      if (!n || !unmatched(n.id) || !SERIES.includes(n.type)) break;
      const next = d.wires.find((w) => !path.includes(w) && w.kind === start.kind && (w.from.node === n.id || w.to.node === n.id) && !(w.from.node === n.id && w.from.term === end.term) && !(w.to.node === n.id && w.to.term === end.term));
      if (!next) break;
      via.push(n);
      path.push(next);
      end = otherEnd(next, { node: n.id, term: next.from.node === n.id ? next.from.term : next.to.term });
    }
    return { path, via, end };
  };
  const named = (n: DNode) => `${n.label}${n.data.rating ? ` (${n.data.rating} A)` : ''}`;

  // ---- 1. each ideal wire between two matched components: on the drawing, or not
  const missing: Wire[] = [];
  const pairs: [ideal: Wire, existing: Wire, flipped: boolean][] = [];
  for (const iw of ideal.wires) {
    const ea = matched.get(iw.from.node);
    const eb = matched.get(iw.to.node);
    if (!ea || !eb || ea === eb) continue;
    let best: [Wire, boolean] | undefined;
    for (const ew of existing.wires) {
      if (used.has(ew.id) || ew.kind !== iw.kind) continue;
      const straight = ew.from.node === ea && ew.to.node === eb;
      const flipped = ew.from.node === eb && ew.to.node === ea;
      if (!straight && !flipped) continue;
      const [fa, fb] = flipped ? [ew.to, ew.from] : [ew.from, ew.to];
      const exact = sameTerminal(EN.get(ea)!, fa.term, iw.from.term) && sameTerminal(EN.get(eb)!, fb.term, iw.to.term);
      if (!best || exact) best = [ew, flipped];
      if (exact) break;
    }
    if (best) {
      used.add(best[0].id);
      pairs.push([iw, best[0], best[1]]);
    } else missing.push(iw);
  }

  // ---- 2. matched wires: right terminals, size, protection
  const exAmps = estimateCurrents(existing);
  for (const [iw, ew, flipped] of pairs) {
    const ends: [WireEnd, WireEnd][] = flipped ? [[iw.from, ew.to], [iw.to, ew.from]] : [[iw.from, ew.from], [iw.to, ew.to]];
    for (const [ie, ee] of ends) {
      const en = EN.get(ee.node)!;
      if (sameTerminal(en, ee.term, ie.term)) continue;
      const otherI = ie === iw.from ? iw.to : iw.from;
      const term = (id: string) => en.terminals.find((t) => t.id === id)?.label ?? id;
      changes.push({
        priority: 'improvement',
        title: `${en.label}: move the wire to ${IN.get(otherI.node)?.label ?? '?'} from terminal ${term(ee.term)} to terminal ${term(ie.term)}`,
        detail: 'The ideal design uses the other terminal for this wire.',
        rule: 'ideal-routing',
        wires: [ew.id],
      });
      mark([ew.id], 'On a different terminal from the ideal design');
    }
    if (iw.kind !== 'sig' && ew.gauge && iw.gauge) {
      const size = (w: Wire) => (w.cable ? cableLabel(w, units)! : fmtSize(w.gauge, units));
      const current = ew.amps ?? exAmps.get(ew.id) ?? iw.amps ?? 0;
      // The ideal size assumes a cable on its own. A single DC wire drawn as bundled needs the
      // smallest size from the ideal one up that the check accepts in its bundle: one that
      // carries its current and its fuse. If none does, the check's own finding says what to do.
      const bundled = (ew.kind === 'pos' || ew.kind === 'neg') && runs(ew) === 1 && runs(iw) === 1 ? Math.floor(ew.bundledWith ?? 0) : 0;
      if (bundled > 0) {
        const need = Math.max(current, ...protectionOf(ew, (id) => EN.get(id)).map((p) => p.rating));
        const target = GAUGES.slice(gaugeIndex(iw.gauge)).find((g) => ampacity(g.awg, ew.inEngineSpace, false, bundled) >= need)?.awg;
        if (target && gaugeIndex(ew.gauge) < gaugeIndex(target)) {
          changes.push({
            priority: 'recommended',
            title: `${circuit(IN, iw)}: upsize wire ${fmtSize(ew.gauge, units)} → ${fmtSize(target, units)}`,
            detail: `At ~${Math.round(current)} A over ${fmtLen(iw.lengthFt, units)}, bundled with ${bundled} other wire${bundled === 1 ? '' : 's'}.`,
            rule: 'conductor-sizing',
            parts: [[`cable:${target}`, iw.lengthFt * 2]],
            wires: [ew.id],
          });
          mark([ew.id], `Too small for its bundle; the ideal design's ${size(iw)} assumes a cable on its own`);
        }
      } else {
        const ce = copper(ew);
        const ci = copper(iw);
        if (ce !== undefined && ci !== undefined && ce < ci) {
          changes.push({
            priority: 'recommended',
            title: `${circuit(IN, iw)}: upsize wire ${size(ew)} → ${size(iw)}`,
            detail: `At ~${Math.round(current)} A over ${fmtLen(iw.lengthFt, units)}.`,
            rule: 'conductor-sizing',
            parts: [[`${iw.kind === 'ac' ? 'accable' : 'cable'}:${iw.gauge}`, iw.lengthFt * (iw.kind === 'ac' ? 1 : 2)]],
            wires: [ew.id],
          });
          mark([ew.id], `Smaller than the ideal design's ${size(iw)}`);
        }
      }
    }
    // the breaker or fuse position this wire is on
    const rating = (N: Map<string, DNode>, w: Wire) =>
      [w.from, w.to].map((e) => N.get(e.node)?.terminals.find((t) => t.id === e.term)?.rating).find((r) => r !== undefined);
    const ri = rating(IN, iw);
    const re = rating(EN, ew);
    if (ri !== undefined && re !== undefined && ri !== re) {
      const kind = [ew.from, ew.to].some((e) => EN.get(e.node)?.type === 'fuse-block') ? 'fuse' : 'breaker';
      changes.push({
        priority: re > ri ? 'recommended' : 'improvement',
        title: `${circuit(IN, iw)}: ${re} A ${kind} on the boat; the ideal design uses ${ri} A`,
        detail: re > ri ? `A ${kind} larger than the design needs may not protect the wire.` : `A ${kind} smaller than the design needs may trip in normal use.`,
        rule: 'branch-protection',
        parts: [[kind === 'fuse' ? 'part:blade-fuse' : IN.get(iw.from.node)?.type === 'ac-panel' || IN.get(iw.to.node)?.type === 'ac-panel' ? 'part:ac-breaker' : 'part:dc-breaker', 1]],
        wires: [ew.id],
      });
      mark([ew.id], `On a ${re} A ${kind}; the ideal design uses ${ri} A`);
    }
  }

  // ---- 3. fuses and breakers matched between the designs: rating
  for (const [iid, eid] of matched) {
    const i = IN.get(iid)!;
    const e = EN.get(eid)!;
    if (i.type !== 'fuse' && i.type !== 'breaker') continue;
    const ri = Number(i.data.rating);
    const re = Number(e.data.rating);
    if (!(ri > 0) || !(re > 0) || ri === re) continue;
    const word = i.type === 'fuse' ? 'fuse' : 'breaker';
    const ids = existing.wires.filter((w) => w.from.node === eid || w.to.node === eid).map((w) => w.id);
    changes.push({
      priority: re > ri ? 'recommended' : 'improvement',
      title: `${e.label}: ${re} A ${word} on the boat; the ideal design uses ${ri} A`,
      detail: re > ri ? `A ${word} larger than the design needs may not protect the wire.` : `A ${word} smaller than the design needs may trip in normal use.`,
      rule: i.type === 'fuse' ? 'battery-fuse' : 'branch-protection',
      wires: ids,
    });
    mark(ids, `${e.label} is ${re} A; the ideal design uses ${ri} A`);
  }

  // ---- 4. ideal wires not on the drawing: rerouted, through extra parts, or not there at all
  const unmatchedE = (id: string) => !back.has(id);
  const subjectOrder = (w: Wire): [WireEnd, WireEnd][] => {
    const a = IN.get(w.from.node)!;
    const b = IN.get(w.to.node)!;
    const score = (n: DNode) => (isLoad(n) ? 2 : n.equipmentId ? 1 : 0) * 10 + n.col;
    return score(b) >= score(a) ? [[w.to, w.from], [w.from, w.to]] : [[w.from, w.to], [w.to, w.from]];
  };
  for (const iw of missing) {
    let done = false;
    for (const [subj, other] of subjectOrder(iw)) {
      const es: WireEnd = { node: matched.get(subj.node)!, term: subj.term };
      const eo: WireEnd = { node: matched.get(other.node)!, term: other.term };
      const sn = EN.get(es.node)!;
      const on = EN.get(eo.node)!;
      const candidates = at(existing, EN, es, iw.kind).filter((w) => !used.has(w.id));
      if (!candidates.length) continue;
      // through extra parts, but between the same two components
      for (const w of candidates) {
        const t = trace(existing, EN, w, es, unmatchedE);
        if (t.via.length && t.end.node === eo.node && sameTerminal(on, t.end.term, eo.term)) {
          t.path.forEach((x) => used.add(x.id));
          changes.push({
            priority: 'improvement',
            title: `${sn.label} → ${on.label}: on the boat this runs through ${t.via.map(named).join(', ')}; the ideal design connects them directly`,
            rule: 'ideal-routing',
            wires: t.path.map((x) => x.id),
          });
          mark(t.path.map((x) => x.id), 'Runs through parts the ideal design does not have here');
          done = true;
          break;
        }
      }
      if (done) break;
      const w = candidates[0];
      const t = trace(existing, EN, w, es, unmatchedE);
      t.path.forEach((x) => used.add(x.id));
      const fed = isLoad(sn) && iw.kind !== 'neg' && iw.kind !== 'gnd';
      const via = t.via.length ? ` through ${t.via.map(named).join(', ')}` : '';
      changes.push({
        priority: 'improvement',
        title: fed
          ? `${sn.label}: fed from ${where(EN, t.end)}${via}; the ideal design feeds it from ${where(IN, other)}`
          : `${where(EN, es)}: connected to ${where(EN, t.end)}${via} on the boat; the ideal design connects it to ${where(IN, other)}`,
        detail: `Move the wire from ${where(EN, t.end)} to ${on.label}.`,
        rule: 'ideal-routing',
        wires: t.path.map((x) => x.id),
      });
      mark(t.path.map((x) => x.id), `The ideal design connects this to ${where(IN, other)}`);
      done = true;
      break;
    }
    if (done) continue;
    const a = EN.get(matched.get(iw.from.node)!)!;
    const b = EN.get(matched.get(iw.to.node)!)!;
    const size = iw.gauge && iw.kind !== 'sig' ? (iw.cable ? cableLabel(iw, units)! : fmtSize(iw.gauge, units)) : undefined;
    changes.push({
      priority: 'improvement',
      title: `Add a wire: ${a.label} → ${b.label}`,
      detail: `The ideal design has ${size ? `a ${size} ` : 'a '}wire from ${where(IN, iw.from)} to ${where(IN, iw.to)}; there is none on the drawing.`,
      rule: 'ideal-routing',
      parts: size && iw.gauge ? [[`${iw.kind === 'ac' ? 'accable' : 'cable'}:${iw.gauge}`, iw.lengthFt]] : undefined,
    });
  }

  // ---- 5. wires on the drawing between matched components that the ideal design does not have
  const unmatchedI = (id: string) => !matched.has(id);
  for (const ew of existing.wires) {
    if (used.has(ew.id)) continue;
    const ia = back.get(ew.from.node);
    const ib = back.get(ew.to.node);
    if (!ia || !ib) continue;
    const a = EN.get(ew.from.node)!;
    const b = EN.get(ew.to.node)!;
    // does the ideal design put a part in this wire?
    const start = { node: ia, term: ew.from.term };
    const inIdeal = ideal.wires
      .filter((w) => w.kind === ew.kind && [w.from, w.to].some((x) => x.node === ia && sameTerminal(IN.get(ia)!, x.term, ew.from.term)))
      .map((w) => trace(ideal, IN, w, start, unmatchedI))
      .find((t) => t.via.length && t.end.node === ib);
    if (inIdeal) {
      const protective = inIdeal.via.some((n) => n.type === 'fuse' || n.type === 'breaker');
      changes.push({
        priority: protective ? 'recommended' : 'improvement',
        title: `${a.label} → ${b.label}: the ideal design has ${inIdeal.via.map(named).join(', ')} in this wire`,
        rule: protective ? 'branch-protection' : 'ideal-routing',
        wires: [ew.id],
      });
      mark([ew.id], `The ideal design has ${inIdeal.via.map((n) => n.label).join(', ')} in this wire`);
      continue;
    }
    changes.push({
      priority: 'improvement',
      title: `${where(EN, ew.from)} → ${where(EN, ew.to)}: this wire is not in the ideal design`,
      detail: 'Check whether it is needed, or move it as the other lines of the plan say.',
      rule: 'ideal-routing',
      wires: [ew.id],
    });
    mark([ew.id], 'Not in the ideal design');
  }

  return { changes, wires: marks, matched };
}
