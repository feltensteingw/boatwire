import { describe, expect, it } from 'vitest';
import { exampleProject, newEquipment } from '../src/model/examples';
import { generateIdeal } from '../src/engine/generate';
import { audit } from '../src/engine/audit';
import { allFindings, findingCounts } from '../src/engine/reports';
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

describe('battery isolators', () => {
  const withSplit = (split: string) => {
    const p = exampleProject();
    p.equipment.find((e) => e.kind === 'engine')!.props.chargeSplit = split;
    return p;
  };

  it('FET isolator replaces the ACR for lead-acid banks and passes audit', () => {
    const p = withSplit('isolator-fet');
    const d = generateIdeal(p);
    expect(d.nodes.some((n) => n.type === 'isolator')).toBe(true);
    expect(d.nodes.some((n) => n.type === 'acr')).toBe(false);
    expect(errorsOf(d, p).map((e) => e.message)).toEqual([]);
    expect(d.findings.some((f) => f.rule === 'isolator')).toBe(false);
  });

  const isoWarnings = (d: Design) => [...d.findings, ...audit(d)].filter((f) => f.rule === 'isolator' && f.severity === 'warning');

  it('uncompensated diode isolator with stock regulator warns about voltage drop', () => {
    const p = withSplit('isolator-diode');
    p.equipment.find((e) => e.kind === 'engine')!.props.isolatorSense = 'none';
    const d = generateIdeal(p);
    expect(isoWarnings(d)).toHaveLength(1);
    expect(d.wires.some((w) => w.notes?.includes('isolator-compensation'))).toBe(false);
    expect(errorsOf(d, p)).toEqual([]);
  });

  it('diode isolator defaults to the "E" excitation wire and then does not warn', () => {
    const p = withSplit('isolator-diode');
    delete p.equipment.find((e) => e.kind === 'engine')!.props.isolatorSense; // older projects have no setting
    const d = generateIdeal(p);
    const iso = d.nodes.find((n) => n.type === 'isolator')!;
    expect(iso.data.compensation).toBe('excite');
    expect(iso.terminals.some((t) => t.id === 'exc' && t.pol === 'sig')).toBe(true);
    const ew = d.wires.find((w) => w.kind === 'sig' && w.from.node === iso.id && w.from.term === 'exc')!;
    expect(ew.to).toEqual({ node: 'alternator', term: 'exc' });
    expect(isoWarnings(d)).toEqual([]);
    expect(errorsOf(d, p)).toEqual([]);
  });

  it('diode isolator with the sense lead moved runs alternator sense to the house bus', () => {
    const p = withSplit('isolator-diode');
    p.equipment.find((e) => e.kind === 'engine')!.props.isolatorSense = 'sense';
    const d = generateIdeal(p);
    const sw = d.wires.find((w) => w.kind === 'sig' && w.from.node === 'alternator' && w.from.term === 'sense')!;
    expect(d.nodes.find((n) => n.id === sw.to.node)!.type).toBe('bus-pos');
    expect(d.wires.some((w) => w.to.term === 'exc' || w.from.term === 'exc')).toBe(false);
    expect(isoWarnings(d)).toEqual([]);
    expect(errorsOf(d, p)).toEqual([]);
  });

  it('FET isolator and external regulator get no compensation wire', () => {
    const p = withSplit('isolator-fet');
    expect(generateIdeal(p).wires.some((w) => w.notes?.includes('isolator-compensation'))).toBe(false);
    const q = withSplit('isolator-diode');
    q.equipment.find((e) => e.kind === 'engine')!.props.regulator = 'external';
    const d = generateIdeal(q);
    expect(d.wires.some((w) => w.notes?.includes('isolator-compensation'))).toBe(false);
    expect(isoWarnings(d)).toEqual([]);
  });

  it('audit: a hand-drawn diode isolator is compensated by an E wire, a sense wire or the inspector setting', () => {
    const alt = makeNode('alternator', 'alt', 'Alternator', { data: { amps: 90 } });
    const iso = makeNode('isolator', 'iso', 'Isolator', { data: { isolatorType: 'diode', rating: 120 } });
    const base: Design = { id: 'x', name: 'x', systemVoltage: 12, findings: [], nodes: [alt, iso], wires: [{ id: 'a', kind: 'pos', domain: 'dc', from: { node: 'alt', term: 'b' }, to: { node: 'iso', term: 'in' }, lengthFt: 3, gauge: '4' }] };
    const warns = (d: Design) => audit(d).filter((f) => f.rule === 'isolator');
    expect(warns(base)).toHaveLength(1);

    const byE = structuredClone(base);
    byE.nodes[0].terminals.push({ id: 'exc', pol: 'sig', side: 'N' });
    byE.nodes[1].terminals.push({ id: 'exc', pol: 'sig', side: 'N' });
    byE.wires.push({ id: 'e', kind: 'sig', domain: 'dc', from: { node: 'iso', term: 'exc' }, to: { node: 'alt', term: 'exc' }, lengthFt: 3, gauge: '18' });
    expect(warns(byE)).toEqual([]);

    const bySense = structuredClone(base);
    const bus = makeNode('bus-pos', 'bus', 'Bus');
    bus.terminals.push({ id: 's1', pol: 'sig', side: 'W' });
    bySense.nodes.push(bus);
    bySense.nodes[0].terminals.push({ id: 'sense', pol: 'sig', side: 'N' });
    bySense.wires.push({ id: 's', kind: 'sig', domain: 'dc', from: { node: 'alt', term: 'sense' }, to: { node: 'bus', term: 's1' }, lengthFt: 3, gauge: '18' });
    expect(warns(bySense)).toEqual([]);

    const bySetting = structuredClone(base);
    bySetting.nodes[1].data.compensation = 'excite';
    expect(warns(bySetting)).toEqual([]);
  });

  it('lithium house ignores the isolator choice and keeps the DC-DC charger', () => {
    const p = withSplit('isolator-fet');
    const d = generateIdeal(p, p.scenarios[1]);
    expect(d.nodes.some((n) => n.type === 'isolator')).toBe(false);
    expect(d.nodes.some((n) => n.id === 'alt-dcdc')).toBe(true);
    expect(d.findings.some((f) => f.rule === 'isolator' && f.severity === 'info')).toBe(true);
  });

  it('engine-run charging relay replaces the ACR, is triggered from D+ and passes audit', () => {
    const p = withSplit('relay-run');
    const d = generateIdeal(p);
    const relay = d.nodes.find((n) => n.id === 'acr')!;
    expect(relay.data.trigger).toBe('engine-run');
    expect(relay.notes).toContain('charge-relay');
    expect(d.wires.some((w) => w.kind === 'sig' && w.to.node === 'acr' && w.to.term === 'trig' && w.from.node === 'engine' && w.from.term === 'run')).toBe(true);
    expect(errorsOf(d, p).map((e) => e.message)).toEqual([]);
    expect(d.findings.some((f) => f.rule === 'charge-relay')).toBe(false);
  });

  it('lithium house ignores the charging relay choice', () => {
    const p = withSplit('relay-run');
    const d = generateIdeal(p, p.scenarios[1]);
    expect(d.nodes.some((n) => n.data.trigger === 'engine-run')).toBe(false);
    expect(d.findings.some((f) => f.rule === 'charge-relay' && f.severity === 'info')).toBe(true);
  });

  it('audit: isolator outputs are not "bridged", but feeding lithium is flagged', () => {
    const alt = makeNode('alternator', 'alt', 'Alternator', { data: { amps: 90 } });
    const iso = makeNode('isolator', 'iso', 'Isolator', { data: { isolatorType: 'fet', rating: 120 } });
    const lfp = makeNode('battery', 'h', 'House', { data: { chemistry: 'lifepo4' } });
    const agm = makeNode('battery', 's', 'Start', { data: { chemistry: 'agm' } });
    const f1 = makeNode('fuse', 'f1', 'F1', { data: { rating: 125 } });
    const f2 = makeNode('fuse', 'f2', 'F2', { data: { rating: 125 } });
    const w = (id: string, a: [string, string], b: [string, string]) => ({ id, kind: 'pos' as const, domain: 'dc' as const, from: { node: a[0], term: a[1] }, to: { node: b[0], term: b[1] }, lengthFt: 0.5, gauge: '4' });
    const d: Design = {
      id: 'x', name: 'x', systemVoltage: 12, findings: [],
      nodes: [alt, iso, lfp, agm, f1, f2],
      wires: [w('a', ['alt', 'b'], ['iso', 'in']), w('b', ['iso', 'out1'], ['f1', 'out']), w('c', ['f1', 'in'], ['h', 'pos']), w('d', ['iso', 'out2'], ['f2', 'out']), w('e', ['f2', 'in'], ['s', 'pos'])],
    };
    const rules = audit(d).map((f) => f.rule);
    expect(rules).not.toContain('no-mixed-chemistry');
    expect(rules).toContain('isolator');
    expect(rules).toContain('alternator-lfp');
  });
});

describe('start battery and house bank of different chemistries', () => {
  const boat = (house: string, start: string, engine: Record<string, unknown> = {}) => {
    const p = exampleProject();
    p.equipment.find((e) => e.props.role === 'house')!.props.chemistry = house;
    p.equipment.find((e) => e.props.role === 'start')!.props.chemistry = start;
    Object.assign(p.equipment.find((e) => e.kind === 'engine')!.props, engine);
    return p;
  };
  const relayOrIsolator = (d: Design) => d.nodes.filter((n) => n.type === 'acr' || n.type === 'isolator').map((n) => n.id);
  const wired = (d: Design, from: string, to: string) => d.wires.some((w) => w.from.node === from && w.to.node === to);
  const splitNote = (d: Design) => d.findings.find((f) => f.severity === 'info' && f.message.startsWith('Charge splitting is set to'));

  it('lithium start battery, lead-acid house: the alternator charges the house bank and a DC-DC charger with a lithium profile charges the start battery', () => {
    const p = boat('agm', 'lifepo4');
    const d = generateIdeal(p);
    expect(relayOrIsolator(d)).toEqual([]);
    expect(wired(d, 'alt-fuse', 'pos-bus')).toBe(true);
    expect(wired(d, 'pos-bus', 'start-dcdc-in')).toBe(true);
    expect(wired(d, 'start-dcdc-out', 'start-bus')).toBe(true);
    const dcdc = d.nodes.find((n) => n.id === 'start-dcdc')!;
    expect(dcdc.sublabel).toBe('18 A lithium profile');
    expect(dcdc.data.part).toBe('DC-DC charger 12/12-18, lithium profile');
    expect(errorsOf(d, p).map((e) => e.message)).toEqual([]);
    // the advice to keep the start battery lead-acid stays, and automatic needs no note
    expect(d.findings.some((f) => f.rule === 'alternator-lfp' && f.severity === 'warning')).toBe(true);
    expect(splitNote(d)).toBeUndefined();
  });

  for (const split of ['acr', 'relay-run', 'isolator-fet', 'isolator-diode']) {
    for (const regulator of ['internal', 'external']) {
      it(`lithium start battery: "${split}" with the ${regulator} regulator becomes a DC-DC charger, with a note`, () => {
        const p = boat('agm', 'lifepo4', { chargeSplit: split, regulator });
        const d = generateIdeal(p);
        expect(relayOrIsolator(d)).toEqual([]);
        expect(d.nodes.find((n) => n.id === 'start-dcdc')!.sublabel).toBe('18 A lithium profile');
        expect(splitNote(d)!.message).toContain('the lithium start battery');
        expect(splitNote(d)!.fix).toBe('The design uses a DC-DC charger instead.');
        expect(errorsOf(d, p).map((e) => e.message)).toEqual([]);
      });
    }
  }

  it('lithium house bank: choosing an ACR is noted like the other relay and isolator choices', () => {
    const p = boat('lifepo4', 'agm', { chargeSplit: 'acr' });
    const d = generateIdeal(p);
    expect(relayOrIsolator(d)).toEqual([]);
    expect(splitNote(d)).toMatchObject({ rule: 'acr', fix: 'The design uses a DC-DC charger instead.' });
    expect(splitNote(d)!.message).toContain('the lithium house bank');
  });

  it('lithium house, lead-acid start battery: the DC-DC charger to the start battery names its lead-acid profile', () => {
    const p = boat('lifepo4', 'agm', { regulator: 'external' });
    expect(generateIdeal(p).nodes.find((n) => n.id === 'start-dcdc')!.sublabel).toBe('18 A AGM profile');
    const q = boat('lifepo4', 'flooded', { regulator: 'external' });
    expect(generateIdeal(q).nodes.find((n) => n.id === 'start-dcdc')!.data.part).toBe('DC-DC charger 12/12-18, flooded profile');
  });

  it('the DC-DC charger for the start battery draws no more than the alternator makes', () => {
    const size = (V: 12 | 24, alternatorAmps: number) => {
      const d = generateIdeal(boat('agm', 'lifepo4', { alternatorAmps }), { id: 'x', name: 'x', systemVoltage: V });
      const note = d.findings.find((f) => f.rule === 'dcdc');
      return `${d.nodes.find((n) => n.id === 'start-dcdc')!.data.rating} A${note ? ' + note' : ''}`;
    };
    expect(size(12, 90)).toBe('18 A');
    expect(size(12, 21)).toBe('18 A'); // draws 20.7 A
    expect(size(12, 20)).toBe('10 A');
    expect(size(12, 11)).toBe('10 A + note'); // the smallest draws 11.5 A
    expect(size(24, 90)).toBe('12 A'); // 45 A at 24 V
    expect(size(24, 20)).toBe('12 A + note'); // 10 A at 24 V
  });

  it('both batteries lithium, stock regulator: the alternator is not wired to the start battery, and the design asks for an external regulator', () => {
    const p = boat('lifepo4', 'lifepo4');
    const d = generateIdeal(p);
    expect(d.nodes.some((n) => n.id === 'alt-dcdc')).toBe(false);
    expect(wired(d, 'alt-fuse', 'pos-bus')).toBe(true);
    expect(d.nodes.some((n) => n.type === 'regulator')).toBe(true);
    expect(d.nodes.some((n) => n.type === 'apd')).toBe(true);
    expect(d.nodes.find((n) => n.id === 'start-dcdc')!.sublabel).toBe('18 A lithium profile');
    const err = d.findings.filter((f) => f.severity === 'error');
    expect(err.map((f) => f.rule)).toEqual(['alternator-lfp']);
    expect(err[0].message).toContain('lithium start battery');
    expect(err[0].fix).toContain('Make the start battery lead-acid');
    expect(errorsOf(d, p).map((e) => e.message)).toEqual([]);
  });

  it('both batteries lithium, external regulator: no error', () => {
    const p = boat('lifepo4', 'lifepo4', { regulator: 'external' });
    const d = generateIdeal(p);
    expect(d.findings.filter((f) => f.severity === 'error')).toEqual([]);
    expect(errorsOf(d, p).map((e) => e.message)).toEqual([]);
  });

  it('with a lithium battery on either side, no design uses a relay or isolator, and every one passes its own check', () => {
    for (const [house, start] of [['agm', 'lifepo4'], ['lifepo4', 'agm'], ['lifepo4', 'lifepo4']])
      for (const chargeSplit of ['auto', 'acr', 'relay-run', 'isolator-fet', 'isolator-diode'])
        for (const regulator of ['internal', 'external'])
          for (const V of [12, 24] as const) {
            const p = boat(house, start, { chargeSplit, regulator });
            const d = generateIdeal(p, { id: 'x', name: 'x', systemVoltage: V });
            const what = `${house} house, ${start} start, ${chargeSplit}, ${regulator}, ${V} V`;
            expect(relayOrIsolator(d), what).toEqual([]);
            // only the all-lithium boat with a stock regulator cannot be built as asked, and says so
            const own = d.findings.filter((f) => f.severity === 'error').map((f) => f.rule);
            expect(own, what).toEqual(house === 'lifepo4' && start === 'lifepo4' && regulator === 'internal' ? ['alternator-lfp'] : []);
            expect(errorsOf(d, p).map((e) => e.message), what).toEqual([]);
          }
  });
});

describe('dedicated batteries for high-draw equipment', () => {
  const withBank = (role: string, zone: string, extra: string[] = []) => {
    const p = exampleProject();
    p.equipment.push(newEquipment('battery-bank', { name: `${role} battery`, zone, props: { role, chemistry: 'agm', unitVolts: 12, unitAh: 100, units: 1 } }));
    for (const k of extra) p.equipment.push(newEquipment(k as never, {}));
    return p;
  };
  const feeds = (d: Design, from: string, to: string) => d.wires.some((w) => w.from.node === from && w.to.node === to);

  it('refrigeration bank powers the fridge through a relay switched from the house panel', () => {
    const p = withBank('fridge', 'galley');
    const d = generateIdeal(p);
    expect(errorsOf(d, p).map((e) => e.message)).toEqual([]);
    const fridge = p.equipment.find((e) => e.kind === 'fridge')!;
    const load = d.nodes.find((n) => n.id === `ld-${fridge.id}`)!;
    const relay = d.nodes.find((n) => n.id === `cont-${fridge.id}`)!;
    expect(relay.type).toBe('contactor');
    // power: fridge bank bus → fuse → relay → fridge
    expect(feeds(d, 'fr-bus', `prot-${fridge.id}`)).toBe(true);
    expect(feeds(d, `prot-${fridge.id}`, relay.id)).toBe(true);
    expect(feeds(d, relay.id, load.id)).toBe(true);
    // it is no longer a branch circuit on the house panel …
    expect(d.wires.some((w) => w.from.node === 'dc-panel' && w.to.node === load.id)).toBe(false);
    // … but the panel powers the relay coil
    const ctl = d.wires.find((w) => w.from.node === 'dc-panel' && w.to.node === relay.id)!;
    expect(ctl.kind).toBe('sig');
    expect(ctl.to.term).toBe('coil');
    // bank recharged from house by DC-DC
    expect(d.nodes.some((n) => n.id === 'fr-dcdc' && n.type === 'dcdc')).toBe(true);
  });

  it('windlass bank: motor fed from the bow battery, helm switch powered from the house panel', () => {
    const p = withBank('windlass', 'bow');
    const d = generateIdeal(p);
    expect(errorsOf(d, p).map((e) => e.message)).toEqual([]);
    const wl = p.equipment.find((e) => e.kind === 'windlass')!;
    expect(feeds(d, 'wl-bus', `prot-${wl.id}`)).toBe(true);
    const helm = d.nodes.find((n) => n.id === `helm-${wl.id}`)!;
    expect(helm.terminals.some((t) => t.id === 'in')).toBe(true);
    expect(d.wires.some((w) => w.from.node === 'dc-panel' && w.to.node === helm.id && w.to.term === 'in')).toBe(true);
    // the bank fuse is sized from the load it serves and never smaller than the windlass protection
    const bankFuse = d.nodes.find((n) => n.id === 'wl-fuse')!.data.rating!;
    const motorProt = d.nodes.find((n) => n.id === `prot-${wl.id}`)!.data.rating!;
    expect(bankFuse).toBeGreaterThanOrEqual(motorProt);
    // without the bank the windlass is wired from the house bus
    const plain = generateIdeal(exampleProject());
    const wl2 = plain.nodes.find((n) => n.data.kind === 'windlass')!;
    expect(plain.wires.some((w) => w.from.node === 'pos-bus' && w.to.node === wl2.id.replace('ld-', 'prot-'))).toBe(true);
  });

  it('winch bank powers an electric winch', () => {
    const p = withBank('winch', 'cockpit', ['electric-winch']);
    const d = generateIdeal(p);
    expect(errorsOf(d, p).map((e) => e.message)).toEqual([]);
    const w = p.equipment.find((e) => e.kind === 'electric-winch')!;
    expect(feeds(d, 'wn-bus', `prot-${w.id}`)).toBe(true);
  });

  it('notes a dedicated bank with nothing to power', () => {
    const p = withBank('thruster', 'bow');
    const d = generateIdeal(p);
    expect(d.findings.some((f) => f.rule === 'dedicated-bank')).toBe(true);
  });

  it('every scenario still passes its audit with fridge + windlass banks', () => {
    const p = withBank('fridge', 'galley');
    p.equipment.push(newEquipment('battery-bank', { name: 'Bow battery', zone: 'bow', props: { role: 'windlass', chemistry: 'lifepo4', unitVolts: 12, unitAh: 100, units: 2 } }));
    for (const s of p.scenarios) {
      const d = generateIdeal(p, s);
      expect(errorsOf(d, p).map((e) => e.message), s.name).toEqual([]);
    }
  });
});

describe('findingCounts', () => {
  it('tallies findings by severity', () => {
    const f = (severity: 'error' | 'warning' | 'info', id: string) => ({ id, rule: 'battery-fuse', severity, message: id });
    expect(findingCounts([f('error', 'a'), f('warning', 'b'), f('warning', 'c'), f('info', 'd')])).toEqual({ errors: 1, warnings: 2, notes: 1 });
    expect(findingCounts([])).toEqual({ errors: 0, warnings: 0, notes: 0 });
  });
  it('reports no errors for the example ideal design', () => {
    const p = exampleProject();
    const d = generateIdeal(p);
    expect(findingCounts(allFindings(d, 120)).errors).toBe(0);
  });
});
