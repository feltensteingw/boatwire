import { describe, expect, it } from 'vitest';
import { compareWithIdeal, matchNodes } from '../src/engine/compare';
import { existingFromIdeal } from '../src/engine/existing';
import { generateIdeal } from '../src/engine/generate';
import { changeList } from '../src/engine/reports';
import { exampleProject } from '../src/model/examples';
import { FINGERPRINT_BOATS, SAMPLE_BOATS } from './sampleBoats';
import { growTerminal } from '../src/model/nodeDefs';
import type { Design, Wire } from '../src/model/types';

const p = exampleProject();
const ideal = generateIdeal(p);
const copy = () => existingFromIdeal(ideal, {});
const lines = (d: Design) => compareWithIdeal(d, ideal).changes.map((c) => `${c.priority}: ${c.title}`);
const wireBetween = (d: Design, a: string, b: string) => d.wires.find((w) => (w.from.node === a && w.to.node === b) || (w.from.node === b && w.to.node === a))!;
const endAt = (w: Wire, node: string) => (w.from.node === node ? 'from' : 'to');

describe('matching components between the drawing and the ideal design', () => {
  it('a copy of the ideal design matches every component and has no differences', () => {
    const r = compareWithIdeal(copy(), ideal);
    expect(r.matched.size).toBe(ideal.nodes.filter((n) => n.type !== 'note').length);
    expect(r.changes).toEqual([]);
    expect(r.wires.size).toBe(0);
    expect(changeList(copy(), ideal, 120)).toEqual([]);
  });

  it('finds hand-drawn parts (no role, other ids, other names) from how they are wired', () => {
    const d = copy();
    const rename = new Map<string, string>();
    for (const n of d.nodes) {
      if (n.equipmentId) continue;
      rename.set(n.id, `hand-${n.id}`);
      n.id = `hand-${n.id}`;
      n.role = undefined;
      n.label = `My ${n.label.toLowerCase()}`;
    }
    for (const w of d.wires) for (const e of [w.from, w.to]) e.node = rename.get(e.node) ?? e.node;
    const m = matchNodes(d, ideal);
    for (const [from, to] of rename) expect(m.get(from), from).toBe(to);
    expect(compareWithIdeal(d, ideal).changes).toEqual([]);
  });
});

describe('every sample boat', () => {
  for (const b of [...SAMPLE_BOATS, ...FINGERPRINT_BOATS]) {
    it(`${b.name}: a copy of its ideal design, and the same drawn by hand, show no differences`, () => {
      const d = generateIdeal(b.project, b.scenario);
      expect(compareWithIdeal(existingFromIdeal(d, {}), d).changes).toEqual([]);
      const hand = existingFromIdeal(d, {});
      for (const n of hand.nodes) {
        n.role = undefined;
        if (!n.equipmentId) n.label = `My ${n.label}`;
      }
      expect(compareWithIdeal(hand, d).changes).toEqual([]);
    });
  }
});

describe('connection by connection', () => {
  it('names a wire that goes somewhere else, and marks it on the drawing', () => {
    const d = copy();
    const w = wireBetween(d, 'alt-fuse', 'pos-bus');
    w[endAt(w, 'pos-bus')] = { node: 'start-bus', term: growTerminal(d.nodes.find((n) => n.id === 'start-bus')!) };
    const r = compareWithIdeal(d, ideal);
    expect(r.changes).toHaveLength(1);
    expect(r.changes[0]).toMatchObject({ priority: 'improvement', rule: 'ideal-routing', wires: [w.id] });
    expect(r.changes[0].title).toBe('Alternator output fuse: connected to Start positive bus on the boat; the ideal design connects it to Main positive bus');
    expect([...r.wires.keys()]).toEqual([w.id]);
  });

  it('says where a load is fed from, and where the ideal design feeds it from', () => {
    const d = copy();
    const pump = d.nodes.find((n) => n.data.kind === 'bilge-pump')!;
    const sw = d.nodes.find((n) => n.type === 'bilge-switch' && n.id === pump.id.replace(/^ld-/, 'bsw-'))!;
    const panel = d.nodes.find((n) => n.type === 'dc-panel')!;
    const w = wireBetween(d, sw.id, pump.id);
    w[endAt(w, sw.id)] = { node: panel.id, term: growTerminal(panel, { rating: 10, label: '10 A' }) };
    expect(lines(d)).toEqual([`improvement: ${pump.label}: fed from DC panel 10 A breaker; the ideal design feeds it from ${sw.label}`]);
  });

  it('stays quiet about another stud on the same bus or a fuse wired the other way round', () => {
    const d = copy();
    const bus = d.nodes.find((n) => n.id === 'pos-bus')!;
    const w = d.wires.find((x) => x.to.node === 'pos-bus' || x.from.node === 'pos-bus')!;
    w[endAt(w, 'pos-bus')] = { node: 'pos-bus', term: growTerminal(bus) };
    const f = d.wires.filter((x) => x.from.node === 'house0-fuse' || x.to.node === 'house0-fuse');
    for (const x of f) for (const e of [x.from, x.to]) if (e.node === 'house0-fuse') e.term = e.term === 'in' ? 'out' : 'in';
    expect(lines(d)).toEqual([]);
  });

  it('a wire on the wrong terminal of a part with fixed terminals is named', () => {
    const d = copy();
    const w = d.wires.find((x) => x.kind === 'neg' && (x.from.node === 'house-shunt' || x.to.node === 'house-shunt'))!;
    const e = w[endAt(w, 'house-shunt')];
    e.term = e.term === 'bat' ? 'sys' : 'bat';
    const out = compareWithIdeal(d, ideal).changes;
    expect(out.length).toBe(1);
    expect(out[0]).toMatchObject({ priority: 'improvement', wires: [w.id] });
    expect(out[0].title).toMatch(/^House battery monitor: move the wire to .* from terminal (BAT−|SYS−) to terminal (BAT−|SYS−)$/);
  });

  it('a part on the boat that the ideal design does not have in that wire', () => {
    const d = copy();
    const fridge = d.nodes.find((n) => n.data.kind === 'fridge')!;
    const fw = d.wires.find((w) => w.kind === 'pos' && w.to.node === fridge.id)!;
    d.nodes.push({ id: 'xf', type: 'fuse', label: 'Inline fuse', domain: 'dc', col: 6, zone: fridge.zone, terminals: [{ id: 'in', pol: 'pos', side: 'W' }, { id: 'out', pol: 'pos', side: 'E' }], data: { rating: 10 } });
    d.wires.push({ id: 'xw', kind: 'pos', domain: 'dc', from: { node: 'xf', term: 'out' }, to: { ...fw.to }, lengthFt: 1, gauge: fw.gauge });
    fw.to = { node: 'xf', term: 'in' };
    const r = compareWithIdeal(d, ideal);
    expect(r.changes.map((c) => c.title)).toEqual([`${fridge.label} → DC panel: on the boat this runs through Inline fuse (10 A); the ideal design connects them directly`]);
    expect(new Set(r.wires.keys())).toEqual(new Set([fw.id, 'xw']));
  });

  it('a part the ideal design has in a wire that the boat joins directly', () => {
    const d = copy();
    d.nodes = d.nodes.filter((n) => n.id !== 'house0-fuse');
    d.wires = d.wires.filter((w) => w.from.node !== 'house0-fuse' && w.to.node !== 'house0-fuse');
    d.wires.push({ id: 'x1', kind: 'pos', domain: 'dc', from: { node: 'house0-bat', term: 'pos' }, to: { node: 'house-switch', term: 'in' }, lengthFt: 2, gauge: '2/0' });
    expect(lines(d)).toEqual(['recommended: House bank → House battery switch: the ideal design has House main fuse (400 A) in this wire']);
  });

  it('a wire the ideal design does not have, and one it has that is missing', () => {
    const d = copy();
    const gone = d.wires.find((w) => w.kind === 'neg' && (w.from.node === 'start-bat' || w.to.node === 'start-bat'))!;
    d.wires = d.wires.filter((w) => w !== gone);
    expect(lines(d)).toHaveLength(1);
    expect(lines(d)[0]).toMatch(/^improvement: Add a wire: /);
    const e = copy();
    const bus = e.nodes.find((n) => n.id === 'pos-bus')!;
    e.wires.push({ id: 'extra', kind: 'pos', domain: 'dc', from: { node: 'pos-bus', term: growTerminal(bus) }, to: { node: 'dc-panel', term: 'in' }, lengthFt: 4, gauge: '10' });
    const r = compareWithIdeal(e, ideal);
    expect(r.changes.map((c) => c.title)).toEqual(['Main positive bus → DC panel: this wire is not in the ideal design']);
    expect(r.wires.has('extra')).toBe(true);
  });
});

describe('sizes and ratings of every matched wire', () => {
  it('a smaller wire anywhere, not only to an appliance', () => {
    const d = copy();
    const w = wireBetween(d, 'alt-fuse', 'pos-bus');
    w.gauge = '14';
    w.cable = undefined;
    const c = compareWithIdeal(d, ideal).changes;
    expect(c).toHaveLength(1);
    expect(c[0]).toMatchObject({ priority: 'recommended', rule: 'conductor-sizing', wires: [w.id] });
    expect(c[0].title).toMatch(/^Alternator output fuse → Main positive bus: upsize wire 14 AWG → 4 AWG$/);
    // a larger wire than needed is fine
    const e = copy();
    wireBetween(e, 'alt-fuse', 'pos-bus').gauge = '4/0';
    expect(lines(e)).toEqual([]);
  });

  it('a different fuse or panel breaker: too big is recommended, too small an improvement', () => {
    const d = copy();
    d.nodes.find((n) => n.id === 'house0-fuse')!.data.rating = 300;
    const panel = d.nodes.find((n) => n.id === 'dc-panel')!;
    const t = panel.terminals.find((x) => x.rating)!;
    const was = t.rating!;
    t.rating = was + 20;
    const out = lines(d);
    expect(out).toContain('improvement: House main fuse: 300 A fuse on the boat; the ideal design uses 400 A');
    expect(out.some((l) => l.startsWith('recommended: ') && l.endsWith(`${was + 20} A breaker on the boat; the ideal design uses ${was} A`))).toBe(true);
  });

  it('a different route is never a safety item', () => {
    const d = copy();
    const w = wireBetween(d, 'alt-fuse', 'pos-bus');
    w[endAt(w, 'pos-bus')] = { node: 'start-bus', term: growTerminal(d.nodes.find((n) => n.id === 'start-bus')!) };
    d.wires.push({ id: 'extra', kind: 'pos', domain: 'dc', from: { node: 'pos-bus', term: growTerminal(d.nodes.find((n) => n.id === 'pos-bus')!) }, to: { node: 'dc-panel', term: 'in' }, lengthFt: 4, gauge: '10' });
    expect(compareWithIdeal(d, ideal).changes.some((c) => c.priority === 'safety')).toBe(false);
  });

  it('the upgrade plan includes the connection lines, sorted by priority', () => {
    const d = copy();
    const w = wireBetween(d, 'alt-fuse', 'pos-bus');
    w[endAt(w, 'pos-bus')] = { node: 'start-bus', term: growTerminal(d.nodes.find((n) => n.id === 'start-bus')!) };
    const plan = changeList(d, ideal, 120);
    expect(plan.some((c) => c.title.startsWith('Alternator output fuse: connected to Start positive bus'))).toBe(true);
    const order = { safety: 0, recommended: 1, improvement: 2 };
    expect(plan.map((c) => order[c.priority])).toEqual([...plan.map((c) => order[c.priority])].sort());
  });
});
