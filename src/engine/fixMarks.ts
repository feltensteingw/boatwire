// Marks left by "Size wires & fuses" on the existing-boat drawing: which parts and wires BoatWire
// added, upgraded or filled in, as opposed to what the owner drew. Pure, unit-tested.

import type { Design, DNode, FixMark, Wire } from '../model/types';

/** Mark an item, keeping what is known from an earlier run: added stays added, "was" stays the first size. */
export function markItem(item: DNode | Wire, mark: FixMark): void {
  const old = item.fixMark;
  if (!old) {
    item.fixMark = mark;
    return;
  }
  // added by BoatWire, or filled in where there was nothing: it stays that, whatever this run did
  if (old.kind === 'added' || old.kind === 'set') return;
  if (mark.kind !== 'upgraded') return;
  const next: FixMark = { kind: 'upgraded' };
  const wasGauge = old.wasGauge ?? mark.wasGauge;
  const wasRating = old.wasRating ?? mark.wasRating;
  if (wasGauge) next.wasGauge = wasGauge;
  if (wasRating !== undefined) next.wasRating = wasRating;
  if (old.positions || mark.positions) next.positions = mergePositions(old.positions, mark.positions);
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

/** What an item is, for telling whether the owner changed it: everything but its place and its mark. */
const substance = (x: DNode | Wire) => {
  const { fixMark: _m, pos: _p, ...rest } = x as DNode & Wire;
  return JSON.stringify(rest);
};

/**
 * After an edit to the drawing, drop the mark from every marked item the edit changed: once the
 * owner has touched it, it is theirs. Moving a part on the canvas does not count.
 */
export function clearTouchedMarks(before: Design, after: Design): void {
  const was = new Map<string, string>();
  for (const n of before.nodes) if (n.fixMark) was.set(`n:${n.id}`, substance(n));
  for (const w of before.wires) if (w.fixMark) was.set(`w:${w.id}`, substance(w));
  if (!was.size) return;
  for (const n of after.nodes) if (n.fixMark && was.has(`n:${n.id}`) && was.get(`n:${n.id}`) !== substance(n)) delete n.fixMark;
  for (const w of after.wires) if (w.fixMark && was.has(`w:${w.id}`) && was.get(`w:${w.id}`) !== substance(w)) delete w.fixMark;
}
