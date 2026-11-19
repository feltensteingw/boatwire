import { describe, expect, it } from 'vitest';
import { audit } from '../src/engine/audit';
import { designCost } from '../src/engine/cost';
import { removeItems } from '../src/engine/drawing';
import { acVolts, energyBudget } from '../src/engine/energy';
import { existingFromEquipment, existingFromIdeal } from '../src/engine/existing';
import { generateIdeal } from '../src/engine/generate';
import { billOfMaterials, changeList, designMetrics } from '../src/engine/reports';
import { exampleProject, newEquipment } from '../src/model/examples';
import type { Design, Project } from '../src/model/types';

// A boat with two shore inlets. Each inlet has its own main breaker with ELCI and its own galvanic
// isolator, sized for that inlet; one source selector lets one of them at a time feed the AC side.

/** The example boat (a 30 A inlet in the cockpit) with a second inlet, 50 A at the bow unless asked otherwise. */
function twoInlets(amps = 50, base: Project = exampleProject()): Project {
  base.equipment.push(newEquipment('shore-power', { name: 'Bow shore inlet', zone: 'bow', props: { amps } }));
  return base;
}
const withGenerator = (p: Project) => (p.equipment.push(newEquipment('generator', { name: 'Genset' })), p);
const node = (d: Design, id: string) => {
  const n = d.nodes.find((x) => x.id === id);
  if (!n) throw new Error(`no ${id} in the design`);
  return n;
};
/** The wire arriving at a terminal. */
const into = (d: Design, id: string, term: string) => d.wires.find((w) => w.to.node === id && w.to.term === term);
const errors = (d: Design, p: Project) => audit(d, { acVolts: acVolts(p), units: p.profile.units }).filter((f) => f.severity === 'error');
const inletCable = (d: Design, sfx = '') => into(d, `shore-elci${sfx}`, 'in')!.gauge;

describe('two shore inlets', () => {
  it('draws both, each with its own main breaker and galvanic isolator, and no "not in this design"', () => {
    const p = twoInlets();
    const bow = p.equipment.find((e) => e.name === 'Bow shore inlet')!;
    const d = generateIdeal(p);
    expect(d.findings.filter((f) => f.rule === 'not-drawn')).toEqual([]);
    for (const id of ['shore-inlet', 'shore-elci', 'galv-iso', 'shore-inlet-2', 'shore-elci-2', 'galv-iso-2']) expect(node(d, id).role).toBe(id);
    expect(node(d, 'shore-inlet-2').equipmentId).toBe(bow.id);
    expect(node(d, 'shore-elci').label).toBe('Shore 1 main breaker + ELCI');
    expect(node(d, 'shore-elci-2').label).toBe('Shore 2 main breaker + ELCI');
    expect(node(d, 'galv-iso').label).toBe('Galvanic isolator 1');
    expect(node(d, 'galv-iso-2').label).toBe('Galvanic isolator 2');
    // the isolator sits in its own inlet's green conductor
    expect(into(d, 'galv-iso-2', 'a')!.from).toEqual({ node: 'shore-inlet-2', term: 'g' });
  });

  it("sizes each inlet's breaker, isolator, cable and green conductor for that inlet alone", () => {
    const d = generateIdeal(twoInlets());
    expect([node(d, 'shore-elci').data.rating, node(d, 'shore-elci-2').data.rating]).toEqual([30, 50]);
    expect([node(d, 'galv-iso').data.rating, node(d, 'galv-iso-2').data.rating]).toEqual([30, 50]);
    expect(node(d, 'shore-elci-2').data.part).toBe('50 A double-pole main breaker with ELCI');

    // each cable is what that inlet gets when it is the only one aboard
    const alone50 = exampleProject();
    alone50.equipment.find((e) => e.kind === 'shore-power')!.props.amps = 50;
    expect(inletCable(d)).toBe(inletCable(generateIdeal(exampleProject())));
    expect(inletCable(d, '-2')).toBe(inletCable(generateIdeal(alone50)));
    expect(inletCable(d, '-2')).not.toBe(inletCable(d));
    expect(into(d, 'galv-iso', 'a')!.gauge).toBe(inletCable(d));
    expect(into(d, 'galv-iso-2', 'a')!.gauge).toBe(inletCable(d, '-2'));
  });

  it('bonds the AC ground to DC negative, and grounds the equipment, with the larger inlet cable', () => {
    const d = generateIdeal(twoInlets());
    const bond = d.wires.find((w) => w.notes?.includes('ac-dc-bond'))!;
    expect(bond.gauge).toBe(inletCable(d, '-2'));
    const grounds = d.wires.filter((w) => w.equipmentGround);
    expect(grounds.length).toBeGreaterThan(0);
    for (const w of grounds) expect(w.gauge).toBe(inletCable(d, '-2'));
  });

  it('sizes 230 V inlets for 230 V', () => {
    const metric = (amps: number) => {
      const p = exampleProject();
      p.profile.acStandard = 'eu230';
      p.profile.units = 'metric';
      p.equipment.find((e) => e.kind === 'shore-power')!.props.amps = amps;
      return p;
    };
    const d = generateIdeal(twoInlets(32, metric(16)));
    expect(node(d, 'shore-inlet').sublabel).toBe('16 A 230 V');
    expect(node(d, 'shore-inlet-2').sublabel).toBe('32 A 230 V');
    expect([node(d, 'shore-elci').data.rating, node(d, 'shore-elci-2').data.rating]).toEqual([16, 32]);
    expect(inletCable(d)).toBe(inletCable(generateIdeal(metric(16))));
    expect(inletCable(d, '-2')).toBe(inletCable(generateIdeal(metric(32))));
    expect(node(d, 'ac-selector').data.rating).toBe(32);
  });

  it('feeds the AC side through one selector, Off / Shore 1 / Shore 2, rated for the larger inlet', () => {
    const d = generateIdeal(twoInlets());
    const sel = node(d, 'ac-selector');
    expect(sel.sublabel).toBe('Off / Shore 1 / Shore 2 (break-before-make)');
    expect(sel.data.rating).toBe(50);
    expect(sel.terminals.map((t) => [t.id, t.label])).toEqual([['in1', 'Shore 1'], ['in2', 'Shore 2'], ['out', undefined]]);
    expect(into(d, 'ac-selector', 'in1')).toMatchObject({ from: { node: 'shore-elci', term: 'out' }, amps: 30 });
    expect(into(d, 'ac-selector', 'in2')).toMatchObject({ from: { node: 'shore-elci-2', term: 'out' }, amps: 50 });
    // nothing after the selector is fed from an inlet directly
    expect(into(d, 'ic', 'acin')!.from).toEqual({ node: 'ac-selector', term: 'out' });
    expect(d.wires.filter((w) => w.from.node.startsWith('shore-elci') && w.to.node !== 'ac-selector')).toEqual([]);
  });

  it('adds the generator as a third input, and the selector feeds the transfer switch', () => {
    const p = withGenerator(twoInlets(30));
    p.equipment = p.equipment.filter((e) => e.kind !== 'inverter-charger');
    p.equipment.push(newEquipment('inverter', { name: 'Inverter', props: { watts: 1500 } }));
    const d = generateIdeal(p);
    const sel = node(d, 'ac-selector');
    expect(sel.sublabel).toBe('Off / Shore 1 / Shore 2 / Generator (break-before-make)');
    expect(sel.terminals.filter((t) => t.id.startsWith('in')).map((t) => [t.id, t.label])).toEqual([['in1', 'Shore 1'], ['in2', 'Shore 2'], ['in3', 'Gen']]);
    expect(into(d, 'ac-selector', 'in3')!.from).toEqual({ node: 'gen-brk', term: 'out' });
    expect(sel.data.rating).toBe(node(d, 'gen-brk').data.rating); // a 40 A generator breaker beats two 30 A inlets
    expect(into(d, 'ats', 'in1')!.from).toEqual({ node: 'ac-selector', term: 'out' });
    expect(errors(d, p)).toEqual([]);
  });

  it('keeps the one-inlet selector as it was', () => {
    const d = generateIdeal(withGenerator(exampleProject()));
    const sel = node(d, 'ac-selector');
    expect(sel.sublabel).toBe('Off / Shore / Generator (break-before-make)');
    expect(sel.terminals.map((t) => [t.id, t.label])).toEqual([['in1', 'Shore'], ['in2', 'Gen'], ['out', undefined]]);
    expect(node(d, 'shore-elci').label).toBe('Shore main breaker + ELCI');
    expect(node(d, 'galv-iso').label).toBe('Galvanic isolator');
  });
});

describe('two shore inlets downstream', () => {
  it('pass the design check in every scenario, as Compare shows them', () => {
    const p = twoInlets();
    for (const s of p.scenarios) {
      const d = generateIdeal(p, s);
      expect(d.nodes.filter((n) => n.type === 'shore-inlet'), s.name).toHaveLength(2);
      expect(errors(d, p), s.name).toEqual([]);
      expect(designMetrics(d, acVolts(p), p.profile.units).errors, s.name).toBe(0);
    }
  });

  it('name the inlet in the design check, but only when there are two', () => {
    const stripIsolator = (p: Project, id: string) => {
      const d = existingFromIdeal(generateIdeal(p), {});
      removeItems(d, [id], []);
      return audit(d, { acVolts: acVolts(p), units: p.profile.units }).filter((f) => f.rule === 'galvanic-isolator' || f.rule === 'ac-dc-bond').map((f) => f.message);
    };
    expect(stripIsolator(twoInlets(), 'galv-iso-2')).toEqual([
      'Bow shore inlet: Shore-power ground has no galvanic isolator.',
      'Bow shore inlet: AC grounding conductor is not connected to the DC negative / engine ground.',
    ]);
    expect(stripIsolator(exampleProject(), 'galv-iso')).toEqual([
      'Shore-power ground has no galvanic isolator.',
      'AC grounding conductor is not connected to the DC negative / engine ground.',
    ]);
  });

  it('are an error when both are wired to a panel without the selector', () => {
    const p = twoInlets();
    const d = existingFromIdeal(generateIdeal(p), {});
    const fed = d.wires.filter((w) => w.from.node === 'ac-selector');
    expect(fed.length).toBeGreaterThan(0);
    removeItems(d, ['ac-selector'], []);
    for (const w of fed) {
      for (const elci of ['shore-elci', 'shore-elci-2']) d.wires.push({ ...w, id: `${w.id}-${elci}`, from: { node: elci, term: 'out' } });
    }
    const f = errors(d, p).filter((x) => x.rule === 'source-selector');
    expect(f).toHaveLength(1);
    expect(f[0].message).toMatch(/^AC panel — shore\/gen only can be fed by more than one AC source at once \(/);
    expect(f[0].message).toContain('Shore power 30 A');
    expect(f[0].message).toContain('Bow shore inlet');
  });

  it('leave the energy budget as it is: the selector lets one inlet in at a time', () => {
    const one = energyBudget(exampleProject());
    const two = energyBudget(twoInlets());
    expect(two.chargerAmps).toBe(one.chargerAmps);
    expect(two.shoreAhPerDay).toBe(one.shoreAhPerDay);
    expect(two.shoreCanGiveAhPerDay).toBe(one.shoreCanGiveAhPerDay);
  });

  it('are both on the drawing started from the equipment list', () => {
    const p = twoInlets();
    const inlets = existingFromEquipment(p).nodes.filter((n) => n.type === 'shore-inlet');
    expect(inlets.map((n) => [n.label, n.data.amps])).toEqual([['Shore power 30 A', 30], ['Bow shore inlet', 50]]);
  });

  it('are both in the bill of materials, the cost and the upgrade plan', () => {
    const p = twoInlets();
    const d = generateIdeal(p);
    const bom = billOfMaterials(d);
    const rows = (item: string) => bom.filter((r) => r.item === item).map((r) => `${r.qty}× ${r.spec}`);
    expect(rows('Main breaker + ELCI')).toEqual(['1× 30 A double-pole main breaker with ELCI', '1× 50 A double-pole main breaker with ELCI']);
    expect(rows('Galvanic isolator')).toEqual(['1× Galvanic isolator, 30 A, fail-safe', '1× Galvanic isolator, 50 A, fail-safe']);
    expect(rows('Shore power inlet').map((r) => r.split('×')[0])).toEqual(['1', '1']);
    expect(rows('AC source selector')).toHaveLength(1);

    // the second inlet's parts are priced like the first's
    const one = designCost(generateIdeal(exampleProject()));
    const two = designCost(d);
    expect(two.unpriced).toBe(one.unpriced);
    expect(two.total).toBeGreaterThan(one.total);

    const plan = changeList(existingFromEquipment(p), d, acVolts(p)).map((c) => c.title);
    expect(plan).toContain('Add 2 × Main breaker + ELCI');
    expect(plan).toContain('Add 2 × Galvanic isolator');
  });
});
