// ---------------------------------------------------------------------------
// STANDARDS DATA — single source of truth for every number the rules use.
//
// Values are seeded from widely published marine references (ABYC E-11
// ampacity table for 105 °C insulation as reproduced by Blue Sea Systems and
// others, and the standard ABYC voltage-drop formula). They have NOT been
// verified against the current paid ABYC E-11 text. Replace values here if
// you hold the standard; nothing else in the code embeds these numbers.
// ---------------------------------------------------------------------------

export const STANDARDS_VERIFIED = false;

export interface GaugeSpec {
  awg: string;
  /** Circular mils. */
  cm: number;
  /** mm² (approx. metric equivalent). */
  mm2: number;
  /** Ampacity, single conductor, 105 °C insulation, outside engine spaces. */
  ampacity105: number;
}

/** Smallest to largest. */
export const GAUGES: GaugeSpec[] = [
  { awg: '18', cm: 1620, mm2: 0.8, ampacity105: 20 },
  { awg: '16', cm: 2580, mm2: 1.3, ampacity105: 25 },
  { awg: '14', cm: 4110, mm2: 2.1, ampacity105: 35 },
  { awg: '12', cm: 6530, mm2: 3.3, ampacity105: 45 },
  { awg: '10', cm: 10380, mm2: 5.3, ampacity105: 60 },
  { awg: '8', cm: 16510, mm2: 8.4, ampacity105: 80 },
  { awg: '6', cm: 26240, mm2: 13.3, ampacity105: 120 },
  { awg: '4', cm: 41740, mm2: 21.2, ampacity105: 160 },
  { awg: '2', cm: 66360, mm2: 33.6, ampacity105: 210 },
  { awg: '1', cm: 83690, mm2: 42.4, ampacity105: 245 },
  { awg: '1/0', cm: 105600, mm2: 53.5, ampacity105: 285 },
  { awg: '2/0', cm: 133100, mm2: 67.4, ampacity105: 330 },
  { awg: '3/0', cm: 167800, mm2: 85.0, ampacity105: 385 },
  { awg: '4/0', cm: 211600, mm2: 107.2, ampacity105: 445 },
];

/**
 * Ampacity of sheathed multi-conductor AC cable (hot/neutral/ground), using
 * conservative common-practice values (e.g. 30 A shore power → 10/3,
 * 50 A → 6/3). Applies to AC branch and feeder circuits.
 */
export const AC_CABLE_AMPACITY: Record<string, number> = {
  '14': 15,
  '12': 20,
  '10': 30,
  '8': 40,
  '6': 55,
  '4': 70,
  '2': 95,
  '1': 110,
  '1/0': 125,
  '2/0': 145,
  '3/0': 165,
  '4/0': 195,
};
export const MIN_GAUGE_AC = '14';

/** Ampacity multiplier for conductors routed through engine spaces (105 °C). */
export const ENGINE_SPACE_DERATE = 0.82;

/** ABYC constant for copper in the voltage-drop formula CM = K·I·L / E. */
export const VDROP_K = 10.75;

/** Voltage-drop limits (percent). */
export const VDROP = {
  critical: 3,
  nonCritical: 10,
};

/** Minimum conductor size outside panels/harnesses. */
export const MIN_GAUGE = '16';

/** Over-current device must sit within this many inches of a battery terminal. */
export const BATTERY_FUSE_MAX_IN = 7;
/** …or within this distance if the conductor is sheathed/in conduit. */
export const BATTERY_FUSE_SHEATHED_MAX_IN = 72;

/** Branch circuit protection = load × factor, rounded up to a standard size. */
export const PROTECTION_FACTOR = 1.25;

export const STANDARD_FUSES = [
  1, 2, 3, 5, 7.5, 10, 15, 20, 25, 30, 35, 40, 50, 60, 70, 80, 100, 125, 150, 175, 200, 225, 250, 300,
  350, 400, 500, 600,
];
export const STANDARD_BREAKERS_DC = [5, 10, 15, 20, 25, 30, 40, 50, 60, 70, 80, 100, 120, 150];
export const STANDARD_BREAKERS_AC = [10, 15, 20, 25, 30, 40, 50];

/** Fuse families with practical max rating and interrupt capacity (AIC, amps @ DC). */
export const FUSE_CLASSES = {
  ATC: { max: 30, aic: 1000, desc: 'Blade fuse (ATC/ATO) in fuse block' },
  MIDI: { max: 200, aic: 2000, desc: 'MIDI/AMI bolt-down fuse' },
  MRBF: { max: 300, aic: 10000, desc: 'Terminal fuse (MRBF) on battery post' },
  ANL: { max: 750, aic: 6000, desc: 'ANL fuse' },
  'Class T': { max: 800, aic: 20000, desc: 'Class T fuse — high interrupt capacity' },
} as const;
export type FuseClass = keyof typeof FUSE_CLASSES;

/** Usable fraction of nameplate capacity used for bank sizing. */
export const USABLE_DOD: Record<string, number> = {
  flooded: 0.5,
  agm: 0.5,
  gel: 0.5,
  lifepo4: 0.8,
};

/** Charge voltage per 12 V nominal (used to estimate charger output current). */
export const CHARGE_V_PER_12 = 14.2;

export const AC_STANDARDS = {
  us120: { volts: 120, hz: 60, shoreOptions: [30, 50], label: '120 V / 60 Hz (North America)' },
  eu230: { volts: 230, hz: 50, shoreOptions: [16, 32], label: '230 V / 50 Hz (Europe / intl.)' },
} as const;

/** ELCI / RCD trip setting for shore power main breaker. */
export const ELCI_TRIP_MA = 30;
/** Shore-power main breaker must be within this distance of the inlet (wire length, ft). */
export const SHORE_MAIN_MAX_FT = 10;

/** Rule sources used in explanations. */
export const REFS = {
  E11: 'ABYC E-11 (AC & DC Electrical Systems on Boats)',
  E10: 'ABYC E-10 (Storage Batteries)',
  E13: 'ABYC E-13 (Lithium Ion Batteries)',
  A31: 'ABYC A-31 (Battery Chargers & Inverters)',
  A28: 'ABYC A-28 (Galvanic Isolators)',
  TE13: 'Manufacturer guidance (Victron / Blue Sea / Balmar)',
};
