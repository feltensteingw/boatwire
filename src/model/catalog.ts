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
    props: { starterAmps: 150, alternatorAmps: 90, regulator: 'internal' },
    defs: [
      { key: 'starterAmps', label: 'Starter current (at 12 V)', type: 'number', unit: 'A', min: 0, help: 'Typical 30–50 hp diesel: 120–200 A at 12 V. Halved automatically for 24 V.' },
      { key: 'alternatorAmps', label: 'Alternator output', type: 'number', unit: 'A', min: 0 },
      { key: 'regulator', label: 'Alternator regulation', type: 'select', options: [
        { value: 'internal', label: 'Internal regulator (stock)' },
        { value: 'external', label: 'External smart regulator' },
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
    help: 'Heavy motor load: fed from the main bus through its own breaker and a reversing contactor.',
  }),
  dc('bow-thruster', 'Bow thruster', 'THR', 'bow', 3000, 0.02),
  dc('electric-winch', 'Electric winch', 'WIN', 'cockpit', 1000, 0.05),
  dc('custom-dc', 'Custom DC load', 'DC', 'saloon', 50, 1),

  // ---- AC loads
  ac('ac-outlets', 'AC outlets', '⏚', 'saloon', 300, 1, false),
  ac('water-heater', 'Water heater', 'WH', 'engine', 1500, 0, true),
  ac('air-conditioner', 'Air conditioner', 'A/C', 'saloon', 1200, 0, true),
  ac('microwave', 'Microwave', 'MW', 'galley', 1000, 0.2, false),
  ac('induction-cooktop', 'Induction cooktop', 'IND', 'galley', 1800, 0.5, false),
  ac('custom-ac', 'Custom AC load', 'AC', 'saloon', 200, 1, false),
];

export const CATALOG_BY_KIND: Record<string, CatalogItem> = Object.fromEntries(CATALOG.map((c) => [c.kind, c]));

export const CATEGORY_LABELS: Record<Category, string> = {
  storage: 'Batteries',
  engine: 'Engine',
  charging: 'Charging & conversion',
  'ac-source': 'AC sources',
  'dc-load': 'DC loads',
  'ac-load': 'AC loads',
};

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
