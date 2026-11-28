// Marks left by "Size wires & fuses" on the existing-boat drawing: which parts and wires BoatWire
// added, upgraded or filled in, as opposed to what the owner drew. Pure, unit-tested.

import type { Design, DNode, FixMark, Wire } from '../model/types';

/**
 * Mark an item, keeping what is known from an earlier run: added stays added, set stays set, and
 * "was" stays the first size. A panel's positions are all kept: an upgraded one has a "was", one
 * that had no rating has none, and the panel counts as upgraded if any position was.
 */
export function markItem(item: DNode | Wire, mark: FixMark): void {
  const old = item.fixMark;
  if (old?.kind === 'added') return;
  if (mark.positions || old?.positions) {
    const positions = mergePositions(old?.positions, mark.positions);
    item.fixMark = { kind: positions.some((p) => p.was !== undefined) ? 'upgraded' : 'set', positions };
    return;
  }
  if (!old) {
    item.fixMark = mark;
    return;
  }
  // filled in where there was nothing: it stays that, whatever this run did
  if (old.kind === 'set' || mark.kind !== 'upgraded') return;
  const next: FixMark = { kind: 'upgraded' };
  const wasGauge = old.wasGauge ?? mark.wasGauge;
  const wasRating = old.wasRating ?? mark.wasRating;
  if (wasGauge) next.wasGauge = wasGauge;
  if (wasRating !== undefined) next.wasRating = wasRating;
  item.fixMark = next;
}

function mergePositions(a: FixMark['positions'], b: FixMark['positions']) {
  const out = [...(a ?? [])];
  for (const p of b ?? []) if (!out.some((x) => x.term === p.term)) out.push(p);
  return out;
}

/** Is any part or wire of the drawing marked? */
export function hasMarks(d: Design | undefined): boolean {
  return !!d && (d.nodes.some((n) => n.fixMark) || d.wires.some((w) => w.fixMark));
}

/** Remove every mark (the "Clear marks" button). */
export function clearMarks(d: Design): void {
  for (const n of d.nodes) delete n.fixMark;
  for (const w of d.wires) delete w.fixMark;
}

/**
 * What a mark is about, for telling whether the owner has since changed it: a wire's size and where
 * it connects; a part's rating and fuse type, and the ratings of the positions it had. Not a length
 * (the owner is asked to measure it), a name, a place on the canvas or a new panel position.
 */
const wireSubstance = (w: Wire) => JSON.stringify([w.gauge, w.cable, w.kind, w.from, w.to]);
const nodeSubstance = (n: DNode, terms?: Set<string>) =>
  JSON.stringify([n.type, n.data.rating, n.data.fuseClass, n.terminals.filter((t) => !terms || terms.has(t.id)).map((t) => [t.id, t.rating])]);

/**
 * After an edit to the drawing, drop the mark from every marked item whose size, rating or
 * connections the edit changed: the owner has decided that one. Measuring a length, renaming or
 * moving it on the canvas does not count.
 */
export function clearTouchedMarks(before: Design, after: Design): void {
  const nodes = new Map(before.nodes.filter((n) => n.fixMark).map((n) => [n.id, n]));
  const wires = new Map(before.wires.filter((w) => w.fixMark).map((w) => [w.id, w]));
  if (!nodes.size && !wires.size) return;
  for (const n of after.nodes) {
    const b = n.fixMark && nodes.get(n.id);
    if (!b) continue;
    const terms = new Set(b.terminals.map((t) => t.id));
    if (nodeSubstance(b, terms) !== nodeSubstance(n, terms)) delete n.fixMark;
  }
  for (const w of after.wires) {
    const b = w.fixMark && wires.get(w.id);
    if (b && wireSubstance(b) !== wireSubstance(w)) delete w.fixMark;
  }
}
