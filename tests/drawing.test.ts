import { describe, expect, it } from 'vitest';
import { copyOf, duplicate, freeSpot, nudge, paste, reconnect, removeItems } from '../src/engine/drawing';
import { paletteNode } from '../src/engine/existing';
import type { Design, Wire } from '../src/model/types';

function drawing() {
  const bat = paletteNode('battery', 'battery');
  const fuse = paletteNode('fuse', 'battery');
  const load = paletteNode('load', 'saloon');
  const neg = paletteNode('bus-neg', 'battery');
  bat.pos = { x: 0, y: 0 };
  fuse.pos = { x: 200, y: 0 };
  load.pos = { x: 400, y: 0 };
  neg.pos = { x: 200, y: 200 };
  bat.equipmentId = 'eq-house';
  const wire = (id: string, kind: Wire['kind'], a: [string, string], b: [string, string]): Wire => ({ id, kind, domain: 'dc', from: { node: a[0], term: a[1] }, to: { node: b[0], term: b[1] }, lengthFt: 2, gauge: '10' });
  const d: Design = {
    id: 'existing',
    name: 'Existing',
    systemVoltage: 12,
    nodes: [bat, fuse, load, neg],
    findings: [],
    wires: [wire('w1', 'pos', [bat.id, 'pos'], [fuse.id, 'in']), wire('w2', 'pos', [fuse.id, 'out'], [load.id, 'pos']), wire('w3', 'neg', [load.id, 'neg'], [neg.id, neg.terminals[0].id])],
  };
  return { d, bat, fuse, load, neg };
}

describe('deleting several things at once', () => {
  it('removes the components, their wires, and any wires named', () => {
    const { d, fuse, load } = drawing();
    removeItems(d, [fuse.id], ['w3']);
    expect(d.nodes.map((n) => n.type)).toEqual(['battery', 'load', 'bus-neg']);
    expect(d.wires).toEqual([]);
    removeItems(d, [load.id, 'not-there'], ['nor-this']);
    expect(d.nodes).toHaveLength(2);
  });
});

describe('nudging', () => {
  it('moves only the chosen components', () => {
    const { d, bat, fuse } = drawing();
    nudge(d, [fuse.id], 10, -20);
    expect(d.nodes.find((n) => n.id === fuse.id)!.pos).toEqual({ x: 210, y: -20 });
    expect(d.nodes.find((n) => n.id === bat.id)!.pos).toEqual({ x: 0, y: 0 });
  });
});

describe('copy, paste and duplicate', () => {
  it('a copy takes the wires between the copied components and leaves the others', () => {
    const { d, bat, fuse, load } = drawing();
    const clip = copyOf(d, [bat.id, fuse.id]);
    expect(clip.nodes).toHaveLength(2);
    expect(clip.wires.map((w) => w.id)).toEqual(['w1']);
    // the clip is a snapshot: later edits to the drawing do not change it
    d.nodes.find((n) => n.id === fuse.id)!.data.rating = 999;
    expect(clip.nodes.find((n) => n.type === 'fuse')!.data.rating).toBe(30);
    expect(copyOf(d, [load.id]).wires).toEqual([]);
  });

  it('paste adds independent copies, shifted, wired to each other', () => {
    const { d, bat, fuse } = drawing();
    const ids = paste(d, copyOf(d, [bat.id, fuse.id]), { x: 40, y: 40 });
    expect(ids).toHaveLength(2);
    expect(d.nodes).toHaveLength(6);
    const [b2, f2] = ids.map((id) => d.nodes.find((n) => n.id === id)!);
    expect(b2.id).not.toBe(bat.id);
    expect(b2.pos).toEqual({ x: 40, y: 40 });
    expect(f2.pos).toEqual({ x: 240, y: 40 });
    // not tied to the equipment list: an item can only be on the drawing once
    expect(b2.equipmentId).toBeUndefined();
    const w = d.wires[d.wires.length - 1];
    expect(w.id).not.toBe('w1');
    expect([w.from.node, w.to.node]).toEqual([b2.id, f2.id]);
    expect(w.gauge).toBe('10');
    // the originals are untouched
    expect(d.wires.find((x) => x.id === 'w1')!.from.node).toBe(bat.id);
  });

  it('duplicate is copy and paste in one step', () => {
    const { d, fuse } = drawing();
    const [id] = duplicate(d, [fuse.id]);
    const copy = d.nodes.find((n) => n.id === id)!;
    expect(copy.type).toBe('fuse');
    expect(copy.pos).toEqual({ x: 230, y: 30 });
    expect(d.wires).toHaveLength(3);
  });
});

describe('moving a wire end to another terminal', () => {
  it('moves it when the terminals may be joined', () => {
    const { d, bat, neg } = drawing();
    const second = paletteNode('load', 'saloon');
    d.nodes.push(second);
    expect(reconnect(d, 'w2', 'to', { node: second.id, term: 'pos' })).toEqual({ ok: true });
    expect(d.wires.find((w) => w.id === 'w2')!.to).toEqual({ node: second.id, term: 'pos' });
    // the other end stays where it was
    expect(d.wires.find((w) => w.id === 'w2')!.from.term).toBe('out');
    expect(reconnect(d, 'w3', 'from', { node: bat.id, term: 'neg' })).toEqual({ ok: true });
    expect(d.wires.find((w) => w.id === 'w3')!.to.node).toBe(neg.id);
  });

  it('refuses a dead short, a loop back to the same component, and things that are not there', () => {
    const { d, bat, fuse, load } = drawing();
    const short = reconnect(d, 'w2', 'to', { node: load.id, term: 'neg' });
    expect(short.ok).toBe(false);
    if (!short.ok) expect(short.why).toMatch(/dead short/);
    expect(d.wires.find((w) => w.id === 'w2')!.to.term).toBe('pos');
    expect(reconnect(d, 'w1', 'from', { node: fuse.id, term: 'out' }).ok).toBe(false);
    expect(reconnect(d, 'nope', 'to', { node: bat.id, term: 'pos' }).ok).toBe(false);
    expect(reconnect(d, 'w1', 'to', { node: 'ghost', term: 'x' }).ok).toBe(false);
  });
});

describe('placing a new component', () => {
  it('snaps to the grid and steps aside from a component already there', () => {
    const { d } = drawing();
    expect(freeSpot(d, { x: 603, y: 298 })).toEqual({ x: 600, y: 300 });
    expect(freeSpot(d, { x: 201, y: 2 })).toEqual({ x: 220, y: 20 });
    expect(freeSpot(undefined, { x: 14, y: 16 })).toEqual({ x: 10, y: 20 });
  });
});
