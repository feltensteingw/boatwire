import { describe, expect, it } from 'vitest';
import { exampleProject, newEquipment } from '../src/model/examples';
import { generateIdeal } from '../src/engine/generate';
import { audit } from '../src/engine/audit';
import { sizeConductor, vdropPct } from '../src/engine/calc';
import { makeNode } from '../src/model/nodeDefs';
import type { Design, Project } from '../src/model/types';

describe('calc', () => {
  it('computes ABYC voltage drop', () => {
    // 10 A, 20 ft one way, 14 AWG at 12 V: 10.75*10*40/4110 = 1.046 V = 8.7%
    expect(vdropPct(10, 20, '14', 12)).toBeCloseTo(8.72, 1);
  });
  it('sizes by voltage drop for critical circuits', () => {
    const r = sizeConductor({ designAmps: 10, protectAmps: 15, oneWayFt: 20, volts: 12, vdropLimit: 3 });
    // CM = 10.75·10·40 / 0.36 = 11,944 → 8 AWG (16,510 CM)
    expect(r.gauge).toBe('8');
    expect(r.limitedBy).toBe('vdrop');
  });
  it('sizes by ampacity for short heavy runs', () => {
    const r = sizeConductor({ designAmps: 200, protectAmps: 250, oneWayFt: 2, volts: 12, vdropLimit: 3 });
    expect(r.gauge).toBe('1/0');
    expect(r.limitedBy).toBe('ampacity');
  });
});

function errorsOf(d: Design, p: Project) {
  return audit(d, { acVolts: p.profile.acStandard === 'us120' ? 120 : 230 }).filter((f) => f.severity === 'error');
}

describe('ideal designs pass their own audit', () => {
  const p = exampleProject();
  for (const s of p.scenarios) {
    it(`scenario ${s.name}`, () => {
      const d = generateIdeal(p, s);
      expect(d.nodes.length).toBeGreaterThan(20);
      const errs = errorsOf(d, p);
      expect(errs.map((e) => e.message)).toEqual([]);
      expect(d.findings.filter((f) => f.severity === 'error')).toEqual([]);
    });
  }

  it('lithium + external regulator + external BMS + windlass bank + generator + wind', () => {
    const q = exampleProject();
    const eng = q.equipment.find((e) => e.kind === 'engine')!;
    eng.props.regulator = 'external';
    const h = q.equipment.find((e) => e.props.role === 'house')!;
    h.props.chemistry = 'lifepo4';
    h.props.bms = 'external';
    q.equipment.push(newEquipment('battery-bank', { name: 'Bow battery', zone: 'bow', props: { role: 'windlass', chemistry: 'agm', unitVolts: 12, unitAh: 100, units: 1 } }));
    q.equipment.push(newEquipment('generator', {}));
    q.equipment.push(newEquipment('wind', {}));
    q.equipment.push(newEquipment('battery-charger', {}));
    q.equipment.push(newEquipment('air-conditioner', {}));
    const d = generateIdeal(q, { id: 'x', name: 'x', systemVoltage: 24 });
    expect(errorsOf(d, q).map((e) => e.message)).toEqual([]);
    expect(d.nodes.some((n) => n.type === 'apd')).toBe(true);
    expect(d.nodes.some((n) => n.type === 'converter')).toBe(true);
    expect(d.nodes.some((n) => n.type === 'selector')).toBe(true);
  });

  it('24 V halves main currents', () => {
    const d12 = generateIdeal(p, p.scenarios[1]);
    const d24 = generateIdeal(p, p.scenarios[2]);
    const fuse12 = d12.nodes.find((n) => n.id === 'house0-fuse')!.data.rating!;
    const fuse24 = d24.nodes.find((n) => n.id === 'house0-fuse')!.data.rating!;
    expect(fuse24).toBeLessThan(fuse12);
  });

  it('uses DC-DC (not ACR) for lithium house with lead start', () => {
    const d = generateIdeal(p, p.scenarios[1]);
    expect(d.nodes.some((n) => n.type === 'acr')).toBe(false);
    expect(d.nodes.some((n) => n.id === 'alt-dcdc')).toBe(true);
  });
});

describe('audit catches classic mistakes', () => {
  it('flags unfused battery, unprotected load, switched bilge, lithium+lead parallel, AC issues', () => {
    const house = makeNode('battery', 'h', 'House', { data: { chemistry: 'lifepo4' } });
    const start = makeNode('battery', 's', 'Start', { data: { chemistry: 'agm' } });
    const sw = makeNode('switch', 'sw', '1-2-Both');
    const bus = makeNode('bus-pos', 'bus', 'Bus', { extraTerminals: [['s1', 'pos', 'W'], ['s2', 'pos', 'W'], ['s3', 'pos', 'E'], ['s4', 'pos', 'E']] });
    const pump = makeNode('load', 'bp', 'Bilge pump', { data: { kind: 'bilge-pump', amps: 5 } });
    const inlet = makeNode('shore-inlet', 'in', 'Shore');
    const panel = makeNode('ac-panel', 'acp', 'AC panel', { extraTerminals: [['b1', 'ac', 'E']] });
    const d: Design = {
      id: 'x',
      name: 'x',
      systemVoltage: 12,
      nodes: [house, start, sw, bus, pump, inlet, panel],
      findings: [],
      wires: [
        { id: 'w1', kind: 'pos', domain: 'dc', from: { node: 'h', term: 'pos' }, to: { node: 'sw', term: 'in' }, lengthFt: 2, gauge: '2' },
        { id: 'w2', kind: 'pos', domain: 'dc', from: { node: 's', term: 'pos' }, to: { node: 'sw', term: 'in' }, lengthFt: 2, gauge: '2' },
        { id: 'w3', kind: 'pos', domain: 'dc', from: { node: 'sw', term: 'out' }, to: { node: 'bus', term: 's1' }, lengthFt: 2, gauge: '2' },
        { id: 'w4', kind: 'pos', domain: 'dc', from: { node: 'bus', term: 's3' }, to: { node: 'bp', term: 'pos' }, lengthFt: 20, gauge: '16' },
        { id: 'w5', kind: 'ac', domain: 'ac', from: { node: 'in', term: 'l' }, to: { node: 'acp', term: 'in' }, lengthFt: 15, gauge: '10' },
      ],
    };
    const rules = new Set(audit(d).map((f) => f.rule));
    for (const r of ['battery-fuse', 'branch-protection', 'unswitched', 'no-mixed-chemistry', 'neg-return', 'shore-main', 'galvanic-isolator', 'ac-dc-bond']) {
      expect(rules, r).toContain(r);
    }
  });
});

describe('upgrade plan', () => {
  it('lists missing protection and undersized wire when the existing boat deviates', async () => {
    const { changeList } = await import('../src/engine/reports');
    const p = exampleProject();
    const ideal = generateIdeal(p);
    const existing: Design = structuredClone(ideal);
    // remove the galvanic isolator and the house main fuse; undersize the fridge wire
    const drop = new Set(['galv-iso', 'house0-fuse']);
    existing.nodes = existing.nodes.filter((n) => !drop.has(n.id));
    existing.wires = existing.wires.filter((w) => !drop.has(w.from.node) && !drop.has(w.to.node));
    existing.wires.push({ id: 'x1', kind: 'pos', domain: 'dc', from: { node: 'house0-bat', term: 'pos' }, to: { node: 'house-switch', term: 'in' }, lengthFt: 2, gauge: '2/0' });
    const fridge = existing.nodes.find((n) => n.data.kind === 'fridge')!;
    const fw = existing.wires.find((w) => w.to.node === fridge.id && w.kind === 'pos')!;
    fw.gauge = '18';
    const ch = changeList(existing, ideal, 120);
    const text = ch.map((c) => `${c.priority}: ${c.title}`).join('\n');
    expect(text).toMatch(/safety: .*no fuse at the battery/);
    expect(text).toMatch(/Galvanic isolator/);
    expect(text).toMatch(/Refrigerator: upsize wire 18/);
  });
});
