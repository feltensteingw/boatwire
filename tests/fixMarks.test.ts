import { describe, expect, it } from 'vitest';
import { sizeDrawing } from '../src/engine/autosize';
import { duplicate } from '../src/engine/drawing';
import { paletteNode } from '../src/engine/existing';
import { clearMarks, clearTouchedMarks, hasMarks, markItem } from '../src/engine/fixMarks';
import { blankProject } from '../src/model/examples';
import type { Design, DNode, NodeType, Wire, WireKind } from '../src/model/types';
import { parseProject } from '../src/model/validate';
import { nodeMarkText, wireMarkText } from '../src/ui/fixMarkText';

let seq = 0;
function draw(types: NodeType[], data: Record<number, DNode['data']> = {}): Design {
  const nodes = types.map((t, i) => {
    const n = paletteNode(t, 'nav');
    n.id = `n${i}`;
    Object.assign(n.data, data[i] ?? {});
    return n;
  });
  return { id: 'existing', name: 'Existing', systemVoltage: 12, nodes, wires: [], findings: [] };
}
function wire(d: Design, kind: WireKind, a: [number, string], b: [number, string], lengthFt = 10, extra: Partial<Wire> = {}) {
  d.wires.push({ id: `w${seq++}`, kind, domain: kind === 'ac' ? 'ac' : 'dc', from: { node: `n${a[0]}`, term: a[1] }, to: { node: `n${b[0]}`, term: b[1] }, lengthFt, ...extra });
}

/** battery → bus (no fuse) → 25 A load on 18 AWG, a 5 A load with no size, and a 10 A fuse → 20 A load. */
function drawing() {
  const d = draw(['battery', 'bus-pos', 'load', 'load', 'fuse', 'load'], { 0: { chemistry: 'agm' }, 2: { amps: 25 }, 3: { amps: 5 }, 4: { rating: 10 }, 5: { amps: 20 } });
  wire(d, 'pos', [0, 'pos'], [1, 's1'], 2, { gauge: '2' });
  wire(d, 'pos', [1, 's2'], [2, 'pos'], 6, { gauge: '18' });
  wire(d, 'pos', [1, 's3'], [3, 'pos'], 6);
  wire(d, 'pos', [1, 's4'], [4, 'in'], 0.4, { gauge: '10' });
  wire(d, 'pos', [4, 'out'], [5, 'pos'], 6, { gauge: '10' });
  return d;
}

describe('"Size wires & fuses" marks what it changed', () => {
  const d = drawing();
  sizeDrawing(d);
  const node = (id: string) => d.nodes.find((n) => n.id === id)!;
  const feed = (id: string) => d.wires.find((w) => w.from.node === id || w.to.node === id)!;

  it('a fuse it adds, and the short link to it, are marked added', () => {
    const added = d.nodes.filter((n) => n.fixMark?.kind === 'added');
    expect(added.length).toBeGreaterThanOrEqual(3); // at the battery, and for the two loads on the bus
    expect(added.every((n) => n.type === 'fuse')).toBe(true);
    for (const f of added) expect(d.wires.some((w) => w.fixMark?.kind === 'added' && (w.from.node === f.id || w.to.node === f.id))).toBe(true);
  });

  it('a wire made larger is marked upgraded, with the size it was', () => {
    expect(feed('n2').fixMark).toEqual({ kind: 'upgraded', wasGauge: '18' });
    expect(wireMarkText(feed('n2').fixMark!, feed('n2'), 'imperial').tag).toBe('was 18');
    expect(wireMarkText(feed('n2').fixMark!, feed('n2'), 'metric').tag).toBe('was 1 mm²') // 18 AWG as the app shows it in metric;
  });

  it('a wire that had no size is marked set', () => {
    expect(feed('n3').fixMark).toEqual({ kind: 'set' });
  });

  it('a fuse its circuit would blow is marked upgraded, with the rating it was', () => {
    expect(node('n4').fixMark).toEqual({ kind: 'upgraded', wasRating: 10 });
    expect(nodeMarkText(node('n4').fixMark!, node('n4')).tag).toBe('was 10 A');
  });

  it('what was already right, and what the owner drew, are not marked', () => {
    expect(node('n0').fixMark).toBeUndefined();
    expect(node('n1').fixMark).toBeUndefined();
    expect(node('n2').fixMark).toBeUndefined();
  });

  it('a raised panel position marks its panel, naming the position', () => {
    const p = draw(['battery', 'fuse', 'dc-panel', 'load'], { 0: { chemistry: 'agm' }, 1: { rating: 60 }, 3: { amps: 25 } });
    wire(p, 'pos', [0, 'pos'], [1, 'in'], 0.5, { gauge: '4' });
    wire(p, 'pos', [1, 'out'], [2, 'in'], 4, { gauge: '4' });
    wire(p, 'pos', [2, 'b1'], [3, 'pos'], 6, { gauge: '8' });
    sizeDrawing(p);
    const panel = p.nodes[2];
    expect(panel.fixMark).toEqual({ kind: 'upgraded', positions: [{ term: 'b1', was: 15 }] });
    expect(nodeMarkText(panel.fixMark!, panel).tip).toContain('(was 15 A)');
  });

  it('sizing again keeps the marks, and the first size an upgraded wire had', () => {
    const again = structuredClone(d);
    const w = again.wires.find((x) => x.id === feed('n2').id)!;
    w.lengthFt = 60; // longer run: needs a larger wire again
    sizeDrawing(again);
    expect(again.wires.find((x) => x.id === w.id)!.fixMark).toEqual({ kind: 'upgraded', wasGauge: '18' });
    expect(again.nodes.filter((n) => n.fixMark?.kind === 'added').length).toBe(d.nodes.filter((n) => n.fixMark?.kind === 'added').length);
  });
});

describe('marks after sizing', () => {
  it('editing a marked item removes its mark; moving it does not', () => {
    const before = drawing();
    sizeDrawing(before);
    const after = structuredClone(before);
    const fuse = after.nodes.find((n) => n.fixMark?.kind === 'upgraded')!;
    const added = after.nodes.find((n) => n.fixMark?.kind === 'added')!;
    const set = after.wires.find((w) => w.fixMark?.kind === 'set')!;
    fuse.data.rating = 40;
    added.pos = { x: (added.pos?.x ?? 0) + 50, y: 7 };
    set.lengthFt = 12;
    clearTouchedMarks(before, after);
    expect(fuse.fixMark).toBeUndefined();
    expect(added.fixMark).toEqual({ kind: 'added' });
    expect(set.fixMark).toBeUndefined();
  });

  it('Clear marks removes every mark and keeps the sizes', () => {
    const d = drawing();
    sizeDrawing(d);
    expect(hasMarks(d)).toBe(true);
    const sizes = d.wires.map((w) => w.gauge);
    clearMarks(d);
    expect(hasMarks(d)).toBe(false);
    expect(d.wires.map((w) => w.gauge)).toEqual(sizes);
  });

  it('a copied part is the owner’s own, not marked', () => {
    const d = drawing();
    sizeDrawing(d);
    const added = d.nodes.find((n) => n.fixMark?.kind === 'added')!;
    const [copy] = duplicate(d, [added.id]);
    expect(d.nodes.find((n) => n.id === copy)!.fixMark).toBeUndefined();
  });

  it('marks are saved with the boat and read back; anything else in their place is dropped', () => {
    const d = drawing();
    sizeDrawing(d);
    d.nodes[0].fixMark = { kind: 'bogus' } as never;
    const p = { ...blankProject(), existing: d };
    const back = parseProject(JSON.parse(JSON.stringify(p))).project.existing!;
    for (const n of d.nodes.slice(1)) expect(back.nodes.find((x) => x.id === n.id)!.fixMark).toEqual(n.fixMark);
    for (const w of d.wires) expect(back.wires.find((x) => x.id === w.id)!.fixMark).toEqual(w.fixMark);
    expect(back.nodes[0].fixMark).toBeUndefined();
  });

  it('a mark from an earlier run is kept: added stays added, set stays set', () => {
    const n = paletteNode('fuse', 'nav');
    markItem(n, { kind: 'added' });
    markItem(n, { kind: 'upgraded', wasRating: 10 });
    expect(n.fixMark).toEqual({ kind: 'added' });
    const m = paletteNode('fuse', 'nav');
    markItem(m, { kind: 'set' });
    markItem(m, { kind: 'upgraded', wasRating: 20 });
    expect(m.fixMark).toEqual({ kind: 'set' });
  });
});

describe('a drawn cable beyond the largest size', () => {
  it('is upgraded to parallel cables, and marked with what it was', () => {
    // 4000 W inverter on 12 V: ~435 A through a single 2/0
    const d = draw(['battery', 'fuse', 'inverter'], { 0: { chemistry: 'lifepo4' }, 1: { rating: undefined }, 2: { watts: 4000 } });
    wire(d, 'pos', [0, 'pos'], [1, 'in'], 0.5, { gauge: '2/0' });
    wire(d, 'pos', [1, 'out'], [2, 'dcpos'], 6, { gauge: '2/0' });
    sizeDrawing(d);
    for (const w of d.wires) {
      expect(w.cable).toMatch(/^[23]× /);
      expect(w.fixMark).toEqual({ kind: 'upgraded', wasGauge: '2/0' });
    }
  });
});
