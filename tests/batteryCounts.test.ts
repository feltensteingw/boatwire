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
    // the sizing check says what the batteries store, not that the bank (which cannot be built) has that capacity
    expect(d.findings.find((f) => f.rule === 'bank-sizing')!.message).toMatch(/^The house batteries as listed store about 150 Ah at 24 V; daily use is/);
    expect(generateIdeal(boat(24, 2)).findings.find((f) => f.rule === 'bank-sizing')!.message).toMatch(/^House bank is 100 Ah; daily use is/);
  });

  it('a bank with no batteries is reported plainly, also in a what-if that does not set its size', () => {
    const q = boat(12, 0);
    for (const s of [undefined, { id: 'v', name: '24 V', systemVoltage: 24 } as Scenario, { id: 'l', name: 'Lithium', houseChemistry: 'lifepo4' } as Scenario]) {
      const d = generateIdeal(q, s);
      const n = node(d, bank(q, 'house'));
      expect(n.sublabel, s?.name).toMatch(/^0× 12 V 100 Ah (AGM|LiFePO4) · cannot make (12|24) V$/);
      expect(about(d, n.id), s?.name).toEqual(['error: House bank: no batteries listed.']);
      expect(d.findings.find((f) => f.nodes?.includes(n.id))!.fix).toBe('Set the number of batteries in the equipment list.');
    }
    // a scenario capacity does set its size, and says so
    const d = generateIdeal(q, { id: 'c', name: '300 Ah', houseCapacityAh: 300 });
    expect(about(d, node(d, bank(q, 'house')).id)).toEqual(['info: House bank: 3 batteries assumed to make 300 Ah at 12 V; your list has 0.']);
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

describe('a what-if scenario keeps the banks it changes buildable, and says what it assumed', () => {
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

  it('in a 12 V what-if, 24 V batteries are taken as 12 V ones storing the same energy, with a note', () => {
    const q = exampleProject();
    q.profile.systemVoltage = 24;
    Object.assign(bank(q, 'house').props, { unitVolts: 24, units: 2 });
    Object.assign(bank(q, 'start').props, { unitVolts: 24, units: 1 });
    const v12: Scenario = { id: 'v12', name: '12 V', systemVoltage: 12 };
    const d = generateIdeal(q, v12);
    const house = node(d, bank(q, 'house'));
    const start = node(d, bank(q, 'start'));
    expect(house.sublabel).toBe('4× 12 V 100 Ah AGM · 1S4P = 12 V 400 Ah');
    expect(start.sublabel).toBe('2× 12 V 90 Ah AGM · 1S2P = 12 V 180 Ah');
    expect(about(d, house.id)).toEqual(['info: House bank: 4× 12 V 100 Ah assumed to store the same energy; your list has 2× 24 V 100 Ah.']);
    expect(about(d, start.id)).toEqual(['info: Start battery: 2× 12 V 90 Ah assumed to store the same energy; your list has 1× 24 V 90 Ah.']);
    expect(d.findings.find((f) => f.nodes?.includes(start.id))!.fix).toBe("24 V batteries can't make a 12 V bank. If you make this change, list 2 batteries of 12 V.");
    expect(d.findings.filter((f) => f.severity === 'error')).toEqual([]);
    expect(energyBudget(q, v12).houseAh).toBe(400);
    // the same energy of the same chemistry costs the same as specified
    const batteries = (x: Design) => designCost(x).byCategory.find((c) => c.category === 'Batteries')!.cost;
    expect(batteries(d)).toBeCloseTo(batteries(generateIdeal(q)), 6);
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
  /** Boats with banks of 1 to 3 batteries of 6, 12 or 24 V, at 12 and 24 V, as specified and in what-ifs. */
  function* cases(): Generator<[string, Project, Scenario | undefined]> {
    for (const b of [...SAMPLE_BOATS, ...FINGERPRINT_BOATS]) yield [b.name, b.project, b.scenario];
    const whatIfs: (Scenario | undefined)[] = [undefined, { id: 'a', name: 'As specified' }, { id: '24', name: '24 V', systemVoltage: 24 }, { id: '12', name: '12 V', systemVoltage: 12 }, { id: 'l', name: 'Lithium', houseChemistry: 'lifepo4' }, { id: 'c', name: '300 Ah', houseCapacityAh: 300 }];
    for (const volts of [12, 24] as const)
      for (const unitVolts of [6, 12, 24])
        for (const units of [1, 2, 3])
          for (const s of whatIfs) {
            const p = boat(volts, units);
            bank(p, 'start').props.units = units;
            bank(p, 'windlass').props.units = 4 - units;
            for (const e of p.equipment) if (e.kind === 'battery-bank') e.props.unitVolts = unitVolts;
            yield [`${volts} V, ${units}/${units}/${4 - units} batteries of ${unitVolts} V, ${s?.name ?? 'no scenario'}`, p, s];
          }
  }

  it('no bank reads 0 Ah, a bank drawn unlike the list or that cannot be built has a finding of its own, and a what-if never leaves a bank it changes unbuildable', () => {
    const problems: string[] = [];
    for (const [name, p, s] of cases()) {
      const d = generateIdeal(p, s);
      const changed = new Set(bankChanges(p, s).map((c) => c.listed.id));
      const voltageWhatIf = s?.systemVoltage !== undefined && s.systemVoltage !== p.profile.systemVoltage;
      for (const n of d.nodes.filter((x) => x.type === 'battery')) {
        const e = p.equipment.find((x) => x.id === n.equipmentId)!;
        const drawnAsListed = n.sublabel!.startsWith(`${e.props.units}× ${e.props.unitVolts} V `);
        const cannot = n.sublabel!.includes('cannot make');
        if (/\b0 Ah/.test(n.sublabel!) || !(Number(n.data.ah) > 0)) problems.push(`${name}: ${n.label} drawn as ${n.sublabel}`);
        if (!drawnAsListed && !about(d, n.id).some((f) => f.startsWith('info:'))) problems.push(`${name}: ${n.label} changed silently (${n.sublabel})`);
        if (cannot && !about(d, n.id).some((f) => f.startsWith('error:'))) problems.push(`${name}: ${n.label} cannot be built, with no error`);
        if (cannot && (changed.has(e.id) || voltageWhatIf)) problems.push(`${name}: ${n.label} changed by the what-if but cannot be built (${n.sublabel})`);
        if (changed.has(e.id) && Number(n.data.ah) * d.systemVoltage < Number(e.props.units) * Number(e.props.unitVolts) * Number(e.props.unitAh) && !s?.houseCapacityAh) problems.push(`${name}: ${n.label} stores less than listed (${n.sublabel})`);
      }
    }
    expect(problems).toEqual([]);
  });
});

describe('a lithium what-if keeps the energy of a bank of 6 V, 2 V or 24 V batteries', () => {
  const lithium: Scenario = { id: 'l', name: 'Lithium', houseChemistry: 'lifepo4' };
  /** The example boat with its house bank changed. */
  function house(props: Record<string, string | number>, volts: SystemVoltage = 12): Project {
    const p = exampleProject();
    p.profile.systemVoltage = volts;
    if (volts === 24) bank(p, 'start').props.units = 2;
    Object.assign(bank(p, 'house').props, props);
    return p;
  }
  const golfCart = { chemistry: 'flooded', unitVolts: 6, unitAh: 225, units: 4 };

  it('four 6 V 225 Ah golf-cart batteries become two 12 V 225 Ah: the same 450 Ah, with a note', () => {
    const p = house(golfCart);
    expect(energyBudget(p).houseAh).toBe(450);
    const e = effectiveEquipment(p, lithium).find((x) => x.props.role === 'house')!;
    expect(e.props).toMatchObject({ chemistry: 'lifepo4', unitVolts: 12, unitAh: 225, units: 2 });
    expect(energyBudget(p, lithium).houseAh).toBe(450);
    const d = generateIdeal(p, lithium);
    const n = node(d, bank(p, 'house'));
    expect(n.sublabel).toBe('2× 12 V 225 Ah LiFePO4 · 1S2P = 12 V 450 Ah');
    expect(about(d, n.id)).toEqual(['info: House bank: 2× 12 V 225 Ah assumed to store the same energy; your list has 4× 6 V 225 Ah.']);
    expect(d.findings.find((f) => f.nodes?.includes(n.id))!.fix).toBe('Lithium batteries are taken as 12 V each. If you make this change, list 2 batteries of 12 V.');
    // priced as 5.4 kWh of lithium, as the list holds 5.4 kWh of lead-acid
    const bat = designCost(d).rows.find((r) => r.category === 'Batteries' && r.spec.includes('LiFePO4'))!;
    expect(bat.cost).toBeCloseTo(5.4 * priceFor('battery:lifepo4')!, 6);
  });

  it('in a 24 V lithium what-if the same bank is two 12 V batteries in series: 225 Ah at 24 V', () => {
    const p = house(golfCart);
    const s: Scenario = { ...lithium, systemVoltage: 24 };
    expect(node(generateIdeal(p, s), bank(p, 'house')).sublabel).toBe('2× 12 V 225 Ah LiFePO4 · 2S1P = 24 V 225 Ah');
    expect(energyBudget(p, s).houseAh).toBe(225);
  });

  it('six 2 V 600 Ah cells become one 12 V 600 Ah battery', () => {
    const p = house({ chemistry: 'flooded', unitVolts: 2, unitAh: 600, units: 6 });
    expect(node(generateIdeal(p, lithium), bank(p, 'house')).sublabel).toBe('1× 12 V 600 Ah LiFePO4 · 1S1P = 12 V 600 Ah');
  });

  it('when whole batteries store more than the list, the note says "at least"', () => {
    // three 6 V 225 Ah batteries store 4.05 kWh; two 12 V 225 Ah store 5.4 kWh
    const p = house({ ...golfCart, units: 3 });
    const d = generateIdeal(p, lithium);
    const n = node(d, bank(p, 'house'));
    expect(n.sublabel).toBe('2× 12 V 225 Ah LiFePO4 · 1S2P = 12 V 450 Ah');
    expect(about(d, n.id)).toEqual(['info: House bank: 2× 12 V 225 Ah assumed to store at least the same energy; your list has 3× 6 V 225 Ah.']);
  });

  it('two 24 V 100 Ah batteries on a 24 V boat become four 12 V 100 Ah: 200 Ah at 24 V', () => {
    const p = house({ chemistry: 'agm', unitVolts: 24, unitAh: 100, units: 2 }, 24);
    const d = generateIdeal(p, lithium);
    const n = node(d, bank(p, 'house'));
    expect(n.sublabel).toBe('4× 12 V 100 Ah LiFePO4 · 2S2P = 24 V 200 Ah');
    expect(about(d, n.id)).toEqual(['info: House bank: 4× 12 V 100 Ah assumed to store the same energy; your list has 2× 24 V 100 Ah.']);
  });

  it("a capacity typed for the scenario still sets the bank's size", () => {
    const p = house(golfCart);
    const d = generateIdeal(p, { ...lithium, houseCapacityAh: 900 });
    const n = node(d, bank(p, 'house'));
    expect(n.sublabel).toBe('4× 12 V 225 Ah LiFePO4 · 1S4P = 12 V 900 Ah');
    expect(about(d, n.id)).toEqual(['info: House bank: 4× 12 V 225 Ah assumed to make 900 Ah at 12 V; your list has 4× 6 V 225 Ah.']);
  });
});
