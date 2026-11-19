import { describe, expect, it } from 'vitest';
import { audit } from '../src/engine/audit';
import { designCost } from '../src/engine/cost';
import { energyBudget } from '../src/engine/energy';
import { existingFromEquipment, existingFromIdeal } from '../src/engine/existing';
import { generateIdeal } from '../src/engine/generate';
import { buildGraph, key, walk } from '../src/engine/graph';
import { billOfMaterials, designMetrics } from '../src/engine/reports';
import { exampleProject, newEquipment } from '../src/model/examples';
import { growTerminal, makeNode } from '../src/model/nodeDefs';
import type { Design, Project, PropValue } from '../src/model/types';
import { stableIds } from './sampleBoats';

// Twin-engine boats: each engine drawn with its own starter cable and alternator, start batteries
// as the equipment list has them, and everything downstream counting both.

const start = (name: string, props: Record<string, PropValue> = {}) => newEquipment('battery-bank', { name, props: { role: 'start', chemistry: 'agm', unitVolts: 12, unitAh: 90, units: 1, ...props } });

/** The example boat with a second engine, and its start batteries: 'each' (two), 'shared' (one) or 'none'. */
function twin(starts: 'each' | 'shared' | 'none', o: { port?: Record<string, PropValue>; starboard?: Record<string, PropValue>; portStart?: Record<string, PropValue> } = {}): Project {
  const p = exampleProject();
  const stbd = p.equipment.find((e) => e.kind === 'engine')!;
  stbd.name = 'Starboard engine';
  Object.assign(stbd.props, o.starboard);
  p.equipment.push(newEquipment('engine', { name: 'Port engine', props: o.port }));
  if (starts === 'none') p.equipment = p.equipment.filter((e) => e.props.role !== 'start');
  if (starts === 'each') {
    p.equipment.find((e) => e.props.role === 'start')!.name = 'Starboard start battery';
    p.equipment.push(start('Port start battery', o.portStart));
  }
  return stableIds(p);
}

const node = (d: Design, id: string) => d.nodes.find((n) => n.id === id);
const ids = (d: Design) => d.nodes.map((n) => n.id);
const errorsOf = (d: Design) => audit(d, { acVolts: 120 }).filter((f) => f.severity === 'error').map((f) => `${f.rule}: ${f.message}`);
/** Wires between two components, either way round. */
const between = (d: Design, a: string, b: string) => d.wires.filter((w) => (w.from.node === a && w.to.node === b) || (w.from.node === b && w.to.node === a));

describe('twin engines: ids and roles', () => {
  it('keeps the first engine on the ids a single engine has, and gives the second "-2" ids', () => {
    const one = generateIdeal(stableIds(exampleProject()));
    const d = generateIdeal(twin('each'));
    for (const id of ['engine', 'start-bat', 'start-fuse', 'start-switch', 'start-bus', 'alternator', 'alt-fuse', 'acr', 'acr-fuse-house', 'acr-fuse-start']) {
      expect(ids(one), id).toContain(id);
      expect(ids(d), id).toContain(id);
      expect(ids(d), `${id}-2`).toContain(`${id}-2`);
    }
    expect(ids(d)).toContain('start-parallel');
  });

  it('gives every part a role equal to its id, so "Start from the ideal design" copies distinct roles', () => {
    for (const starts of ['each', 'shared', 'none'] as const) {
      const d = generateIdeal(twin(starts));
      expect(d.nodes.filter((n) => n.role !== n.id).map((n) => n.id), starts).toEqual([]);
      const copy = existingFromIdeal(d, {});
      expect(new Set(copy.nodes.map((n) => n.role)).size, starts).toBe(copy.nodes.length);
    }
  });

  it('numbers the parts of each engine in their labels, and only on a twin-engine boat', () => {
    const d = generateIdeal(twin('each'));
    expect(node(d, 'alternator')!.label).toBe('Alternator 1');
    expect(node(d, 'alternator-2')!.label).toBe('Alternator 2');
    expect(node(d, 'start-fuse-2')!.label).toBe('Start battery 2 fuse');
    expect(node(d, 'engine-2')!.sublabel).toBe('Engine 2 · Starter ~150 A');
    // alternators are drawn far from their engines, so each names its engine
    expect(node(d, 'alternator-2')!.sublabel).toBe('Port engine · 90 A');
    const one = generateIdeal(stableIds(exampleProject()));
    expect(node(one, 'alternator')!.label).toBe('Alternator');
    expect(node(one, 'alternator')!.sublabel).toBe('90 A');
    expect(node(one, 'engine')!.sublabel).toBe('Starter ~150 A');
  });

  it('labels a shared start battery\'s parts without a number', () => {
    const d = generateIdeal(twin('shared'));
    expect(['start-fuse', 'start-switch', 'start-bus'].map((id) => node(d, id)!.label)).toEqual(['Start battery fuse', 'Start battery switch', 'Start positive bus']);
  });
});

describe('twin engines: start batteries', () => {
  it('a start battery each: each engine cranks from its own, through its own fuse', () => {
    const d = generateIdeal(twin('each'));
    expect(between(d, 'start-bus', 'engine')).toHaveLength(1);
    expect(between(d, 'start-bus-2', 'engine-2')).toHaveLength(1);
    expect(between(d, 'start-bus', 'engine-2')).toHaveLength(0);
    expect(between(d, 'start-bus-2', 'engine-2')[0].protectedBy).toBe('start-fuse-2');
    expect(errorsOf(d)).toEqual([]);
  });

  it('a start battery each: a normally-off emergency parallel switch between them, sized like the start cables', () => {
    const d = generateIdeal(twin('each', { port: { starterAmps: 200 } }));
    const sw = node(d, 'start-parallel')!;
    expect(sw.type).toBe('switch');
    expect(sw.sublabel).toBe('Normally off');
    const [a, b] = [between(d, 'start-bus', 'start-parallel')[0], between(d, 'start-parallel', 'start-bus-2')[0]];
    expect([a.protectedBy, b.protectedBy]).toEqual(['start-fuse', 'start-fuse-2']);
    expect(a.amps).toBe(200);
    // the larger of the two start cables
    const cable2 = between(d, 'start-bat-2', 'start-fuse-2')[0].gauge;
    expect(cable2).not.toBe(between(d, 'start-bat', 'start-fuse')[0].gauge);
    expect([a.gauge, b.gauge]).toEqual([cable2, cable2]);
    expect(a.notes).toContain('starter-exempt');
  });

  it('leaves the parallel switch out between lithium and lead-acid, and says why', () => {
    const d = generateIdeal(twin('each', { portStart: { chemistry: 'lifepo4' } }));
    expect(node(d, 'start-parallel')).toBeUndefined();
    const f = d.findings.find((x) => x.rule === 'twin-engines' && x.message.startsWith('No emergency parallel switch'));
    expect(f?.message).toBe('No emergency parallel switch: Port start battery is lithium and Starboard start battery lead-acid, and they must never be connected directly, so neither battery can start the other engine if one goes flat.');
    expect(f?.fix).toBe('Use the same chemistry for both start batteries to get the emergency parallel switch.');
    // the lithium battery's own warning names it
    expect(d.findings.filter((x) => x.rule === 'alternator-lfp').map((x) => x.message)).toEqual(['Port start battery is lithium: most designs keep the start battery lead-acid so the alternator always has a battery it cannot be disconnected from.']);
    // the lithium one is charged through its own DC-DC charger; the lead-acid one keeps its relay
    expect(ids(d)).toEqual(expect.arrayContaining(['start-dcdc-2', 'acr']));
    expect(ids(d)).not.toContain('start-dcdc');
    expect(ids(d)).not.toContain('acr-2');
    expect(errorsOf(d)).toEqual([]);
  });

  it('keeps the parallel switch between two start batteries of one chemistry, lithium too', () => {
    const p = twin('each', { portStart: { chemistry: 'lifepo4' } });
    p.equipment.find((e) => e.name === 'Starboard start battery')!.props.chemistry = 'lifepo4';
    expect(node(generateIdeal(p), 'start-parallel')).toBeDefined();
    expect(node(generateIdeal(twin('each', { portStart: { chemistry: 'flooded' } })), 'start-parallel')).toBeDefined();
  });

  it('one start battery: both engines crank from it, and it is sized for the larger starter over the longer run', () => {
    const p = twin('shared', { port: { starterAmps: 200 } });
    p.equipment.find((e) => e.name === 'Port engine')!.zone = 'aft';
    const d = generateIdeal(p);
    expect(between(d, 'start-bus', 'engine')).toHaveLength(1);
    expect(between(d, 'start-bus', 'engine-2')).toHaveLength(1);
    expect(between(d, 'start-bat', 'engine-2').map((w) => w.kind)).toEqual(['neg']);
    expect(node(d, 'start-fuse')!.data.rating).toBe(300); // largest terminal fuse; 2 × 200 A is beyond it
    expect(between(d, 'start-bat', 'start-fuse')[0].amps).toBe(200);
    // the same cable on every leg, the one sized for the larger starter and the longer run
    const gauges = new Set([...between(d, 'start-bat', 'start-fuse'), ...between(d, 'start-bus', 'engine'), ...between(d, 'start-bus', 'engine-2')].map((w) => w.gauge));
    expect(gauges.size).toBe(1);
    const alone = generateIdeal(stableIds(exampleProject()));
    expect(between(alone, 'start-bat', 'start-fuse')[0].gauge).not.toBe([...gauges][0]);
    expect(ids(d)).not.toContain('start-parallel');
    // (the battery itself is the one in the equipment list: only its fuse and cables are sized)
    expect(d.findings.find((f) => f.rule === 'twin-engines')?.message).toBe('Both engines start from Start battery. Its fuse and cables are sized for one starter at a time, so start the engines one after the other.');
  });

  it('no start battery: each engine has its own start switch from the house bank, and one note says so', () => {
    const d = generateIdeal(twin('none'));
    expect(ids(d)).toEqual(expect.arrayContaining(['engine-switch', 'engine-switch-2']));
    const notes = d.findings.filter((f) => f.rule === 'house-start-split');
    expect(notes.map((f) => f.message)).toEqual(['No dedicated start battery: both engines start from the house bank.']);
    expect(errorsOf(d)).toEqual([]);
  });

  it('gives each engine its own negative to the main negative bus', () => {
    for (const starts of ['each', 'shared', 'none'] as const) {
      const d = generateIdeal(twin(starts));
      expect(between(d, 'engine', 'neg-bus'), starts).toHaveLength(1);
      expect(between(d, 'engine-2', 'neg-bus'), starts).toHaveLength(1);
    }
  });
});

describe('twin engines: alternators', () => {
  it('never joins two alternators onto one cable: each has its own fuse', () => {
    for (const starts of ['each', 'shared', 'none'] as const) {
      for (const split of ['auto', 'isolator-fet', 'isolator-diode', 'relay-run']) {
        const d = generateIdeal(twin(starts, { port: { chargeSplit: split }, starboard: { chargeSplit: split } }));
        const g = buildGraph(d);
        // walk out from each alternator until the first fuse or isolator: the two never meet
        const reach = (id: string) => new Set(walk(g, { node: id, term: 'b' }, ['pos'], { stopAtSwitch: true }).flatMap((r) => r.via.slice(0, 1)));
        const [a, b] = [reach('alternator'), reach('alternator-2')];
        expect(a.size && b.size, `${starts} ${split}`).toBeTruthy();
        expect([...a].filter((x) => b.has(x)), `${starts} ${split}`).toEqual([]);
        expect(d.wires.filter((w) => [w.from.node, w.to.node].includes('alternator') && [w.from.node, w.to.node].includes('alternator-2')), `${starts} ${split}`).toEqual([]);
      }
    }
  });

  it('sizes each alternator cable and fuse for its own output', () => {
    const d = generateIdeal(twin('shared', { port: { alternatorAmps: 150 } }));
    expect(node(d, 'alternator')!.data.amps).toBe(90);
    expect(node(d, 'alternator-2')!.data.amps).toBe(150);
    expect(node(d, 'alt-fuse')!.data.rating).toBe(125);
    expect(node(d, 'alt-fuse-2')!.data.rating).toBe(200);
    expect(g(d, 'alternator', 'b').gauge).not.toBe(g(d, 'alternator-2', 'b').gauge);
  });

  it('sizes the main fuse for every charging source at once, both alternators included', () => {
    for (const starts of ['each', 'shared', 'none'] as const) {
      const p = twin(starts, { port: { alternatorAmps: 150 } });
      const d = generateIdeal(p);
      const charging = 80 + 400 / 12 + 90 + 150; // inverter/charger, solar, both alternators
      expect(node(d, 'house0-fuse')!.data.rating as number, starts).toBeGreaterThanOrEqual(1.25 * charging);
      expect(d.wires[0].amps, starts).toBeCloseTo(charging, 1);
    }
  });

  it('draws one charging relay per start battery: one each with a start battery each', () => {
    const d = generateIdeal(twin('each', { port: { chargeSplit: 'relay-run' }, starboard: { chargeSplit: 'relay-run' } }));
    expect(d.nodes.filter((n) => n.type === 'acr').map((n) => n.id)).toEqual(['acr', 'acr-2']);
    // each engine-run relay closes on its own engine's D+
    expect(between(d, 'engine', 'acr').map((w) => w.to.term)).toEqual(['trig']);
    expect(between(d, 'engine-2', 'acr-2').map((w) => w.to.term)).toEqual(['trig']);
    expect(between(d, 'engine', 'acr-2')).toEqual([]);
  });

  it('draws one charging relay for a shared start battery, sized for the larger alternator', () => {
    const d = generateIdeal(twin('shared', { port: { alternatorAmps: 150 } }));
    const relays = d.nodes.filter((n) => n.type === 'acr');
    expect(relays.map((n) => n.id)).toEqual(['acr']);
    expect(relays[0].data.rating).toBe(500); // above 100 A
    expect(node(d, 'acr-fuse-house')!.data.rating).toBe(200); // 1.25 × 150 A
    expect(between(d, 'acr-fuse-start', 'start-bus')[0].amps).toBe(150);
    expect(errorsOf(d)).toEqual([]);
  });

  it('makes a shared relay voltage-sensing when an engine-run relay was chosen, and says why', () => {
    const d = generateIdeal(twin('shared', { port: { chargeSplit: 'relay-run' } }));
    const relay = node(d, 'acr')!;
    expect(relay.label).toBe('Automatic charging relay');
    expect(relay.data.trigger).toBeUndefined();
    expect(d.wires.filter((w) => w.to.node === 'acr' && w.to.term === 'trig')).toEqual([]);
    expect(d.findings.find((f) => f.rule === 'twin-engines' && f.message.includes('voltage-sensing'))?.message).toBe('Both engines share Start battery, so one voltage-sensing charging relay is used: it closes when either engine is charging.');
  });

  it('draws the house → start DC-DC charger once per start battery', () => {
    // lead-acid house, lithium start battery: charged from the house bank through a DC-DC charger
    const shared = twin('shared');
    shared.equipment.find((e) => e.props.role === 'start')!.props.chemistry = 'lifepo4';
    expect(generateIdeal(shared).nodes.filter((n) => n.type === 'dcdc').map((n) => n.id)).toEqual(['start-dcdc']);
    const each = twin('each', { portStart: { chemistry: 'lifepo4' } });
    each.equipment.find((e) => e.name === 'Starboard start battery')!.props.chemistry = 'lifepo4';
    expect(generateIdeal(each).nodes.filter((n) => n.type === 'dcdc').map((n) => n.id)).toEqual(['start-dcdc', 'start-dcdc-2']);
  });

  it('gives each alternator its own DC-DC charger on a lithium house bank', () => {
    const p = twin('each');
    const d = generateIdeal(p, p.scenarios.find((s) => s.id === 'lfp12'));
    expect(d.nodes.filter((n) => n.type === 'dcdc').map((n) => n.id)).toEqual(['alt-dcdc', 'alt-dcdc-2']);
    expect(between(d, 'alt-fuse-2', 'start-bus-2')).toHaveLength(1);
    expect(node(d, 'start-parallel')).toBeDefined();
    expect(errorsOf(d)).toEqual([]);
  });

  it('numbers two engines of the same name in their findings, so neither is dropped as a repeat', () => {
    const p = exampleProject();
    p.equipment = p.equipment.filter((e) => e.kind !== 'engine' && e.props.role !== 'start');
    p.equipment.push(newEquipment('engine'), newEquipment('engine'));
    const d = generateIdeal(stableIds(p), p.scenarios.find((s) => s.id === 'lfp12'));
    expect(d.findings.filter((f) => f.rule === 'alternator-lfp').map((f) => f.message)).toEqual([
      'Engine 1: Lithium house bank with the alternator wired to it but no start battery and a stock regulator.',
      'Engine 2: Lithium house bank with the alternator wired to it but no start battery and a stock regulator.',
    ]);
    expect(node(d, 'alternator-2')!.sublabel).toBe('Engine 2 · 90 A');
    // two start batteries of the same name, both lithium: each has its own warning
    const q = twin('each', { portStart: { chemistry: 'lifepo4' } });
    for (const e of q.equipment.filter((x) => x.props.role === 'start')) Object.assign(e, { name: 'Start battery', props: { ...e.props, chemistry: 'lifepo4' } });
    expect(generateIdeal(q).findings.filter((f) => f.rule === 'alternator-lfp').map((f) => f.message.split(':')[0])).toEqual(['Start battery 1 is lithium', 'Start battery 2 is lithium']);
  });

  it("names the engine in each engine's findings, so neither is dropped as a repeat", () => {
    const d = generateIdeal(twin('none', { port: { chargeSplit: 'isolator-fet' }, starboard: { chargeSplit: 'isolator-fet' } }));
    expect(d.findings.filter((f) => f.rule === 'isolator').map((f) => f.message)).toEqual([
      'Starboard engine: Charge splitting is set to a battery isolator, but there is only one battery bank, so no isolator is needed.',
      'Port engine: Charge splitting is set to a battery isolator, but there is only one battery bank, so no isolator is needed.',
    ]);
    // a single engine's note is unchanged
    const one = stableIds(exampleProject());
    one.equipment = one.equipment.filter((e) => e.props.role !== 'start');
    one.equipment.find((e) => e.kind === 'engine')!.props.chargeSplit = 'isolator-fet';
    expect(generateIdeal(one).findings.filter((f) => f.rule === 'isolator').map((f) => f.message)).toEqual(['Charge splitting is set to a battery isolator, but there is only one battery bank, so no isolator is needed.']);
  });

  it('feeds a second start battery from a three-output charger', () => {
    const p = twin('each');
    p.equipment = p.equipment.filter((e) => e.kind !== 'inverter-charger');
    p.equipment.push(newEquipment('battery-charger', { name: 'Charger', props: { amps: 40, outputs: 3 } }));
    const d = generateIdeal(stableIds(p));
    const chg = d.nodes.find((n) => n.type === 'charger')!;
    expect(chg.terminals.map((t) => t.id)).toEqual(expect.arrayContaining(['out1', 'out2', 'out3']));
    expect(between(d, `chgfuse2-${chg.equipmentId}`, 'start-bus')).toHaveLength(1);
    expect(between(d, `chgfuse3-${chg.equipmentId}`, 'start-bus-2')).toHaveLength(1);
    expect(node(d, `chgfuse3-${chg.equipmentId}`)!.label).toBe('Charger start 2 output fuse');
    expect(errorsOf(d)).toEqual([]);
  });

  it('the check expects a fuse on a charger\'s third output', () => {
    const chg = makeNode('charger', 'chg', 'Charger', { data: { amps: 40 } });
    chg.terminals.push({ id: 'out3', pol: 'pos', side: 'E', label: 'OUT3+' });
    const bat = makeNode('battery', 'bat', 'Port start battery', { data: { chemistry: 'agm' } });
    const d: Design = { id: 'existing', name: 'Existing', systemVoltage: 12, nodes: [chg, bat], findings: [], wires: [{ id: 'w1', kind: 'pos', domain: 'dc', from: { node: 'chg', term: 'out3' }, to: { node: 'bat', term: 'pos' }, lengthFt: 3, gauge: '10' }] };
    expect(audit(d).filter((f) => f.rule === 'charging-source-fuse').map((f) => f.nodes)).toEqual([['chg']]);
  });
});

describe('twin engines: the check', () => {
  it('names the alternator when one of two charges lithium unprotected', () => {
    const p = twin('each');
    const d = generateIdeal(p, p.scenarios.find((s) => s.id === 'lfp12'));
    // wire engine 2's alternator fuse to the lithium house bus instead of its start battery
    const cut: Design = { ...d, wires: d.wires.filter((w) => !(w.from.node === 'alt-fuse-2' && w.to.node === 'start-bus-2')) };
    cut.wires.push({ ...between(d, 'alt-fuse-2', 'start-bus-2')[0], id: 'wx', to: { node: 'pos-bus', term: growTerminal(node(d, 'pos-bus')!) } });
    expect(audit(cut, { acVolts: 120 }).filter((f) => f.rule === 'alternator-lfp').map((f) => f.message)).toEqual(['Alternator 2: The alternator charges a lithium bank directly without an external regulator and alternator protection device.']);
  });

  it("does not let one engine's external regulator hide the other engine's uncompensated diode isolator", () => {
    const d = generateIdeal(twin('each', { starboard: { regulator: 'external' }, port: { chargeSplit: 'isolator-diode', isolatorSense: 'none' } }));
    expect(audit(d, { acVolts: 120 }).filter((f) => f.rule === 'isolator').map((f) => f.nodes)).toEqual([['alt-isolator-2']]);
  });

  it('passes every twin-engine arrangement', () => {
    for (const starts of ['each', 'shared', 'none'] as const) {
      for (const split of ['auto', 'acr', 'relay-run', 'isolator-fet', 'isolator-diode']) {
        for (const regulator of ['internal', 'external']) {
          const p = twin(starts, { port: { chargeSplit: split, regulator } });
          for (const s of p.scenarios) {
            const d = generateIdeal(p, s);
            if (d.findings.some((f) => f.severity === 'error')) continue; // the generator reports these itself
            expect(errorsOf(d), `${starts} ${split} ${regulator} ${s.name}`).toEqual([]);
          }
        }
      }
    }
  });
});

describe('twin engines: downstream', () => {
  it('the energy budget adds both alternators', () => {
    const one = energyBudget(exampleProject());
    expect(one.alternatorAmps).toBe(90);
    expect(one.alternators).toBe(1);
    const both = energyBudget(twin('each', { port: { alternatorAmps: 60 } }));
    expect(both.alternatorAmps).toBe(150);
    expect(both.alternators).toBe(2);
    const p = twin('each', { port: { alternatorAmps: 60 } });
    expect(energyBudget(p, { id: 'v24', name: '24 V', systemVoltage: 24 }).alternatorAmps).toBe(75);
    // a third engine is not drawn, so it does not charge
    p.equipment.push(newEquipment('engine', { name: 'Wing engine' }));
    expect(energyBudget(p).alternatorAmps).toBe(150);
  });

  it('"Start from my equipment list" places both engines', () => {
    const d = existingFromEquipment(twin('each'));
    expect(d.nodes.filter((n) => n.type === 'engine').map((n) => n.label)).toEqual(['Starboard engine', 'Port engine']);
  });

  it('the bill of materials and cost count both alternators and the parallel switch', () => {
    const d = generateIdeal(twin('each'));
    const bom = billOfMaterials(d);
    expect(bom.find((r) => r.item === 'Alternator' && r.spec === '90 A alternator')?.qty).toBe(2);
    const sw = bom.find((r) => r.item === 'Battery switch' && r.spec.includes('emergency parallel'));
    expect(sw?.priceKey).toBe('part:switch');
    expect(designCost(d).unpriced).toBe(designCost(generateIdeal(stableIds(exampleProject()))).unpriced);
  });

  it('Compare works for every scenario of a twin-engine boat', () => {
    const p = twin('each');
    for (const s of p.scenarios) {
      const d = generateIdeal(p, s);
      expect(d.nodes.filter((n) => n.type === 'alternator'), s.name).toHaveLength(2);
      const m = designMetrics(d, 120);
      expect(m.errors, s.name).toBe(designMetrics(generateIdeal(stableIds(exampleProject()), s), 120).errors);
      expect(m.roles.has('Alternator')).toBe(true);
    }
  });
});

/** The power wire at a component's terminal. */
function g(d: Design, id: string, term: string) {
  const graph = buildGraph(d);
  return graph.at.get(key(id, term))!.find((w) => w.kind === 'pos')!;
}
