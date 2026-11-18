// Starting points for a new boat: a handful of answers turned into a full equipment list.
// Used by the New boat wizard, both for its ready-made templates and for custom answers.

import { CATALOG_BY_KIND, DEFAULT_ZONES } from './catalog';
import { blankProject, newEquipment } from './examples';
import type { AcStandard, Chemistry, EquipmentKind, Project, SystemVoltage, Zone } from './types';

export interface BoatAnswers {
  name: string;
  lengthFt: number;
  systemVoltage: SystemVoltage;
  acStandard: AcStandard;
  houseChemistry: Chemistry;
  /** House bank capacity at the system voltage, amp-hours. */
  houseAh: number;
  startBattery: boolean;
  engine: boolean;
  alternatorAmps: number;
  solarWatts: number;
  /** Shore power inlet rating in amps; 0 for none. */
  shoreAmps: number;
  inverter: 'none' | 'inverter' | 'inverter-charger';
  inverterWatts: number;
  /** DC and AC appliances aboard, by catalog kind. */
  loads: EquipmentKind[];
}

/** The zone list was drawn up for a 40 ft boat. */
const REFERENCE_LENGTH_FT = 40;

/** Zones for a boat of the given length: positions along the hull and the height of the mast scale with it. */
export function zonesFor(lengthFt: number): Zone[] {
  const k = lengthFt > 0 ? lengthFt / REFERENCE_LENGTH_FT : 1;
  const tall = new Set(['mast', 'masthead']);
  return DEFAULT_ZONES.map((z) => ({ ...z, x: Math.round(z.x * k), rise: tall.has(z.id) ? Math.round(z.rise * k) : z.rise }));
}

/** Number of 12 V batteries of `unitAh` needed for a bank of `ah` at the system voltage. */
function bankUnits(ah: number, unitAh: number, volts: SystemVoltage): number {
  const series = volts / 12;
  return Math.max(1, Math.ceil(ah / unitAh)) * series;
}

export function buildBoat(a: BoatAnswers): Project {
  const p = blankProject();
  p.profile = { ...p.profile, name: a.name.trim() || 'My boat', lengthFt: a.lengthFt, systemVoltage: a.systemVoltage, acStandard: a.acStandard, zones: zonesFor(a.lengthFt) };

  const eq = [newEquipment('battery-bank', { name: 'House bank', props: { role: 'house', chemistry: a.houseChemistry, unitVolts: 12, unitAh: 100, units: bankUnits(a.houseAh, 100, a.systemVoltage) } })];
  if (a.engine && a.startBattery) {
    eq.push(newEquipment('battery-bank', { name: 'Start battery', props: { role: 'start', chemistry: 'agm', unitVolts: 12, unitAh: 90, units: a.systemVoltage / 12 } }));
  }
  if (a.engine) eq.push(newEquipment('engine', { name: 'Engine', props: { alternatorAmps: a.alternatorAmps } }));
  if (a.solarWatts > 0) eq.push(newEquipment('solar', { name: `Solar (${a.solarWatts} W)`, props: { watts: a.solarWatts } }));
  if (a.shoreAmps > 0) eq.push(newEquipment('shore-power', { name: `Shore power ${a.shoreAmps} A`, props: { amps: a.shoreAmps } }));
  if (a.inverter === 'inverter-charger') {
    eq.push(newEquipment('inverter-charger', { name: 'Inverter/charger', props: { watts: a.inverterWatts, chargeAmps: Math.round(Math.min(a.houseAh * (a.houseChemistry === 'lifepo4' ? 0.4 : 0.2), 150) / 10) * 10 || 30 } }));
  } else {
    if (a.inverter === 'inverter') eq.push(newEquipment('inverter', { name: 'Inverter', props: { watts: a.inverterWatts } }));
    // Shore power with no inverter/charger still needs something to charge the batteries.
    if (a.shoreAmps > 0) eq.push(newEquipment('battery-charger', { name: 'Battery charger', props: { amps: Math.max(20, Math.round((a.houseAh * 0.15) / 10) * 10) } }));
  }
  for (const kind of a.loads) if (CATALOG_BY_KIND[kind]) eq.push(newEquipment(kind));
  p.equipment = eq;
  return p;
}

// Each template's house bank is sized to pass BoatWire's own two-day rule for the appliances it
// lists (tests/templates.test.ts checks this), so a new boat does not open with a warning.

/** Appliances offered in the wizard, grouped as a boat owner would think of them. */
export const LOAD_GROUPS: { title: string; kinds: EquipmentKind[] }[] = [
  { title: 'Lights', kinds: ['cabin-lights', 'nav-lights', 'anchor-light', 'steaming-deck-light'] },
  { title: 'Galley & water', kinds: ['fridge', 'freezer', 'water-pump', 'bilge-pump', 'shower-sump', 'watermaker'] },
  { title: 'Navigation & radio', kinds: ['chartplotter', 'instruments', 'autopilot', 'vhf', 'ais', 'radar', 'ssb', 'starlink'] },
  { title: 'Comfort', kinds: ['fans', 'usb-outlets', 'stereo', 'diesel-heater'] },
  { title: 'Heavy gear', kinds: ['windlass', 'bow-thruster', 'electric-winch'] },
  { title: 'Mains (AC) appliances', kinds: ['ac-outlets', 'water-heater', 'microwave', 'induction-cooktop', 'air-conditioner'] },
];

const BASICS: EquipmentKind[] = ['cabin-lights', 'nav-lights', 'anchor-light', 'bilge-pump', 'vhf', 'instruments', 'usb-outlets'];
const CRUISING: EquipmentKind[] = [...BASICS, 'steaming-deck-light', 'fridge', 'water-pump', 'autopilot', 'chartplotter', 'fans'];

export interface BoatTemplate {
  id: string;
  name: string;
  blurb: string;
  answers: BoatAnswers;
}

export const TEMPLATES: BoatTemplate[] = [
  {
    id: 'daysailer',
    name: 'Day sailer / weekender',
    blurb: '25 ft. A small house bank, a solar panel, lights and a radio. No inboard engine or shore power.',
    answers: { name: 'My day sailer', lengthFt: 25, systemVoltage: 12, acStandard: 'us120', houseChemistry: 'agm', houseAh: 200, startBattery: false, engine: false, alternatorAmps: 0, solarWatts: 50, shoreAmps: 0, inverter: 'none', inverterWatts: 0, loads: BASICS },
  },
  {
    id: 'coastal',
    name: 'Coastal cruiser',
    blurb: '32 ft. AGM house bank and start battery, diesel, 200 W of solar, shore power with a charger, fridge and autopilot.',
    answers: { name: 'My coastal cruiser', lengthFt: 32, systemVoltage: 12, acStandard: 'us120', houseChemistry: 'agm', houseAh: 500, startBattery: true, engine: true, alternatorAmps: 60, solarWatts: 200, shoreAmps: 30, inverter: 'none', inverterWatts: 0, loads: [...CRUISING, 'ac-outlets', 'water-heater'] },
  },
  {
    id: 'offshore',
    name: 'Offshore cruiser, lithium and solar',
    blurb: '42 ft. Lithium house bank, 800 W of solar, inverter/charger, watermaker, radar and a windlass.',
    answers: { name: 'My offshore cruiser', lengthFt: 42, systemVoltage: 12, acStandard: 'us120', houseChemistry: 'lifepo4', houseAh: 800, startBattery: true, engine: true, alternatorAmps: 120, solarWatts: 800, shoreAmps: 30, inverter: 'inverter-charger', inverterWatts: 3000, loads: [...CRUISING, 'freezer', 'watermaker', 'radar', 'ais', 'starlink', 'diesel-heater', 'windlass', 'ac-outlets', 'microwave', 'water-heater'] },
  },
  {
    id: 'large24',
    name: 'Large cruiser, 24 V',
    blurb: '50 ft. 24 V lithium system with a bow thruster, windlass and electric winch, 1200 W of solar and a big inverter/charger.',
    answers: { name: 'My 24 V cruiser', lengthFt: 50, systemVoltage: 24, acStandard: 'us120', houseChemistry: 'lifepo4', houseAh: 500, startBattery: true, engine: true, alternatorAmps: 150, solarWatts: 1200, shoreAmps: 50, inverter: 'inverter-charger', inverterWatts: 5000, loads: [...CRUISING, 'freezer', 'watermaker', 'radar', 'ais', 'starlink', 'windlass', 'bow-thruster', 'electric-winch', 'ac-outlets', 'microwave', 'induction-cooktop', 'water-heater', 'air-conditioner'] },
  },
];

/** What the wizard starts with when the user answers the questions themselves. */
export const CUSTOM_ANSWERS: BoatAnswers = { ...TEMPLATES[1].answers, name: 'My boat', lengthFt: 36 };
