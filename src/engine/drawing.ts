// Edits to the hand-drawn "existing boat" design that act on several things at once:
// delete, duplicate, copy and paste, nudge, and moving a wire end to another terminal.
// Pure functions on a Design (changed in place), so they are unit-tested without the app.

import { uid } from '../model/examples';
import { terminal } from '../model/nodeDefs';
import type { Design, DNode, Wire, WireEnd } from '../model/types';
import { joinTerminals } from './connect';

export const GRID = 10;
/** The nearest point on the drawing grid. */
export const snapToGrid = (v: number) => Math.round(v / GRID) * GRID;
const snap = snapToGrid;

/** Remove components and wires. A wire attached to a removed component goes with it. */
export function removeItems(d: Design, nodeIds: string[], wireIds: string[]): void {
  const nodes = new Set(nodeIds);
  const wires = new Set(wireIds);
  d.nodes = d.nodes.filter((n) => !nodes.has(n.id));
  d.wires = d.wires.filter((w) => !wires.has(w.id) && !nodes.has(w.from.node) && !nodes.has(w.to.node));
}

/** Move components by a distance in diagram units. */
export function nudge(d: Design, nodeIds: string[], dx: number, dy: number): void {
  const ids = new Set(nodeIds);
  for (const n of d.nodes) if (ids.has(n.id)) n.pos = { x: (n.pos?.x ?? 0) + dx, y: (n.pos?.y ?? 0) + dy };
}

/** Components, with the wires that run between them, lifted out of a drawing. */
export interface Clip {
  nodes: DNode[];
  wires: Wire[];
}

export function copyOf(d: Design, nodeIds: string[]): Clip {
  const ids = new Set(nodeIds);
  return structuredClone({
    nodes: d.nodes.filter((n) => ids.has(n.id)),
    // only wires with both ends inside the selection: a wire to something not copied would dangle
    wires: d.wires.filter((w) => ids.has(w.from.node) && ids.has(w.to.node)),
  });
}

/**
 * Add a copy of the clip to the drawing, shifted by `offset`. Returns the new component ids.
 * Copies are independent components: they are not tied to an item in the equipment list, which
 * can only be on the drawing once.
 */
export function paste(d: Design, clip: Clip, offset: { x: number; y: number }): string[] {
  const idOf = new Map<string, string>();
  for (const n of clip.nodes) {
    const copy = structuredClone(n);
    copy.id = uid('n');
    idOf.set(n.id, copy.id);
    copy.pos = { x: snap((n.pos?.x ?? 0) + offset.x), y: snap((n.pos?.y ?? 0) + offset.y) };
    delete copy.equipmentId;
    delete copy.role;
    d.nodes.push(copy);
  }
  for (const w of clip.wires) {
    const from = idOf.get(w.from.node);
    const to = idOf.get(w.to.node);
    if (!from || !to) continue;
    d.wires.push({ ...structuredClone(w), id: uid('w'), from: { node: from, term: w.from.term }, to: { node: to, term: w.to.term } });
  }
  return [...idOf.values()];
}

/** Duplicate components in place, a little down and to the right. Returns the new ids. */
export function duplicate(d: Design, nodeIds: string[], offset = { x: 3 * GRID, y: 3 * GRID }): string[] {
  return paste(d, copyOf(d, nodeIds), offset);
}

/**
 * Move one end of a wire to another terminal. The same rules apply as for drawing a wire:
 * the two terminals must be allowed to be joined, and a wire cannot start and end on one component.
 */
export function reconnect(d: Design, wireId: string, end: 'from' | 'to', to: WireEnd): { ok: true } | { ok: false; why: string } {
  const w = d.wires.find((x) => x.id === wireId);
  if (!w) return { ok: false, why: 'That wire is no longer on the drawing.' };
  const other = end === 'from' ? w.to : w.from;
  if (other.node === to.node) return { ok: false, why: 'A wire cannot start and end on the same component.' };
  const pol = (e: WireEnd) => {
    const n = d.nodes.find((x) => x.id === e.node);
    return n ? terminal(n, e.term)?.pol : undefined;
  };
  const target = pol(to);
  if (!target) return { ok: false, why: 'That terminal is no longer on the drawing.' };
  const joined = joinTerminals(pol(other), target);
  if (!joined.ok) return { ok: false, why: joined.why };
  w[end] = { node: to.node, term: to.term };
  w.kind = joined.kind;
  w.domain = joined.kind === 'ac' || joined.kind === 'gnd' ? 'ac' : 'dc';
  return { ok: true };
}

/** Roughly the room one component takes on the drawing, for keeping new ones clear of old ones. */
const FOOTPRINT = { w: 170, h: 90 };
/** Steps away from the wanted spot, nearest first; below and to the right before above and to the left. */
const NEARBY: [number, number][] = [];
for (let dy = -3; dy <= 3; dy++) for (let dx = -3; dx <= 3; dx++) NEARBY.push([dx, dy]);
NEARBY.sort((a, b) => a[0] ** 2 + a[1] ** 2 - (b[0] ** 2 + b[1] ** 2) || Number(a[1] < 0) - Number(b[1] < 0) || Number(a[0] < 0) - Number(b[0] < 0));

/**
 * Where to put a new component so it lands at `at`, or as near to it as there is clear space.
 * Tries the spot itself, then spots around it (nearest first), and settles for a small step aside
 * if the whole area is crowded.
 */
export function freeSpot(d: Design | undefined, at: { x: number; y: number }): { x: number; y: number } {
  const start = { x: snap(at.x), y: snap(at.y) };
  const clear = (q: { x: number; y: number }, w: number, h: number) => !d?.nodes.some((n) => n.pos && Math.abs(n.pos.x - q.x) < w && Math.abs(n.pos.y - q.y) < h);
  for (const [dx, dy] of NEARBY) {
    const q = { x: start.x + dx * FOOTPRINT.w, y: start.y + dy * FOOTPRINT.h };
    if (clear(q, FOOTPRINT.w, FOOTPRINT.h)) return q;
  }
  // crowded: at least do not sit exactly on top of another component
  let p = start;
  for (let i = 0; i < 40 && !clear(p, GRID, GRID); i++) p = { x: p.x + 2 * GRID, y: p.y + 2 * GRID };
  return p;
}
