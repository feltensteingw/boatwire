import type { EquipmentKind, PropValue, Zone } from './types';

export type Category = 'storage' | 'engine' | 'charging' | 'ac-source' | 'dc-load' | 'ac-load';

export interface PropDef {
  key: string;
  label: string;
  type: 'number' | 'select' | 'bool';
  unit?: string;
  options?: { value: string | number; label: string }[];
  help?: string;
  min?: number;
  step?: number;
}

export interface CatalogItem {
  kind: EquipmentKind;
  label: string;
  category: Category;
  glyph: string; // short symbol text drawn inside generic symbols
  zone: string;
  props: Record<string, PropValue>;
  defs: PropDef[];
  help?: string;
}

const loadDefs = (extra: PropDef[] = []): PropDef[] => [
  { key: 'watts', label: 'Power draw', type: 'number', unit: 'W', min: 0 },
  { key: 'hoursPerDay', label: 'Hours per day', type: 'number', unit: 'h', min: 0, step: 0.5 },
  { key: 'dutyCycle', label: 'Duty cycle', type: 'number', unit: '%', min: 0, step: 5, help: 'Share of on-time actually drawing power (e.g. fridge compressor ~40%)' },
  { key: 'critical', label: 'Critical circuit (3% drop)', type: 'bool', help: 'Navigation, bilge and electronics circuits are held to 3% voltage drop; others 10%.' },
  { key: 'v24ok', label: 'Runs on 24 V', type: 'bool', help: 'If off and the system is 24 V, the load is fed from a 24→12 V converter.' },
  ...extra,
];

const dc = (
  kind: EquipmentKind,
  label: string,
  glyph: string,
  zone: string,
  watts: number,
  hours: number,
  opts: { duty?: number; critical?: boolean; v24ok?: boolean; alwaysOn?: boolean; help?: string; extra?: PropDef[] } = {},
): CatalogItem => ({
  kind,
  label,
  category: 'dc-load',
  glyph,
  zone,
  help: opts.help,
  props: {
    watts,
    hoursPerDay: hours,
    dutyCycle: opts.duty ?? 100,
    critical: opts.critical ?? false,
    v24ok: opts.v24ok ?? true,
    ...(opts.alwaysOn !== undefined ? { alwaysOn: opts.alwaysOn } : {}),
  },
  defs: loadDefs(opts.extra),
});

const ac = (
  kind: EquipmentKind,
  label: string,
  glyph: string,
  zone: string,
  watts: number,
  hours: number,
  shoreOnly: boolean,
): CatalogItem => ({
  kind,
  label,
  category: 'ac-load',
  glyph,
  zone,
  props: { watts, hoursPerDay: hours, shoreOnly },
  defs: [
    { key: 'watts', label: 'Power draw', type: 'number', unit: 'W', min: 0 },
    { key: 'hoursPerDay', label: 'Hours per day (on inverter)', type: 'number', unit: 'h', min: 0, step: 0.25 },
    { key: 'shoreOnly', label: 'Shore / generator only', type: 'bool', help: 'Heavy loads (water heater, A/C) are kept off the inverter and only run on shore power or generator.' },
  ],
});

export const CATALOG: CatalogItem[] = [
  {
    kind: 'battery-bank',
    label: 'Battery bank',
    category: 'storage',
    glyph: 'BAT',
    zone: 'battery',
    props: { role: 'house', chemistry: 'agm', unitVolts: 12, unitAh: 100, units: 4, bms: 'internal' },
    defs: [
      { key: 'role', label: 'Role', type: 'select', options: [
        { value: 'house', label: 'House' },
        { value: 'start', label: 'Engine start' },
        { value: 'windlass', label: 'Windlass / bow (dedicated)' },
        { value: 'thruster', label: 'Bow thruster (dedicated)' },
        { value: 'winch', label: 'Electric winch (dedicated)' },
        { value: 'fridge', label: 'Refrigeration (dedicated)' },
      ] },
      { key: 'chemistry', label: 'Chemistry', type: 'select', options: [
        { value: 'flooded', label: 'Flooded lead-acid' },
        { value: 'agm', label: 'AGM' },
        { value: 'gel', label: 'Gel' },
        { value: 'lifepo4', label: 'Lithium (LiFePO4)' },
      ] },
      { key: 'unitVolts', label: 'Battery voltage (each)', type: 'select', options: [
        { value: 2, label: '2 V cell' },
        { value: 6, label: '6 V (golf cart)' },
        { value: 12, label: '12 V' },
        { value: 24, label: '24 V' },
      ] },
      { key: 'unitAh', label: 'Capacity (each)', type: 'number', unit: 'Ah', min: 1 },
      { key: 'units', label: 'Number of batteries', type: 'number', min: 1 },
      { key: 'bms', label: 'BMS (lithium only)', type: 'select', options: [
        { value: 'internal', label: 'Internal (drop-in)' },
        { value: 'external', label: 'External BMS with contactors' },
      ] },
    ],
  },
  {
    kind: 'engine',
    label: 'Engine (starter + alternator)',
    category: 'engine',
    glyph: 'ENG',
    zone: 'engine',
    props: { starterAmps: 150, alternatorAmps: 90, regulator: 'internal', chargeSplit: 'auto', isolatorSense: 'excite' },
    defs: [
      { key: 'starterAmps', label: 'Starter current (at 12 V)', type: 'number', unit: 'A', min: 0, help: 'Typical 30–50 hp diesel: 120–200 A at 12 V. Halved automatically for 24 V.' },
      { key: 'alternatorAmps', label: 'Alternator output', type: 'number', unit: 'A', min: 0 },
      { key: 'regulator', label: 'Alternator regulation', type: 'select', options: [
        { value: 'internal', label: 'Internal regulator (stock)' },
        { value: 'external', label: 'External smart regulator' },
      ] },
      { key: 'chargeSplit', label: 'Charge splitting', type: 'select', help: 'How one alternator charges several banks without bridging them. Automatic picks an ACR when both batteries are lead-acid, and a DC-DC charger when either is lithium. An engine-run relay closes only while the alternator is charging.', options: [
        { value: 'auto', label: 'Automatic (recommended)' },
        { value: 'acr', label: 'ACR / voltage-sensitive relay' },
        { value: 'relay-run', label: 'Charging relay (engine-run / D+ triggered)' },
        { value: 'isolator-fet', label: 'FET isolator (zero-drop)' },
        { value: 'isolator-diode', label: 'Diode isolator' },
      ] },
      { key: 'isolatorSense', label: 'Diode isolator compensation', type: 'select', help: 'Only used with a diode isolator and the stock regulator. A diode isolator loses ~0.7 V, so the regulator must be made to see battery voltage, not alternator voltage, or the batteries are always undercharged. Most diode isolators have an "E" (excitation) terminal for this; alternators with a remote-sense terminal can instead have the sense lead moved to the battery side.', options: [
        { value: 'excite', label: 'Isolator "E" terminal to alternator excitation (recommended)' },
        { value: 'sense', label: 'Alternator sense lead moved to the battery side' },
        { value: 'none', label: 'Not compensated (stock wiring)' },
      ] },
    ],
  },
  {
    kind: 'solar',
    label: 'Solar array',
    category: 'charging',
    glyph: 'PV',
    zone: 'arch',
    props: { watts: 400, arrayVmp: 36 },
    defs: [
      { key: 'watts', label: 'Array size', type: 'number', unit: 'W', min: 0 },
      { key: 'arrayVmp', label: 'Array Vmp', type: 'number', unit: 'V', min: 1, help: 'Max-power voltage of the array as wired (e.g. two 18 V panels in series = 36 V).' },
    ],
  },
  {
    kind: 'wind',
    label: 'Wind generator',
    category: 'charging',
    glyph: 'W',
    zone: 'arch',
    props: { watts: 400 },
    defs: [{ key: 'watts', label: 'Rated output', type: 'number', unit: 'W', min: 0 }],
  },
  {
    kind: 'hydro',
    label: 'Hydro generator',
    category: 'charging',
    glyph: 'H',
    zone: 'transom',
    props: { watts: 300 },
    defs: [{ key: 'watts', label: 'Rated output', type: 'number', unit: 'W', min: 0 }],
  },
  {
    kind: 'battery-charger',
    label: 'Battery charger (AC)',
    category: 'charging',
    glyph: 'CHG',
    zone: 'battery',
    props: { amps: 40, outputs: 2 },
    defs: [
      { key: 'amps', label: 'Charge current', type: 'number', unit: 'A', min: 0 },
      { key: 'outputs', label: 'Isolated outputs', type: 'number', min: 1 },
    ],
  },
  {
    kind: 'inverter-charger',
    label: 'Inverter / charger',
    category: 'charging',
    glyph: 'INV/C',
    zone: 'battery',
    props: { watts: 3000, chargeAmps: 120 },
    defs: [
      { key: 'watts', label: 'Inverter rating', type: 'number', unit: 'W', min: 0 },
      { key: 'chargeAmps', label: 'Charger current', type: 'number', unit: 'A', min: 0 },
    ],
  },
  {
    kind: 'inverter',
    label: 'Inverter (no charger)',
    category: 'charging',
    glyph: 'INV',
    zone: 'battery',
    props: { watts: 1000 },
    defs: [{ key: 'watts', label: 'Inverter rating', type: 'number', unit: 'W', min: 0 }],
  },
  {
    kind: 'shore-power',
    label: 'Shore power inlet',
    category: 'ac-source',
    glyph: 'SHORE',
    zone: 'cockpit',
    props: { amps: 30 },
    defs: [{ key: 'amps', label: 'Inlet rating', type: 'number', unit: 'A', min: 0 }],
  },
  {
    kind: 'generator',
    label: 'AC generator',
    category: 'ac-source',
    glyph: 'G',
    zone: 'engine',
    props: { watts: 3500 },
    defs: [{ key: 'watts', label: 'Rated output', type: 'number', unit: 'W', min: 0 }],
  },

  // ---- DC loads
  dc('cabin-lights', 'Cabin lights (LED)', '💡', 'saloon', 30, 5),
  dc('nav-lights', 'Navigation lights', 'NAV', 'bow', 6, 4, { critical: true, v24ok: false }),
  dc('anchor-light', 'Anchor light', 'ANC', 'masthead', 3, 10, { critical: true, v24ok: false }),
  dc('steaming-deck-light', 'Steaming / deck light', 'DECK', 'mast', 25, 0.5, { critical: true, v24ok: false }),
  dc('fridge', 'Refrigerator', 'FRG', 'galley', 60, 24, { duty: 40 }),
  dc('freezer', 'Freezer', 'FRZ', 'galley', 75, 24, { duty: 50 }),
  dc('water-pump', 'Fresh water pump', 'WP', 'galley', 84, 0.5),
  dc('bilge-pump', 'Bilge pump', 'BP', 'bilge', 60, 0.1, {
    critical: true,
    alwaysOn: true,
    help: 'Bilge pumps are wired to the battery side of the main switch so they work with the boat shut down.',
    extra: [{ key: 'alwaysOn', label: 'Unswitched (always on)', type: 'bool' }],
  }),
  dc('shower-sump', 'Shower sump pump', 'SUMP', 'vberth', 48, 0.2),
  dc('watermaker', 'Watermaker (12/24 V)', 'H₂O', 'saloon', 180, 2),
  dc('autopilot', 'Autopilot', 'AP', 'aft', 60, 6, { critical: true, duty: 35 }),
  dc('chartplotter', 'Chartplotter / MFD', 'MFD', 'cockpit', 25, 6, { critical: true, v24ok: false }),
  dc('vhf', 'VHF radio', 'VHF', 'nav', 6, 8, { critical: true, v24ok: false }),
  dc('radar', 'Radar', 'RAD', 'mast', 40, 2, { critical: true, v24ok: false }),
  dc('ais', 'AIS transponder', 'AIS', 'nav', 4, 12, { critical: true, v24ok: false }),
  dc('instruments', 'Instruments / NMEA 2000', 'N2K', 'nav', 12, 8, { critical: true, v24ok: false }),
  dc('ssb', 'SSB / HF radio', 'SSB', 'nav', 150, 0.5, { critical: true, v24ok: false, duty: 20 }),
  dc('starlink', 'Starlink / satcom', 'SAT', 'nav', 60, 6),
  dc('stereo', 'Stereo', '♪', 'saloon', 30, 2, { v24ok: false }),
  dc('fans', 'Cabin fans', 'FAN', 'vberth', 12, 8),
  dc('usb-outlets', '12 V / USB outlets', 'USB', 'saloon', 60, 3, { v24ok: false }),
  dc('horn', 'Electric horn', 'HRN', 'bow', 120, 0.01, { critical: true }),
  dc('diesel-heater', 'Diesel heater', 'HTR', 'aft', 40, 4),
  dc('windlass', 'Anchor windlass', 'WL', 'bow', 1200, 0.05, {
    help: 'Heavy motor load: fed from the main bus through its own breaker and a reversing contactor. It can have its own battery near the bow instead.',
  }),
  dc('bow-thruster', 'Bow thruster', 'THR', 'bow', 3000, 0.02, {
    help: 'Heavy motor load: fed through its own breaker and a contactor. It can have its own battery near the bow instead.',
  }),
  dc('electric-winch', 'Electric winch', 'WIN', 'cockpit', 1000, 0.05, {
    help: 'Heavy motor load: fed through its own breaker and a contactor. It can have its own battery nearby instead.',
  }),
  dc('custom-dc', 'Custom DC load', 'DC', 'saloon', 50, 1),

  // ---- AC loads
  ac('ac-outlets', 'AC outlets', '⏚', 'saloon', 300, 1, false),
  ac('water-heater', 'Water heater', 'WH', 'engine', 1500, 0, true),
  ac('air-conditioner', 'Air conditioner', 'A/C', 'saloon', 1200, 0, true),
  ac('microwave', 'Microwave', 'MW', 'galley', 1000, 0.2, false),
  ac('induction-cooktop', 'Induction cooktop', 'IND', 'galley', 1800, 0.5, false),
  ac('custom-ac', 'Custom AC load', 'AC', 'saloon', 200, 1, false),
];

/**
 * Hover explanations for properties that don't carry their own `help`.
 * Looked up as "<kind>.<key>" first, then "<category>.<key>", then "<key>".
 */
const PROP_HELP: Record<string, string> = {
  // batteries
  role: 'What this bank does. House runs everything aboard; Engine start only cranks the engine. A dedicated bank (windlass, thruster, winch or refrigeration) sits next to its equipment and supplies its power, so the heavy cables stay short. The equipment is still switched from the house panel through a relay, and the bank is recharged from the house bank by a DC-DC charger.',
  chemistry: 'Battery type. Lead-acid (flooded, AGM, gel) is cheaper but only ~50% is usable. Lithium (LiFePO4) gives ~80% usable, is lighter and charges faster, but needs a BMS, Class T fuse and alternator protection.',
  unitVolts: 'Voltage of each individual battery. They are wired in series to reach the system voltage (e.g. two 6 V golf-cart batteries make 12 V).',
  unitAh: 'Amp-hour rating printed on each battery (20-hour rate).',
  units: 'How many batteries are in this bank. Series strings add voltage; parallel strings add capacity.',
  bms: 'Battery management system. Drop-in lithium batteries have one built in. An external BMS controls a contactor and tells the chargers and loads to stop before it has to disconnect the bank.',
  // engine
  'engine.starterAmps': 'Current the starter motor draws while cranking, at 12 V. Typical 30–50 hp diesel: 120–200 A. Halved automatically for 24 V.',
  alternatorAmps: 'Rated output of the engine alternator. It sets the alternator cable and fuse size and how fast the batteries recharge under power.',
  regulator: 'Internal: the stock regulator built into the alternator. External smart regulator: multi-stage charging that senses at the battery and can limit output. Needed for charging lithium directly.',
  // charging
  'solar.watts': 'Total panel wattage (sum of all panels).',
  'wind.watts': 'Rated output of the wind generator. A dump load is added automatically so it is never run unloaded.',
  'hydro.watts': 'Rated output of the towed / transom-mounted hydro generator.',
  amps: 'Rated current.',
  'battery-charger.amps': 'Maximum DC output of the shore-power charger.',
  'battery-charger.outputs': 'Number of separate outputs, so one charger can top up several banks without connecting them together.',
  'inverter-charger.watts': 'Continuous AC output rating. Sets the size of the DC cable and fuse feeding it, which can be very large.',
  'inverter.watts': 'Continuous AC output rating. Sets the size of the DC cable and fuse feeding it, which can be very large.',
  chargeAmps: 'Maximum DC charging current when the unit runs on shore power or the generator.',
  'shore-power.amps': 'Rating of the shore inlet and cord: 30 A or 50 A in North America, 16 A or 32 A in Europe.',
  'generator.watts': 'Continuous rated output of the AC generator.',
  // loads
  'dc-load.watts': 'How much power the item draws while running (from its label or manual). Watts ÷ volts = amps.',
  'ac-load.watts': 'How much power the item draws while running. AC loads run through the inverter take the same energy from the batteries, plus ~10% losses.',
  'dc-load.hoursPerDay': 'Typical hours per day it is switched on. Used for the energy budget and bank sizing, not for wire size.',
  'ac-load.hoursPerDay': 'Hours per day it runs from the inverter (batteries). Time on shore power does not count.',
  alwaysOn: 'Wired to the battery side of the main switch through its own fuse, so it keeps working when the boat is shut down. Use for bilge pumps and alarms.',
};

for (const c of CATALOG) {
  for (const d of c.defs) {
    d.help ??= PROP_HELP[`${c.kind}.${d.key}`] ?? PROP_HELP[`${c.category}.${d.key}`] ?? PROP_HELP[d.key];
  }
}

export const CATALOG_BY_KIND: Record<string, CatalogItem> = Object.fromEntries(CATALOG.map((c) => [c.kind, c]));

export const CATEGORY_LABELS: Record<Category, string> = {
  storage: 'Batteries',
  engine: 'Engine',
  charging: 'Charging & conversion',
  'ac-source': 'AC sources',
  'dc-load': 'DC loads',
  'ac-load': 'AC loads',
};

/**
 * Battery-bank roles that give equipment its own dedicated battery, and the load kinds each one powers.
 * The load is switched from the house DC panel through a relay but draws its power from that battery.
 */
export const DEDICATED_BANK_ROLES: Record<string, { label: string; kinds: EquipmentKind[] }> = {
  windlass: { label: 'Windlass', kinds: ['windlass'] },
  thruster: { label: 'Thruster', kinds: ['bow-thruster'] },
  winch: { label: 'Winch', kinds: ['electric-winch'] },
  fridge: { label: 'Refrigeration', kinds: ['fridge', 'freezer'] },
};

/** Dedicated-bank role that can power a given load kind, if any. */
export function dedicatedRoleFor(kind: EquipmentKind): string | undefined {
  return Object.keys(DEDICATED_BANK_ROLES).find((r) => DEDICATED_BANK_ROLES[r].kinds.includes(kind));
}

/** Heavy DC loads that are fed directly from the main bus rather than the panel. */
export const HEAVY_DC_THRESHOLD_A = 30;

export const DEFAULT_ZONES: Zone[] = [
  { id: 'bow', name: 'Bow / anchor locker', x: 0, rise: 2 },
  { id: 'vberth', name: 'V-berth', x: 6, rise: 1 },
  { id: 'mast', name: 'Mast (spreader height)', x: 13, rise: 25 },
  { id: 'masthead', name: 'Masthead', x: 13, rise: 50 },
  { id: 'saloon', name: 'Saloon', x: 17, rise: 1 },
  { id: 'bilge', name: 'Bilge', x: 18, rise: 0 },
  { id: 'nav', name: 'Nav station', x: 21, rise: 1 },
  { id: 'galley', name: 'Galley', x: 22, rise: 1 },
  { id: 'battery', name: 'Battery compartment', x: 22, rise: 0 },
  { id: 'engine', name: 'Engine room', x: 25, rise: 1 },
  { id: 'aft', name: 'Aft cabin / lazarette', x: 31, rise: 1 },
  { id: 'cockpit', name: 'Cockpit / helm', x: 30, rise: 3 },
  { id: 'arch', name: 'Arch / bimini', x: 36, rise: 7 },
  { id: 'transom', name: 'Transom', x: 38, rise: 2 },
];
