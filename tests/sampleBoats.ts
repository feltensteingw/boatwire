// A fixed set of boats that between them exercise every branch of the design generator.
// Used to lock the generator's output (tests/generatorGolden.test.ts) and to check that every
// design it produces passes BoatWire's own audit (tests/idealPassesAudit.test.ts).

import { exampleProject, newEquipment } from '../src/model/examples';
import { buildBoat, TEMPLATES } from '../src/model/templates';
import type { Equipment, EquipmentKind, Project, PropValue, Scenario } from '../src/model/types';

export interface SampleBoat {
  name: string;
  project: Project;
  scenario?: Scenario;
}

/**
 * Equipment ids are random when a boat is created. Replace them with ones made from the kind of
 * equipment ("fridge", "bilge-pump", "bilge-pump-2"), so generated designs are the same every run.
 */
export function stableIds(p: Project): Project {
  const seen = new Map<string, number>();
  for (const e of p.equipment) {
    const n = (seen.get(e.kind) ?? 0) + 1;
    seen.set(e.kind, n);
    e.id = n === 1 ? e.kind : `${e.kind}-${n}`;
  }
  return p;
}

const the = (p: Project, kind: EquipmentKind, role?: string): Equipment => {
  const e = p.equipment.find((x) => x.kind === kind && (role === undefined || x.props.role === role));
  if (!e) throw new Error(`sample boat has no ${kind}${role ? ` (${role})` : ''}`);
  return e;
};
const without = (p: Project, keep: (e: Equipment) => boolean) => void (p.equipment = p.equipment.filter(keep));

/**
 * A second engine, "Port engine", beside the example boat's, renamed "Starboard engine". With
 * `startBattery`, it gets its own start battery too, and the example boat's is renamed to match.
 * (Distinct names keep their findings apart.)
 */
function twinEngines(p: Project, o: { engine?: Record<string, PropValue>; startBattery?: Record<string, PropValue> } = {}) {
  the(p, 'engine').name = 'Starboard engine';
  p.equipment.push(newEquipment('engine', { name: 'Port engine', props: o.engine }));
  if (o.startBattery) {
    the(p, 'battery-bank', 'start').name = 'Starboard start battery';
    p.equipment.push(newEquipment('battery-bank', { name: 'Port start battery', props: { role: 'start', chemistry: 'agm', unitVolts: 12, unitAh: 90, units: 1, ...o.startBattery } }));
  }
}

function boat(name: string, change: (p: Project) => Scenario | void, base: Project = exampleProject()): SampleBoat {
  const scenario = change(base) ?? undefined;
  return { name, project: stableIds(base), scenario };
}

/** Boats whose whole generated design is recorded line by line. */
export const SAMPLE_BOATS: SampleBoat[] = [
  boat('12 V lead-acid cruiser (the example boat)', () => {}),

  boat('24 V lithium with external BMS and external regulator', (p) => {
    Object.assign(the(p, 'battery-bank', 'house').props, { chemistry: 'lifepo4', bms: 'external' });
    the(p, 'engine').props.regulator = 'external';
    return { id: 'v24', name: '24 V', systemVoltage: 24 };
  }),

  boat('no start battery: the engine starts from the house bank', (p) => without(p, (e) => e.props.role !== 'start')),

  boat('diode battery isolator with an excitation wire', (p) => {
    the(p, 'engine').props.chargeSplit = 'isolator-diode';
  }),

  boat('engine-run charging relay', (p) => {
    the(p, 'engine').props.chargeSplit = 'relay-run';
  }),

  boat(
    'inverter only: no shore power, no generator',
    () => {},
    buildBoat({ ...TEMPLATES[0].answers, name: 'Inverter only', engine: true, startBattery: true, alternatorAmps: 60, inverter: 'inverter', inverterWatts: 1000, loads: [...TEMPLATES[0].answers.loads, 'ac-outlets'] }),
  ),

  boat('shore power and generator, separate inverter and two-output charger, shore-only loads', (p) => {
    without(p, (e) => e.kind !== 'inverter-charger');
    p.equipment.push(
      newEquipment('inverter', { name: 'Inverter', props: { watts: 1500 } }),
      newEquipment('battery-charger', { name: 'Battery charger', props: { amps: 40, outputs: 2 } }),
      newEquipment('generator', {}),
      newEquipment('air-conditioner', {}),
    );
  }),

  boat('12 V lithium house with a lead-acid start battery (alternator to start, DC-DC to house)', (p) => p.scenarios.find((s) => s.id === 'lfp12')),

  boat('dedicated windlass and refrigeration banks, wind and hydro, 24 V with 12 V-only loads', (p) => {
    p.equipment.push(
      newEquipment('battery-bank', { name: 'Bow battery', zone: 'bow', props: { role: 'windlass', chemistry: 'agm', unitVolts: 12, unitAh: 100, units: 2 } }),
      newEquipment('battery-bank', { name: 'Fridge battery', zone: 'galley', props: { role: 'fridge', chemistry: 'agm', unitVolts: 12, unitAh: 100, units: 2 } }),
      newEquipment('wind', {}),
      newEquipment('hydro', {}),
      newEquipment('bow-thruster', {}),
    );
    return { id: 'v24', name: '24 V', systemVoltage: 24 };
  }),

  boat('230 V shore power, metric units', (p) => {
    p.profile.acStandard = 'eu230';
    p.profile.units = 'metric';
  }),

  boat('two shore inlets (30 A and 50 A), inverter/charger', (p) => {
    p.equipment.push(newEquipment('shore-power', { name: 'Bow shore inlet 50 A', zone: 'bow', props: { amps: 50 } }));
  }),

  boat('two shore inlets and a generator, separate inverter and charger', (p) => {
    without(p, (e) => e.kind !== 'inverter-charger');
    p.equipment.push(
      newEquipment('shore-power', { name: 'Second shore inlet 30 A', zone: 'vberth', props: { amps: 30 } }),
      newEquipment('inverter', { name: 'Inverter', props: { watts: 1500 } }),
      newEquipment('battery-charger', { name: 'Battery charger', props: { amps: 40 } }),
      newEquipment('generator', {}),
    );
  }),

  boat('twin engines, a start battery each (emergency parallel switch)', (p) => twinEngines(p, { startBattery: {} })),

  boat('twin engines sharing one start battery', (p) => twinEngines(p, { engine: { alternatorAmps: 150 } })),

  boat('twin engines with no start battery', (p) => {
    without(p, (e) => e.props.role !== 'start');
    twinEngines(p);
  }),
];

/** More boats, locked by a fingerprint of the whole design rather than line by line. */
export const FINGERPRINT_BOATS: SampleBoat[] = [
  ...TEMPLATES.map((t) => ({ name: `template: ${t.name}`, project: stableIds(buildBoat(t.answers)) })),
  ...exampleProject().scenarios.slice(1).map((s) => ({ name: `example boat, scenario ${s.name}`, project: stableIds(exampleProject()), scenario: s })),
  boat('FET battery isolator', (p) => {
    the(p, 'engine').props.chargeSplit = 'isolator-fet';
  }),
  boat('diode isolator, alternator sense lead moved', (p) => {
    Object.assign(the(p, 'engine').props, { chargeSplit: 'isolator-diode', isolatorSense: 'sense' });
  }),
  boat('lithium house, no start battery, stock regulator (an error the design reports)', (p) => {
    the(p, 'battery-bank', 'house').props.chemistry = 'lifepo4';
    without(p, (e) => e.props.role !== 'start');
  }),
  boat('two of everything that is drawn once', (p) => {
    p.equipment.push(newEquipment('engine', { name: 'Second engine' }), newEquipment('shore-power', { name: 'Second inlet' }), newEquipment('generator', {}), newEquipment('generator', { name: 'Second generator' }));
  }),
  boat('equipment in a zone that no longer exists', (p) => {
    the(p, 'fridge').zone = 'gone';
  }),
  boat('no house bank at all', (p) => without(p, (e) => e.kind !== 'battery-bank')),

  // --- AC arrangements
  boat('generator only, no shore power', (p) => {
    without(p, (e) => e.kind !== 'shore-power' && e.kind !== 'inverter-charger');
    p.equipment.push(newEquipment('generator', {}), newEquipment('battery-charger', {}));
  }),
  boat('inverter/charger with no shore power or generator, plus a charger and a shore-only load', (p) => {
    without(p, (e) => e.kind !== 'shore-power');
    p.equipment.push(newEquipment('battery-charger', {}), newEquipment('air-conditioner', {}));
  }),
  boat('inverter/charger with shore power, a separate charger and a shore-only load', (p) => {
    p.equipment.push(newEquipment('battery-charger', {}), newEquipment('air-conditioner', {}));
  }),
  boat('shore power with a charger and no inverter', (p) => {
    without(p, (e) => e.kind !== 'inverter-charger');
    p.equipment.push(newEquipment('battery-charger', {}));
  }),
  boat('separate inverter with no shore power, and a charger with nothing to feed it', (p) => {
    without(p, (e) => e.kind !== 'shore-power' && e.kind !== 'inverter-charger');
    p.equipment.push(newEquipment('inverter', {}), newEquipment('battery-charger', {}), newEquipment('air-conditioner', {}));
  }),
  boat('no AC at all', (p) => without(p, (e) => !['shore-power', 'inverter-charger', 'ac-outlets', 'microwave', 'water-heater'].includes(e.kind))),
  boat('two 230 V shore inlets (16 A and 32 A), metric', (p) => {
    p.profile.acStandard = 'eu230';
    p.profile.units = 'metric';
    const aft = the(p, 'shore-power');
    aft.name = 'Shore power 16 A';
    aft.props.amps = 16;
    p.equipment.push(newEquipment('shore-power', { name: 'Bow shore inlet 32 A', zone: 'bow', props: { amps: 32 } }));
  }),

  // --- batteries
  boat('two house banks of different chemistry', (p) => {
    p.equipment.push(newEquipment('battery-bank', { name: 'Second house bank', props: { role: 'house', chemistry: 'lifepo4', unitVolts: 12, unitAh: 100, units: 2 } }));
  }),
  boat('three 12 V batteries on a 24 V boat (cannot be arranged)', (p) => {
    p.profile.systemVoltage = 24;
    the(p, 'battery-bank', 'house').props.units = 3;
  }),
  boat('lithium start battery', (p) => {
    the(p, 'battery-bank', 'start').props.chemistry = 'lifepo4';
  }),
  boat('lithium house with a lead-acid windlass bank', (p) => {
    the(p, 'battery-bank', 'house').props.chemistry = 'lifepo4';
    p.equipment.push(newEquipment('battery-bank', { name: 'Bow battery', zone: 'bow', props: { role: 'windlass', chemistry: 'agm', unitVolts: 12, unitAh: 100, units: 1 } }));
  }),
  boat('a dedicated winch bank with no winch aboard', (p) => {
    p.equipment.push(newEquipment('battery-bank', { name: 'Winch battery', zone: 'cockpit', props: { role: 'winch', chemistry: 'lifepo4', unitVolts: 12, unitAh: 100, units: 1 } }));
  }),
  boat('a very large inverter on 12 V (parallel cables, beyond fuse sizes)', (p) => {
    the(p, 'inverter-charger').props.watts = 8000;
  }),
  boat('a 5000 W inverter/charger on 12 V (an 800 A Class T inverter fuse)', (p) => {
    the(p, 'inverter-charger').props.watts = 5000;
  }),
  boat('a 12 kW generator on 120 V (beyond the largest AC breaker, cables sized for the current)', (p) => {
    p.equipment.push(newEquipment('generator', { props: { watts: 12000 } }));
  }),

  // --- engine and charging
  boat('lithium house, external regulator, no start battery', (p) => {
    the(p, 'battery-bank', 'house').props.chemistry = 'lifepo4';
    the(p, 'engine').props.regulator = 'external';
    without(p, (e) => e.props.role !== 'start');
  }),
  boat('lead-acid with an external regulator', (p) => {
    the(p, 'engine').props.regulator = 'external';
  }),
  boat('lithium house with the charging relay chosen', (p) => {
    the(p, 'battery-bank', 'house').props.chemistry = 'lifepo4';
    the(p, 'engine').props.chargeSplit = 'relay-run';
  }),
  boat('lithium house with an isolator chosen and an external regulator', (p) => {
    the(p, 'battery-bank', 'house').props.chemistry = 'lifepo4';
    Object.assign(the(p, 'engine').props, { chargeSplit: 'isolator-fet', regulator: 'external' });
  }),
  boat('lithium start battery with an isolator chosen', (p) => {
    the(p, 'battery-bank', 'start').props.chemistry = 'lifepo4';
    the(p, 'engine').props.chargeSplit = 'isolator-fet';
  }),
  boat('lithium start battery with the charging relay chosen and an external regulator', (p) => {
    the(p, 'battery-bank', 'start').props.chemistry = 'lifepo4';
    Object.assign(the(p, 'engine').props, { chargeSplit: 'relay-run', regulator: 'external' });
  }),
  boat('lithium house and lithium start battery, stock regulator (an error the design reports)', (p) => {
    the(p, 'battery-bank', 'house').props.chemistry = 'lifepo4';
    the(p, 'battery-bank', 'start').props.chemistry = 'lifepo4';
  }),
  boat('lithium house and lithium start battery, external regulator', (p) => {
    the(p, 'battery-bank', 'house').props.chemistry = 'lifepo4';
    the(p, 'battery-bank', 'start').props.chemistry = 'lifepo4';
    the(p, 'engine').props.regulator = 'external';
  }),
  boat('lithium start battery with an ACR chosen, 24 V', (p) => {
    the(p, 'battery-bank', 'start').props.chemistry = 'lifepo4';
    the(p, 'engine').props.chargeSplit = 'acr';
    return { id: 'v24', name: '24 V', systemVoltage: 24 };
  }),
  boat('charging relay chosen with only one battery bank', (p) => {
    the(p, 'engine').props.chargeSplit = 'relay-run';
    without(p, (e) => e.props.role !== 'start');
  }),
  boat('isolator chosen with only one battery bank', (p) => {
    the(p, 'engine').props.chargeSplit = 'isolator-diode';
    without(p, (e) => e.props.role !== 'start');
  }),
  boat('diode isolator with no compensation', (p) => {
    Object.assign(the(p, 'engine').props, { chargeSplit: 'isolator-diode', isolatorSense: 'none' });
  }),
  boat('a big alternator (heavier charging relay)', (p) => {
    the(p, 'engine').props.alternatorAmps = 150;
  }),
  boat('an engine with no alternator', (p) => {
    the(p, 'engine').props.alternatorAmps = 0;
  }),
  boat('a 200 A starter (twice that is beyond the largest start fuse)', (p) => {
    the(p, 'engine').props.starterAmps = 200;
  }),
  boat('a 1500 W solar array on 12 V (beyond the largest controller and PV breaker)', (p) => {
    the(p, 'solar').props.watts = 1500;
  }),
  boat('no engine', (p) => without(p, (e) => e.kind !== 'engine')),

  // --- twin engines
  boat('twin engines, lithium house, a lead-acid start battery each', (p) => {
    twinEngines(p, { startBattery: {} });
    return p.scenarios.find((s) => s.id === 'lfp12');
  }),
  boat('twin engines, start batteries of different chemistry', (p) => twinEngines(p, { startBattery: { chemistry: 'lifepo4' } })),
  boat('twin engines, a start battery each, 24 V what-if', (p) => {
    twinEngines(p, { startBattery: {} });
    return { id: 'v24', name: '24 V', systemVoltage: 24 };
  }),
  boat('twin engines sharing one start battery, engine-run relay chosen', (p) => twinEngines(p, { engine: { chargeSplit: 'relay-run' } })),
  // the stock-regulator engine charges the start battery; no DC-DC charger runs back to it from the house bank
  boat('twin engines sharing one start battery, lithium house, one external regulator', (p) => {
    twinEngines(p, { engine: { regulator: 'external' } });
    return p.scenarios.find((s) => s.id === 'lfp12');
  }),
  boat('twin engines sharing one start battery, one with a battery isolator', (p) => twinEngines(p, { engine: { chargeSplit: 'isolator-fet' } })),

  // --- heavy loads
  boat('bow thruster and electric winch on 12 V, fed from the house bank', (p) => {
    p.equipment.push(newEquipment('bow-thruster', {}), newEquipment('electric-winch', {}));
  }),
  boat('thruster and winch on their own banks', (p) => {
    p.equipment.push(
      newEquipment('bow-thruster', {}),
      newEquipment('electric-winch', {}),
      newEquipment('battery-bank', { name: 'Thruster battery', zone: 'bow', props: { role: 'thruster', chemistry: 'agm', unitVolts: 12, unitAh: 100, units: 2 } }),
      newEquipment('battery-bank', { name: 'Winch battery', zone: 'cockpit', props: { role: 'winch', chemistry: 'lifepo4', unitVolts: 12, unitAh: 100, units: 1 } }),
    );
  }),
  boat('nothing but a house bank', () => {}, (() => {
    const p = exampleProject();
    p.equipment = p.equipment.filter((e) => e.props.role === 'house');
    return p;
  })()),
];

export const acVoltsOf = (p: Project) => (p.profile.acStandard === 'eu230' ? 230 : 120);
