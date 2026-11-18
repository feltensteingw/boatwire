import { describe, expect, it } from 'vitest';
import { audit, estimateCurrents } from '../src/engine/audit';
import { inverterDcAmps } from '../src/engine/calc';
import { energyBudget } from '../src/engine/energy';
import { existingFromIdeal } from '../src/engine/existing';
import { generateIdeal } from '../src/engine/generate';
import { exampleProject, newEquipment } from '../src/model/examples';
import { makeNode } from '../src/model/nodeDefs';
import type { Design } from '../src/model/types';
import { ENERGY_ASSUMPTIONS, INVERTER_EFFICIENCY, LOW_BATTERY_FACTOR } from '../src/model/standards';

describe('one inverter efficiency everywhere', () => {
  it('inverterDcAmps is watts over efficiency at low battery voltage', () => {
    expect(inverterDcAmps(2000, 12)).toBeCloseTo(2000 / INVERTER_EFFICIENCY / (12 * LOW_BATTERY_FACTOR), 6);
    expect(inverterDcAmps(2000, 24)).toBeCloseTo(inverterDcAmps(2000, 12) / 2, 6);
    expect(inverterDcAmps(0, 12)).toBe(0);
  });

  it('the ideal design sizes the inverter feed with it', () => {
    const p = exampleProject();
    const ic = p.equipment.find((e) => e.kind === 'inverter-charger')!;
    ic.props.watts = 3000;
    ic.props.chargeAmps = 50;
    const d = generateIdeal(p);
    const feed = d.wires.find((w) => w.kind === 'pos' && w.to.node === 'ic' && w.to.term === 'dcpos')!;
    expect(feed.amps).toBeCloseTo(inverterDcAmps(3000, 12), 0);
  });

  it('the check of a hand-drawn boat estimates the same current for the same inverter', () => {
    const p = exampleProject();
    const ic = p.equipment.find((e) => e.kind === 'inverter-charger')!;
    ic.props.watts = 3000;
    ic.props.chargeAmps = 50;
    const drawn = existingFromIdeal(generateIdeal(p), {});
    // as if the owner drew it: no currents recorded, so the check has to estimate them
    for (const w of drawn.wires) delete w.amps;
    const feed = drawn.wires.find((w) => w.kind === 'pos' && w.to.node === 'ic' && w.to.term === 'dcpos')!;
    expect(estimateCurrents(drawn).get(feed.id)).toBeCloseTo(inverterDcAmps(3000, 12), 6);
  });

  it('the energy budget uses it for loads run through the inverter', () => {
    const p = exampleProject();
    p.equipment = p.equipment.filter((e) => e.kind === 'battery-bank' || e.kind === 'inverter-charger');
    p.equipment.push(newEquipment('microwave', { name: 'Microwave', props: { watts: 900, hoursPerDay: 1, shoreOnly: false } }));
    const b = energyBudget(p);
    expect(b.rows).toHaveLength(1);
    expect(b.rows[0].whPerDay).toBeCloseTo(900 / INVERTER_EFFICIENCY, 6);
    expect(b.assumptions.inverterEfficiency).toBe(INVERTER_EFFICIENCY);
  });
});

describe('estimated current on an inverter cable (hand-drawn boat)', () => {
  const draw = (type: 'inverter' | 'inverter-charger', watts: number, chargeAmps?: number) => {
    const bat = makeNode('battery', 'bat', 'House', { data: { chemistry: 'agm', ah: 400 } });
    const fuse = makeNode('fuse', 'f', 'Inverter fuse', { data: { rating: 400 } });
    const inv = makeNode(type, 'inv', 'Inverter', { data: { watts, amps: chargeAmps } });
    const wire = (id: string, a: [string, string], b: [string, string], kind: 'pos' | 'neg' = 'pos') => ({ id, kind, domain: 'dc' as const, from: { node: a[0], term: a[1] }, to: { node: b[0], term: b[1] }, lengthFt: 4, gauge: '4' });
    const d: Design = { id: 'existing', name: 'Existing', systemVoltage: 12, nodes: [bat, fuse, inv], findings: [], wires: [wire('w1', ['bat', 'pos'], ['f', 'in']), wire('w2', ['f', 'out'], ['inv', 'dcpos']), wire('w3', ['inv', 'dcneg'], ['bat', 'neg'], 'neg')] };
    return d;
  };

  it('an inverter/charger is sized by its inverter draw, not its smaller charge current', () => {
    const d = draw('inverter-charger', 2000, 80);
    expect(estimateCurrents(d).get('w2')).toBeCloseTo(inverterDcAmps(2000, 12), 6);
    // 4 AWG cannot carry ~212 A: the check must say so
    expect(audit(d).some((f) => f.rule === 'conductor-sizing' && f.wires?.includes('w2'))).toBe(true);
  });

  it('a plain inverter gets an estimate too', () => {
    expect(estimateCurrents(draw('inverter', 1500)).get('w2')).toBeCloseTo(inverterDcAmps(1500, 12), 6);
  });

  it('a big charger on a small inverter is sized by the charge current', () => {
    expect(estimateCurrents(draw('inverter-charger', 300, 100)).get('w2')).toBe(100);
  });
});

describe('energy budget assumptions come from standards.ts and are reported with the budget', () => {
  it('reports the figures it used', () => {
    const b = energyBudget(exampleProject());
    expect(b.assumptions).toMatchObject({ solarPeakHours: ENERGY_ASSUMPTIONS.solarPeakHours, solarDerate: ENERGY_ASSUMPTIONS.solarDerate, windHydroCapacityFactor: ENERGY_ASSUMPTIONS.windHydroCapacityFactor });
    expect(b.daysAutonomy).toBe(ENERGY_ASSUMPTIONS.daysAutonomy);
    expect(b.assumptions.alternatorChargeEfficiency).toBe(ENERGY_ASSUMPTIONS.alternatorChargeEfficiency.lead);
  });

  it('solar yield follows the peak-hours and derate figures', () => {
    const p = exampleProject();
    const watts = p.equipment.filter((e) => e.kind === 'solar').reduce((s, e) => s + Number(e.props.watts), 0);
    expect(energyBudget(p).solarAhPerDay).toBeCloseTo((watts * ENERGY_ASSUMPTIONS.solarPeakHours * ENERGY_ASSUMPTIONS.solarDerate) / 12, 6);
  });

  it('a lithium house bank takes more of the alternator output', () => {
    const p = exampleProject();
    const lfp = p.scenarios.find((s) => s.houseChemistry === 'lifepo4')!;
    expect(energyBudget(p, lfp).assumptions.alternatorChargeEfficiency).toBe(ENERGY_ASSUMPTIONS.alternatorChargeEfficiency.lifepo4);
  });
});
