import { describe, expect, it } from 'vitest';
import { designCost } from '../src/engine/cost';
import { energyBudget } from '../src/engine/energy';
import { generateIdeal } from '../src/engine/generate';
import { bankChanges, effectiveEquipment } from '../src/engine/scenario';
import { exampleProject, newEquipment } from '../src/model/examples';
import { priceFor } from '../src/model/prices';
import type { Design, Equipment, Project, Scenario, SystemVoltage } from '../src/model/types';
import { FINGERPRINT_BOATS, SAMPLE_BOATS } from './sampleBoats';

// A battery bank whose count cannot make the system voltage. At the boat's own voltage it is drawn
// as listed and reported; only a real what-if scenario changes a count, and it says so.

const bank = (p: Project, role: string) => p.equipment.find((e) => e.kind === 'battery-bank' && e.props.role === role)!;
const node = (d: Design, e: Equipment) => d.nodes.find((n) => n.equipmentId === e.id)!;
const about = (d: Design, id: string) => d.findings.filter((f) => f.nodes?.includes(id)).map((f) => `${f.severity}: ${f.message}`);

/** The example boat with a house bank of `house` 12 V batteries, one start battery and one windlass battery. */
function boat(volts: SystemVoltage, house: number): Project {
  const p = exampleProject();
  p.profile.systemVoltage = volts;
  bank(p, 'house').props.units = house;
  p.equipment.push(newEquipment('battery-bank', { name: 'Bow battery', zone: 'bow', props: { role: 'windlass', chemistry: 'agm', unitVolts: 12, unitAh: 100, units: 1 } }));
  p.scenarios = [{ id: 'base', name: 'As specified' }];
  return p;
}

describe("at the boat's own voltage, a bank that cannot make it is drawn as listed and reported", () => {
  const p = boat(24, 3);
  const asSpecified = p.scenarios[0];

  it('a scenario that changes nothing leaves the equipment list alone', () => {
    expect(effectiveEquipment(p, asSpecified)).toBe(p.equipment);
    expect(bankChanges(p, asSpecified)).toEqual([]);
    // the same goes for a scenario that repeats the boat's own settings
    const same: Scenario = { id: 's', name: 'Same', systemVoltage: 24, houseChemistry: 'agm', houseCapacityAh: 150 };
    expect(effectiveEquipment(p, same)).toBe(p.equipment);
  });

  it('draws the same design through the "As specified" scenario as without one', () => {
    const strip = (d: Design) => JSON.stringify({ nodes: d.nodes, wires: d.wires, findings: d.findings });
    expect(strip(generateIdeal(p, asSpecified))).toBe(strip(generateIdeal(p)));
  });

  for (const [role, label, error] of [
    ['house', '3× 12 V 100 Ah AGM · cannot make 24 V', "House bank: 3× 12 V batteries can't make a 24 V bank (need a multiple of 2)."],
    ['start', '1× 12 V 90 Ah AGM · cannot make 24 V', "Start battery: 1× 12 V battery can't make a 24 V bank (need a multiple of 2)."],
    ['windlass', '1× 12 V 100 Ah AGM · cannot make 24 V', "Bow battery: 1× 12 V battery can't make a 24 V bank (need a multiple of 2)."],
  ]) {
    it(`${role} bank: keeps the listed count, never reads 0 Ah, and is an error on the bank`, () => {
      const d = generateIdeal(p, asSpecified);
      const n = node(d, bank(p, role));
      expect(n.sublabel).toBe(label);
      expect(n.data.ah).toBeGreaterThan(0);
      expect(about(d, n.id)).toEqual([`error: ${error}`]);
      expect(d.findings.find((f) => f.message === error)!.fix).toMatch(/^Use \d batteries or a different battery voltage\.$/);
    });
  }

  it('prices the batteries on the list, as the energy budget counts them', () => {
    const d = generateIdeal(p, asSpecified);
    const c = designCost(d);
    expect(c.unpriced).toBe(0);
    const kWh = (3 * 12 * 100 + 1 * 12 * 90 + 1 * 12 * 100) / 1000;
    expect(c.byCategory.find((x) => x.category === 'Batteries')!.cost).toBeCloseTo(kWh * priceFor('battery:agm')!, 6);
    expect(node(d, bank(p, 'house')).data.ah).toBe(energyBudget(p, asSpecified).houseAh);
  });

  it('batteries of a higher voltage than the boat are reported plainly', () => {
    const q = exampleProject();
    Object.assign(bank(q, 'start').props, { unitVolts: 24, units: 1 });
    const d = generateIdeal(q);
    const n = node(d, bank(q, 'start'));
    expect(n.sublabel).toBe('1× 24 V 90 Ah AGM · cannot make 12 V');
    expect(about(d, n.id)).toEqual(["error: Start battery: 24 V batteries can't make a 12 V bank."]);
  });

  it('a bank that fits gets no finding', () => {
    const q = boat(24, 4);
    const d = generateIdeal(q);
    expect(node(d, bank(q, 'house')).sublabel).toBe('4× 12 V 100 Ah AGM · 2S2P = 24 V 200 Ah');
    expect(about(d, node(d, bank(q, 'house')).id)).toEqual([]);
  });
});

describe('a what-if scenario keeps every bank buildable, and says what it assumed', () => {
  const p = boat(12, 3);
  const v24: Scenario = { id: 'v24', name: '24 V', systemVoltage: 24 };

  for (const [role, label, note] of [
    ['house', '4× 12 V 100 Ah AGM · 2S2P = 24 V 200 Ah', 'House bank: 4 batteries assumed for 24 V; your list has 3.'],
    ['start', '2× 12 V 90 Ah AGM · 2S1P = 24 V 90 Ah', 'Start battery: 2 batteries assumed for 24 V; your list has 1.'],
    ['windlass', '2× 12 V 100 Ah AGM · 2S1P = 24 V 100 Ah', 'Bow battery: 2 batteries assumed for 24 V; your list has 1.'],
  ]) {
    it(`${role} bank in a 24 V what-if: rounded up to whole strings, with a design note`, () => {
      const d = generateIdeal(p, v24);
      const n = node(d, bank(p, role));
      expect(n.sublabel).toBe(label);
      expect(about(d, n.id)).toEqual([`info: ${note}`]);
      expect(d.findings.find((f) => f.message === note)!.fix).toMatch(/^12 V batteries make 24 V in strings of 2\. If you make this change, list \d batteries\.$/);
    });
  }

  it('the what-if has no errors about the banks, and leaves the equipment list as it was', () => {
    const d = generateIdeal(p, v24);
    expect(d.findings.filter((f) => f.severity === 'error')).toEqual([]);
    expect(p.equipment.filter((e) => e.kind === 'battery-bank').map((e) => e.props.units)).toEqual([3, 1, 1]);
  });

  it('a bank that already fits is not changed and gets no note', () => {
    const d = generateIdeal(boat(12, 4), v24);
    expect(d.findings.filter((f) => f.message.startsWith('House bank:'))).toEqual([]);
  });

  it('a scenario capacity that changes the count is stated', () => {
    const d = generateIdeal(p, { id: 'c', name: 'Bigger bank', houseCapacityAh: 550 });
    const n = node(d, bank(p, 'house'));
    expect(n.sublabel).toBe('6× 12 V 100 Ah AGM · 1S6P = 12 V 600 Ah');
    expect(about(d, n.id)).toEqual(['info: House bank: 6 batteries assumed to make 600 Ah at 12 V; your list has 3.']);
  });

  it("a chemistry what-if at the boat's own voltage changes the house bank only", () => {
    const q = boat(24, 3);
    const d = generateIdeal(q, { id: 'g', name: 'Gel', houseChemistry: 'gel' });
    expect(about(d, node(d, bank(q, 'house')).id)).toEqual(['info: House bank: 4 batteries assumed for 24 V; your list has 3.']);
    // the start and windlass batteries are not part of the what-if: they stay as listed, and are reported
    expect(node(d, bank(q, 'start')).sublabel).toBe('1× 12 V 90 Ah AGM · cannot make 24 V');
    expect(about(d, node(d, bank(q, 'windlass')).id)).toEqual(["error: Bow battery: 1× 12 V battery can't make a 24 V bank (need a multiple of 2)."]);
  });

  it("the example boat's own what-ifs: only the 24 V one changes a count, and says so", () => {
    const q = exampleProject();
    const notes = (s: Scenario) => generateIdeal(q, s).findings.filter((f) => f.rule === 'series-parallel').map((f) => f.message);
    expect(q.scenarios.map((s) => [s.name, notes(s)])).toEqual([
      ['As specified (12 V AGM)', []],
      ['12 V lithium', []],
      ['24 V lithium', ['Start battery: 2 batteries assumed for 24 V; your list has 1.']],
    ]);
  });
});

describe('every difference between the equipment list and the drawing is stated', () => {
  /** Boats with banks of 1 to 3 batteries, at 12 and 24 V, as specified and in what-ifs. */
  function* cases(): Generator<[string, Project, Scenario | undefined]> {
    for (const b of [...SAMPLE_BOATS, ...FINGERPRINT_BOATS]) yield [b.name, b.project, b.scenario];
    const whatIfs: (Scenario | undefined)[] = [undefined, { id: 'a', name: 'As specified' }, { id: '24', name: '24 V', systemVoltage: 24 }, { id: '12', name: '12 V', systemVoltage: 12 }, { id: 'l', name: 'Lithium', houseChemistry: 'lifepo4' }, { id: 'c', name: '300 Ah', houseCapacityAh: 300 }];
    for (const volts of [12, 24] as const)
      for (const units of [1, 2, 3])
        for (const s of whatIfs) {
          const p = boat(volts, units);
          bank(p, 'start').props.units = units;
          bank(p, 'windlass').props.units = 4 - units;
          yield [`${volts} V, ${units}/${units}/${4 - units} batteries, ${s?.name ?? 'no scenario'}`, p, s];
        }
  }

  it('no bank reads 0 Ah, and a bank drawn unlike the list, or that cannot be built, has a finding of its own', () => {
    const problems: string[] = [];
    for (const [name, p, s] of cases()) {
      const d = generateIdeal(p, s);
      for (const n of d.nodes.filter((x) => x.type === 'battery')) {
        const e = p.equipment.find((x) => x.id === n.equipmentId)!;
        const drawnAsListed = n.sublabel!.startsWith(`${e.props.units}× ${e.props.unitVolts} V `);
        const cannot = n.sublabel!.includes('cannot make');
        if (/\b0 Ah/.test(n.sublabel!) || !(Number(n.data.ah) > 0)) problems.push(`${name}: ${n.label} drawn as ${n.sublabel}`);
        if (!drawnAsListed && !about(d, n.id).some((f) => f.startsWith('info:'))) problems.push(`${name}: ${n.label} changed silently (${n.sublabel})`);
        if (cannot && !about(d, n.id).some((f) => f.startsWith('error:'))) problems.push(`${name}: ${n.label} cannot be built, with no error`);
      }
    }
    expect(problems).toEqual([]);
  });
});
