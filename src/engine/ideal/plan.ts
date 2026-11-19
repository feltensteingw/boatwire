// What the boat has and what it draws: the facts every part of the generator works from.
// Nothing here adds to the design; see reportPlanProblems for the findings these facts lead to.

import { CATALOG_BY_KIND, DEDICATED_BANK_ROLES, dedicatedRoleFor, HEAVY_DC_THRESHOLD_A, MAX_ENGINES } from '../../model/catalog';
import { AC_STANDARDS } from '../../model/standards';
import type { BoatProfile, Chemistry, DNode, Equipment, Project, Scenario, SystemVoltage } from '../../model/types';
import { fmtLen } from '../../model/units';
import { missingZones } from '../../model/zones';
import { inverterDcAmps, MISSING_ZONE_RUN_FT, runLength } from '../calc';
import { num } from '../energy';
import { bankChanges, effectiveEquipment, scenarioVoltage, type BankChange } from '../scenario';
import type { BankSummary, Builder } from './builder';

/** A DC appliance and how it will be fed. `ded` = role of the dedicated bank that powers it (if the boat has one). */
export interface LoadInfo {
  e: Equipment;
  amps: number;
  watts: number;
  critical: boolean;
  /** A 12 V-only appliance on a 24 V boat: fed through the converter. */
  v12: boolean;
  /** Fed straight from a bus through its own protection and contactor, not from the panel. */
  heavy: boolean;
  alwaysOn: boolean;
  ded?: string;
}

export interface Plan {
  project: Project;
  scenario?: Scenario;
  profile: BoatProfile;
  /** System voltage for this scenario. */
  V: SystemVoltage;
  acStd: (typeof AC_STANDARDS)[keyof typeof AC_STANDARDS];
  /** Equipment as this scenario has it. */
  eq: Equipment[];
  /** Battery banks this scenario changes from the equipment list, by equipment id. */
  bankChanges: Map<string, BankChange>;
  /** Zones of the batteries, the panel and the helm. */
  BZ: string;
  PZ: string;
  HZ: string;
  /** Cable run between two zones, in feet. */
  run(a: string, z: string): number;
  /** Catalog currents are quoted at 12 V; multiply by this for the system voltage. */
  scale: number;
  kinds(k: string): Equipment[];

  banks: Equipment[];
  house: Equipment[];
  /** The engine start batteries drawn: one, or one for each engine on a twin-engine boat. */
  startBanks: Equipment[];
  /** The first start battery. Per-engine code reads `startBanks` instead. */
  startBank?: Equipment;
  /** Dedicated banks (windlass, thruster, winch, refrigeration): role → bank equipment. */
  dedBanks: Map<string, Equipment>;
  /** The engines drawn, up to MAX_ENGINES. */
  engines: Equipment[];
  /** The first engine. Per-engine code reads `engines` instead. */
  engine?: Equipment;
  houseChem: Chemistry;
  /** The house bank is lithium. */
  lfp: boolean;
  /** Lithium house bank with an external BMS. */
  extBms: boolean;

  dcLoads: LoadInfo[];
  panelLoads: LoadInfo[];
  v12Loads: LoadInfo[];
  heavyLoads: LoadInfo[];
  dedLoads: LoadInfo[];
  /** Always-on loads, fed from the battery side of the main switch. */
  aoLoads: LoadInfo[];
  acLoads: Equipment[];
  ic?: Equipment;
  inv?: Equipment;
  chargers: Equipment[];
  solars: Equipment[];
  winds: Equipment[];

  invWatts: number;
  invDcAmps: number;
  /** Design current of the main battery cables, fuse and switch. */
  mainAmps: number;
}

export function makePlan(project: Project, scenario?: Scenario): Plan {
  const { profile } = project;
  const V = scenarioVoltage(project, scenario);
  const acStd = AC_STANDARDS[profile.acStandard];
  const eq = effectiveEquipment(project, scenario);
  const changed = new Map(bankChanges(project, scenario).map((c) => [c.listed.id, c]));
  const BZ = profile.batteryZone;
  const PZ = profile.panelZone;
  const HZ = profile.helmZone;
  const run = (a: string, z: string) => runLength(profile, a, z);
  const scale = 12 / V; // catalog currents are quoted at 12 V

  const kinds = (k: string) => eq.filter((e) => e.kind === k);
  const banks = kinds('battery-bank');
  const house = banks.filter((e) => (e.props.role ?? 'house') === 'house');
  const engines = kinds('engine').slice(0, MAX_ENGINES);
  // twin engines: a start battery each, or one they share
  const startBanks = banks.filter((e) => e.props.role === 'start').slice(0, engines.length >= 2 ? 2 : 1);
  const startBank = startBanks[0];
  // Dedicated banks (windlass, thruster, winch, refrigeration): role → bank equipment
  const dedBanks = new Map<string, Equipment>();
  for (const r of Object.keys(DEDICATED_BANK_ROLES)) {
    const e = banks.find((x) => x.props.role === r);
    if (e) dedBanks.set(r, e);
  }
  const engine = engines[0];

  // (With no house bank there is no design; the caller stops before using any of this.)
  const houseChem = (house[0]?.props.chemistry as Chemistry) ?? 'agm';
  const lfp = houseChem === 'lifepo4';
  const extBms = lfp && house.some((h) => h.props.bms === 'external');

  const dcLoads: LoadInfo[] = eq
    .filter((e) => CATALOG_BY_KIND[e.kind]?.category === 'dc-load')
    .map((e) => {
      const watts = num(e, 'watts');
      const v12 = V === 24 && e.props.v24ok === false;
      const amps = watts / (v12 ? 12 : V);
      const heavy = ['windlass', 'bow-thruster', 'electric-winch'].includes(e.kind) || (!v12 && amps > HEAVY_DC_THRESHOLD_A);
      const role = dedicatedRoleFor(e.kind);
      const ded = role && !v12 && dedBanks.has(role) ? role : undefined;
      return { e, amps, watts, critical: !!e.props.critical, v12, heavy, alwaysOn: !!e.props.alwaysOn && !heavy && !ded, ded };
    });
  const acLoads = eq.filter((e) => CATALOG_BY_KIND[e.kind]?.category === 'ac-load');
  const ic = kinds('inverter-charger')[0];
  const inv = kinds('inverter')[0];
  const chargers = kinds('battery-charger');
  const solars = kinds('solar');
  const winds = [...kinds('wind'), ...kinds('hydro')];

  const invWatts = ic ? num(ic, 'watts') : inv ? num(inv, 'watts') : 0;
  const invDcAmps = inverterDcAmps(invWatts, V);
  const panelLoads = dcLoads.filter((l) => !l.heavy && !l.alwaysOn && !l.v12 && !l.ded);
  const v12Loads = dcLoads.filter((l) => l.v12 && !l.heavy);
  const heavyLoads = dcLoads.filter((l) => l.heavy && !l.ded);
  const dedLoads = dcLoads.filter((l) => l.ded);
  const aoLoads = dcLoads.filter((l) => l.alwaysOn);
  const continuous = dcLoads.filter((l) => !l.heavy).reduce((s, l) => s + l.watts / V, 0) * 0.6;
  const maxHeavyFromHouse = Math.max(0, ...heavyLoads.map((l) => l.amps));
  const chargeTotal =
    chargers.reduce((s, c) => s + num(c, 'amps'), 0) +
    (ic ? num(ic, 'chargeAmps') : 0) +
    solars.reduce((s, e) => s + num(e, 'watts') / V, 0) +
    // every alternator drawn: the main fuse, switch and cables carry them all at once
    engines.reduce((s, e) => s + num(e, 'alternatorAmps') * scale, 0);
  // Inverter at full output plus typical loads, with half the largest motor load (they rarely coincide).
  const mainAmps = Math.max(invDcAmps + continuous + 0.5 * maxHeavyFromHouse, maxHeavyFromHouse + continuous, chargeTotal);

  return { project, scenario, profile, V, acStd, eq, bankChanges: changed, BZ, PZ, HZ, run, scale, kinds, banks, house, startBanks, startBank, dedBanks, engines, engine, houseChem, lfp, extBms, dcLoads, panelLoads, v12Loads, heavyLoads, dedLoads, aoLoads, acLoads, ic, inv, chargers, solars, winds, invWatts, invDcAmps, mainAmps };
}

/** Things about the boat as a whole that the user should know before reading the design. */
export function reportPlanProblems(b: Builder, p: Plan) {
  const { project, profile, kinds, banks, house, houseChem, V, invWatts, invDcAmps } = p;

  // A cable to somewhere that is not in the zone list can only be guessed at. Say so.
  const lost = missingZones(project);
  if (lost.equipment.length) {
    const n = lost.equipment.length;
    b.find(
      'warning',
      'missing-zone',
      `${lost.equipment.slice(0, 4).join(', ')}${n > 4 ? ` and ${n - 4} more` : ''} ${n === 1 ? 'is' : 'are'} in a location that is not in the zone list, so the cable length to ${n === 1 ? 'it' : 'them'} is a ${fmtLen(MISSING_ZONE_RUN_FT, profile.units)} guess.`,
      'Open each item and choose its location, or add the zone back under Boat & zones.',
    );
  }
  if (lost.roles.length) {
    b.find('warning', 'missing-zone', `The ${lost.roles.join(' and the ')} ${lost.roles.length === 1 ? 'is' : 'are'} not in the zone list, so cable lengths measured from there are guesses.`, 'Choose the location again under Boat & zones.');
  }

  // The design has at most this many of each of these. Every extra is reported, never left out silently.
  const drawnAtMost: [list: Equipment[], max: number, what: string][] = [
    [kinds('engine'), MAX_ENGINES, 'up to two engines per boat'],
    [kinds('inverter-charger'), 1, 'one inverter/charger per boat'],
    // a separate inverter is not drawn when there is an inverter/charger
    [[...kinds('inverter-charger').slice(0, 1), ...kinds('inverter')], 1, 'one inverter per boat'],
    [kinds('shore-power'), 1, 'one shore power inlet per boat'],
    [kinds('generator'), 1, 'one AC generator per boat'],
    // (with no engine, one start battery still counts as drawn)
    [banks.filter((e) => e.props.role === 'start'), Math.min(MAX_ENGINES, Math.max(1, kinds('engine').length)), 'one engine start battery per engine'],
    ...Object.entries(DEDICATED_BANK_ROLES).map(([r, def]): [Equipment[], number, string] => [banks.filter((e) => e.props.role === r), 1, `one ${def.label.toLowerCase()} battery per boat`]),
  ];
  for (const [list, max, what] of drawnAtMost) {
    for (const e of list.slice(max)) {
      b.find(
        'warning',
        'not-drawn',
        `${e.name} is not in this design. BoatWire draws ${what} and used ${list.slice(0, max).map((x) => x.name).join(' and ')}.`,
        'Its wiring, fuses and cables are missing from the diagram, wire schedule and bill of materials. Work those out separately, or remove it from the equipment list.',
      );
    }
  }

  if (house.some((h) => h.props.chemistry !== houseChem)) {
    b.find('error', 'no-mixed-chemistry', 'House banks use different chemistries. They cannot be paralleled — choose one chemistry for the house bank.');
  }

  if (V === 12 && invWatts >= 2500) {
    b.find('warning', 'voltage-choice', `A ${invWatts} W inverter draws about ${Math.round(invDcAmps)} A from a 12 V bank. At 24 V it would be about ${Math.round(invDcAmps / 2)} A, with much smaller cables.`, 'Compare a 24 V scenario.');
  }
}

const batteries = (n: number) => `${n} ${n === 1 ? 'battery' : 'batteries'}`;

/**
 * Say how a battery bank as drawn differs from the equipment list: an error when its batteries
 * cannot make the system voltage, and a design note when a what-if scenario changed them.
 */
export function reportBank(b: Builder, p: Plan, e: Equipment, s: BankSummary, node: DNode) {
  const { V } = p;
  if (s.units < 1) {
    b.find('error', 'series-parallel', `${e.name}: no batteries listed.`, 'Set the number of batteries in the equipment list.', [node.id]);
    return;
  }
  if (!s.valid) {
    if (s.unitV > V) {
      b.find('error', 'series-parallel', `${e.name}: ${s.unitV} V batteries can't make a ${V} V bank.`, `Use ${V} V batteries, or smaller ones in series.`, [node.id]);
    } else {
      b.find('error', 'series-parallel', `${e.name}: ${s.units}× ${s.unitV} V ${s.units === 1 ? 'battery' : 'batteries'} can't make a ${V} V bank (need a multiple of ${s.series}).`, `Use ${batteries(Math.max(s.series, Math.ceil(s.units / s.series) * s.series))} or a different battery voltage.`, [node.id]);
    }
  }

  const c = p.bankChanges.get(e.id);
  if (!c) return;
  const was = num(c.listed, 'units', 1);
  const wasV = num(c.listed, 'unitVolts', 12);
  if (was === s.units && wasV === s.unitV) return;
  const sameV = wasV === s.unitV;
  const assumed = sameV ? batteries(s.units) : `${s.units}× ${s.unitV} V ${s.unitAh} Ah`;
  const listed = sameV ? `${was}` : `${was}× ${wasV} V ${s.unitAh} Ah`;
  // Whole strings can store more than the list does (three 6 V batteries become two 12 V ones), never less.
  const more = s.units * s.unitV > was * wasV;
  const [reason, why] =
    c.why === 'capacity'
      ? [`to make ${s.ah} Ah at ${V} V`, 'This scenario sets the house bank capacity.']
      : c.why === 'energy'
        ? [`to store ${more ? 'at least ' : ''}the same energy`, '']
        : [`for ${V} V`, `${s.unitV} V batteries make ${V} V in strings of ${s.series}.`];
  const volts = c.batteryVolts === 'lithium' ? `Lithium batteries are taken as ${s.unitV} V each.` : c.batteryVolts === 'too-high' ? `${wasV} V batteries can't make a ${V} V bank.` : '';
  const fix = [volts, why, `If you make this change, list ${batteries(s.units)}${sameV ? '' : ` of ${s.unitV} V`}.`].filter(Boolean).join(' ');
  b.find('info', 'series-parallel', `${e.name}: ${assumed} assumed ${reason}; your list has ${listed}.`, fix, [node.id]);
}
