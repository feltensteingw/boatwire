import { CATALOG_BY_KIND, DEFAULT_ZONES } from './catalog';
import type { Equipment, EquipmentKind, Project, PropValue } from './types';

let counter = 0;
export function uid(prefix = 'e'): string {
  counter++;
  return `${prefix}${Date.now().toString(36)}${counter.toString(36)}${Math.random().toString(36).slice(2, 5)}`;
}

export function newEquipment(kind: EquipmentKind, overrides: { name?: string; zone?: string; props?: Record<string, PropValue> } = {}): Equipment {
  const c = CATALOG_BY_KIND[kind];
  return {
    id: uid(),
    kind,
    name: overrides.name ?? c.label,
    zone: overrides.zone ?? c.zone,
    props: { ...c.props, ...(overrides.props ?? {}) },
  };
}

/** Name a new, empty boat starts with. */
export const BLANK_NAME = 'My boat';

export function blankProject(): Project {
  return {
    version: 1,
    profile: {
      name: BLANK_NAME,
      lengthFt: 40,
      systemVoltage: 12,
      acStandard: 'us120',
      batteryZone: 'battery',
      panelZone: 'nav',
      zones: DEFAULT_ZONES.map((z) => ({ ...z })),
    },
    equipment: [newEquipment('battery-bank', { name: 'House bank' })],
    scenarios: [{ id: 'base', name: 'As specified' }],
    activeScenario: 'base',
  };
}

/** A typical 40 ft cruising sloop. */
export function exampleProject(): Project {
  const p = blankProject();
  p.profile.name = 'Example 40 ft cruising sloop';
  p.equipment = [
    newEquipment('battery-bank', { name: 'House bank', props: { role: 'house', chemistry: 'agm', unitVolts: 12, unitAh: 100, units: 4 } }),
    newEquipment('battery-bank', { name: 'Start battery', zone: 'battery', props: { role: 'start', chemistry: 'agm', unitVolts: 12, unitAh: 90, units: 1 } }),
    newEquipment('engine', { name: 'Diesel engine (40 hp)' }),
    newEquipment('solar', { name: 'Solar arch (2 × 200 W)', props: { watts: 400, arrayVmp: 36 } }),
    newEquipment('shore-power', { name: 'Shore power 30 A' }),
    newEquipment('inverter-charger', { name: 'Inverter/charger', props: { watts: 2000, chargeAmps: 80 } }),
    newEquipment('cabin-lights', {}),
    newEquipment('nav-lights', {}),
    newEquipment('anchor-light', {}),
    newEquipment('steaming-deck-light', {}),
    newEquipment('fridge', {}),
    newEquipment('water-pump', {}),
    newEquipment('bilge-pump', { name: 'Bilge pump (main)' }),
    newEquipment('bilge-pump', { name: 'Bilge pump (high water)', props: { watts: 96 } }),
    newEquipment('autopilot', {}),
    newEquipment('chartplotter', {}),
    newEquipment('vhf', {}),
    newEquipment('ais', {}),
    newEquipment('instruments', {}),
    newEquipment('usb-outlets', {}),
    newEquipment('fans', {}),
    newEquipment('windlass', { name: 'Anchor windlass (1000 W)', props: { watts: 1000 } }),
    newEquipment('ac-outlets', {}),
    newEquipment('microwave', {}),
    newEquipment('water-heater', {}),
  ];
  p.scenarios = [
    { id: 'base', name: 'As specified (12 V AGM)' },
    { id: 'lfp12', name: '12 V lithium', houseChemistry: 'lifepo4', houseCapacityAh: 400 },
    { id: 'lfp24', name: '24 V lithium', systemVoltage: 24, houseChemistry: 'lifepo4', houseCapacityAh: 200 },
  ];
  return p;
}
