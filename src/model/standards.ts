// ---------------------------------------------------------------------------
// STANDARDS DATA — single source of truth for every number the rules use.
//
// Checked on 2026-11-19 against Blue Sea Systems' published tables, which
// summarise ABYC E-11: the Blue Sea Systems 2023 Catalog, pages 159, 160,
// 164, 165 and 86. bluesea.com refused automated reads (HTTP 403), so the
// pages were read from a copy of the catalog hosted by a Blue Sea
// distributor (delzer.com). Each table below names the page it was checked
// against, or says that Blue Sea does not publish it.
//
// Corrected from that check: the engine-space factor for DC wire (0.82 →
// 0.85) and the condition on the 72 in battery-fuse distance. Added: the
// 40 in battery-fuse distance and the bundling table. Derated DC ratings
// are rounded to whole amps, as Blue Sea prints them (see ampacity()).
//
// Not checked, because Blue Sea does not publish them in the pages read:
// AC cable ampacity, the minimum wire sizes, the interrupt rating of each
// fuse type (FUSE_CLASSES), the voltage-drop constant (taken from Ancor and
// BEP instead), and circular mils for 18 to 1 AWG. Values that one check
// matched but another did not confirm were left as they were.
//
// Published but not used: p.164's table of the interrupt rating a DC main
// or branch fuse needs, by the cold-cranking amps of the batteries behind
// it. BoatWire checks interrupt ratings only for fuses on a lithium battery
// (LITHIUM_FUSE_MIN_AIC).
//
// A published summary is not the ABYC standard itself, so STANDARDS_VERIFIED
// stays false and the app keeps its safety notice. Replace values here if
// you hold the standard; nothing else in the code embeds these numbers.
// ---------------------------------------------------------------------------

export const STANDARDS_VERIFIED = false;

export interface GaugeSpec {
  awg: string;
  /** Circular mils. */
  cm: number;
  /** mm² (approx. metric equivalent). */
  mm2: number;
  /** Ampacity, single conductor in free air, 105 °C insulation, 30 °C ambient, outside engine spaces. */
  ampacity105: number;
}

/**
 * Smallest to largest.
 *
 * Source for `ampacity105` and `mm2`: Blue Sea Systems 2023 Catalog p.164, "ABYC Ampacity Rating
 * Table at 30°C" (data from ABYC E-11 Table VI-A), https://www.delzer.com/oneasg/bss_cat/164/
 * (a distributor's copy of the catalog), read 2026-11-19. `mm2` agrees with Blue Sea's figures
 * rounded the same way, except 2/0: Blue Sea prints 68, but 133,100 cmil is 67.4 mm², which is
 * kept. `cm` for 2/0 to 4/0 matches Ancor Catalog 2024 p.64,
 * https://docs.navico.com/view/362211770/64/; Blue Sea does not publish circular mils for 18 to 1 AWG.
 */
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
 * Ampacity of a 105 °C conductor run with one or two other current-carrying conductors in a
 * sheath, conduit or bundle (outside engine spaces, 30 °C ambient), by AWG. Source: Blue Sea
 * Systems 2023 Catalog p.164, "Data based on E-11 Table VI-B (Up to three conductors in a sheath,
 * conduit or bundle)", https://www.delzer.com/oneasg/bss_cat/164/ (a distributor's copy of the
 * catalog), read 2026-11-19. Applied to DC conductors only.
 */
export const AMPACITY_105_BUNDLED: Record<string, number> = {
  '18': 14,
  '16': 18,
  '14': 25,
  '12': 32,
  '10': 42,
  '8': 56,
  '6': 84,
  '4': 112,
  '2': 147,
  '1': 172,
  '1/0': 200,
  '2/0': 231,
  '3/0': 270,
  '4/0': 312,
};

/**
 * Multipliers on AMPACITY_105_BUNDLED for larger bundles: from this many current-carrying
 * conductors in all, smallest first. Source: Blue Sea Systems 2023 Catalog p.164 (as above):
 * "For bundles of 4 to 6 conductors multiply by 0.857", 7 to 24 by 0.714, 25 or more by 0.571.
 */
export const BUNDLE_FACTORS: readonly { from: number; factor: number }[] = [
  { from: 4, factor: 0.857 },
  { from: 7, factor: 0.714 },
  { from: 25, factor: 0.571 },
];

/**
 * Ampacity of sheathed multi-conductor AC cable (hot/neutral/ground), using
 * conservative common-practice values (e.g. 30 A shore power → 10/3,
 * 50 A → 6/3). Applies to AC branch and feeder circuits.
 *
 * Not published by Blue Sea Systems (no AC cable table in its 2023 Catalog, p.165 checked
 * 2026-11-19). Every value is below Blue Sea's nearest figures, the "up to three conductors in a
 * sheath" set on p.164 (e.g. 30 A against 42 A for 10 AWG), and at or below its figures for 7 to
 * 24 bundled conductors (VI-B × 0.714, in whole amps); only bundles of 25 or more are rated lower.
 * So it errs on the safe side.
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
/** Smallest AC cable. Not published by Blue Sea Systems; not checked. */
export const MIN_GAUGE_AC = '14';

/**
 * Ampacity multiplier for 105 °C DC conductors routed through engine spaces (50 °C ambient).
 * Blue Sea Systems prints no factor, but its inside-engine-space column is 0.85 × the outside
 * column, rounded to whole amps, on every AWG row (not on every metric row: 1.5 mm² is 29/24):
 * 2023 Catalog p.164, https://www.delzer.com/oneasg/bss_cat/164/ (a distributor's copy of the
 * catalog), read 2026-11-19. Ancor Catalog 2024 p.64 states 0.85,
 * https://docs.navico.com/view/362211770/64/. The 0.82 used before is Blue Sea's 90 °C figure.
 */
export const ENGINE_SPACE_DERATE = 0.85;

/**
 * Ampacity multiplier for AC cable routed through engine spaces. Not published by Blue Sea
 * Systems, which gives 0.85 only for 105 °C single conductors; kept at the earlier 0.82 and not checked.
 */
export const AC_ENGINE_SPACE_DERATE = 0.82;

/**
 * ABYC constant for copper in the voltage-drop formula CM = K·I·L / E. Not published by Blue Sea
 * Systems. Source: Ancor Catalog 2024 p.62, https://docs.navico.com/view/362211770/62/, and BEP
 * Catalog p.97, https://docs.navico.com/view/777950233/97/, both read 2026-11-19.
 */
export const VDROP_K = 10.75;

/**
 * Voltage-drop limits (percent), over the round trip (positive plus negative length).
 * Source: Blue Sea Systems 2023 Catalog p.159, "Choose the Correct Wire",
 * https://www.delzer.com/oneasg/bss_cat/159/ (a distributor's copy of the catalog), read 2026-11-19.
 */
export const VDROP = {
  critical: 3,
  nonCritical: 10,
};

/** Minimum conductor size outside panels/harnesses. Not published by Blue Sea Systems; not checked. */
export const MIN_GAUGE = '16';

// Battery fuse distances. Source for the three distances: Blue Sea Systems 2023 Catalog p.164,
// "DC Main Circuit Protection and Branch Circuit Protection", https://www.delzer.com/oneasg/bss_cat/164/
// (a distributor's copy of the catalog), read 2026-11-19. It measures them from the "power source"
// and gives 72 in for a conductor "connected directly to the battery and housed in a sheath or
// enclosure". The wording on the point of connection to the DC system, and on a sheath for the
// whole length, is ABYC E-11 as quoted by Blue Sea's article 99 on bluesea.com, seen only in
// search-engine excerpts and not opened.

/** Over-current device must sit within this many inches of the battery or of the point where the conductor connects to the DC system. */
export const BATTERY_FUSE_MAX_IN = 7;
/** …or within this distance if the conductor connects directly to the battery terminal and is in a sheath or enclosure for its whole length. */
export const BATTERY_FUSE_SHEATHED_MAX_IN = 72;
/** …or within this distance for a conductor in a sheath or enclosure that does not connect directly to the battery. No check uses it yet. */
export const SHEATHED_NOT_AT_BATTERY_FUSE_MAX_IN = 40;

/**
 * Branch circuit protection = load × factor, rounded up to a standard size.
 * Source: Blue Sea Systems 2023 Catalog p.160, "Choose the Correct Fuse and Fuse Amperage",
 * https://www.delzer.com/oneasg/bss_cat/160/ (a distributor's copy of the catalog), read 2026-11-19.
 */
export const PROTECTION_FACTOR = 1.25;

/** Stock sizes of fuses and breakers: product lists, not standards values. Not checked. */
export const STANDARD_FUSES = [
  1, 2, 3, 5, 7.5, 10, 15, 20, 25, 30, 35, 40, 50, 60, 70, 80, 100, 125, 150, 175, 200, 225, 250, 300,
  350, 400, 500, 600,
];
export const STANDARD_BREAKERS_DC = [5, 10, 15, 20, 25, 30, 40, 50, 60, 70, 80, 100, 120, 150];
export const STANDARD_BREAKERS_AC = [10, 15, 20, 25, 30, 40, 50];

/**
 * Fuse families with practical max rating and interrupt capacity (AIC, amps @ DC). Not published by
 * Blue Sea Systems, which gives the interrupt rating a circuit needs (p.164), not what each fuse
 * type has; not checked.
 */
export const FUSE_CLASSES = {
  ATC: { max: 30, aic: 1000, desc: 'Blade fuse (ATC/ATO) in fuse block' },
  MIDI: { max: 200, aic: 2000, desc: 'MIDI/AMI bolt-down fuse' },
  MRBF: { max: 300, aic: 10000, desc: 'Terminal fuse (MRBF) on battery post' },
  ANL: { max: 750, aic: 6000, desc: 'ANL fuse' },
  'Class T': { max: 800, aic: 20000, desc: 'Class T fuse — high interrupt capacity' },
} as const;
export type FuseClass = keyof typeof FUSE_CLASSES;

/**
 * Smallest interrupt rating (AIC, amps) accepted for a fuse connected straight to a lithium
 * battery. Only Class T meets it. The same policy the ideal design follows. Matches the top DC
 * main tier on Blue Sea Systems 2023 Catalog p.164 (above 2,200 CCA: 20,000 AIC at 125 V DC, or
 * the battery's short-circuit rating), as above; applying it to every lithium bank is BoatWire's
 * own policy.
 */
export const LITHIUM_FUSE_MIN_AIC = 20000;

/** Usable fraction of nameplate capacity used for bank sizing. */
export const USABLE_DOD: Record<string, number> = {
  flooded: 0.5,
  agm: 0.5,
  gel: 0.5,
  lifepo4: 0.8,
};

/** Share of the DC power an inverter draws that comes out as AC. One figure for the design, the check and the energy budget. */
export const INVERTER_EFFICIENCY = 0.9;

/**
 * Battery voltage under heavy load, as a fraction of nominal (10.5 V on a 12 V system).
 * Inverter cables and fuses are sized for the current drawn at this voltage, which is the
 * highest it gets.
 */
export const LOW_BATTERY_FACTOR = 0.875;

/** Efficiency of a DC-DC converter (24 → 12 V). */
export const CONVERTER_EFFICIENCY = 0.9;

/** Input current of a DC-DC battery charger as a multiple of its rated output (conversion losses). */
export const DCDC_INPUT_FACTOR = 1.15;

/** Output ratings (A) of the DC-DC charger that keeps a start battery charged from the house bank, smallest first. */
export const START_DCDC_SIZES: Record<12 | 24, number[]> = { 12: [10, 18], 24: [12] };

/**
 * Assumptions behind the energy budget. Typical cruising values: the real figures depend on
 * latitude, season and how the boat is used.
 */
export const ENERGY_ASSUMPTIONS = {
  /** Hours a day of full-strength sun. */
  solarPeakHours: 4.5,
  /** Share of a panel's rating actually delivered (heat, angle, shading, controller). */
  solarDerate: 0.75,
  /** Average output of a wind or hydro generator as a share of its rating. */
  windHydroCapacityFactor: 0.2,
  /** Days the house bank should last without charging. */
  daysAutonomy: 2,
  /**
   * Share of the normal solar, wind and hydro output counted on during those days.
   * 0 means the bank must carry the boat with no charging at all, the cautious rule of thumb.
   */
  chargingDuringAutonomy: 0,
  /** Hours a day on shore power with the charger running. */
  shoreHoursPerDay: 0,
  /** Hours a day the engine runs whatever the batteries need (motoring). */
  engineHoursPerDay: 0,
  /** Share of the alternator's rating that ends up in the bank: lead-acid tapers as it fills, lithium takes nearly all of it. */
  alternatorChargeEfficiency: { lead: 0.6, lifepo4: 0.85 },
} as const;

/** The assumptions a boat owner can change, with the range each is held to. */
export const ENERGY_LIMITS = {
  solarPeakHours: [0, 12],
  solarDerate: [0.1, 1],
  windHydroCapacityFactor: [0, 1],
  daysAutonomy: [0.5, 14],
  chargingDuringAutonomy: [0, 1],
  shoreHoursPerDay: [0, 24],
  engineHoursPerDay: [0, 24],
} as const satisfies Record<string, readonly [number, number]>;

/**
 * Ready-made conditions for the energy budget. The sun figures are rough, typical values for
 * peak sun hours, not measurements for any place: they have not been checked against a solar
 * resource table. They are starting points for the owner to adjust.
 */
export const ENERGY_PRESETS = {
  sun: [
    { id: 'typical', label: 'Typical cruising season', set: { solarPeakHours: 4.5 } },
    { id: 'tropics', label: 'Tropics', set: { solarPeakHours: 5.5 } },
    { id: 'mid-summer', label: 'Mid-latitudes, summer', set: { solarPeakHours: 6 } },
    { id: 'mid-winter', label: 'Mid-latitudes, winter', set: { solarPeakHours: 2.5 } },
    { id: 'high-summer', label: 'High latitudes, summer', set: { solarPeakHours: 5 } },
    { id: 'high-winter', label: 'High latitudes, winter', set: { solarPeakHours: 1 } },
  ],
  use: [
    { id: 'anchor', label: 'At anchor', set: { shoreHoursPerDay: 0, engineHoursPerDay: 0 } },
    { id: 'marina', label: 'In a marina, plugged in', set: { shoreHoursPerDay: 24, engineHoursPerDay: 0 } },
    { id: 'passage', label: 'On passage, motoring 4 h a day', set: { shoreHoursPerDay: 0, engineHoursPerDay: 4 } },
  ],
} as const;

/** Charge voltage per 12 V nominal (used to estimate charger output current). */
export const CHARGE_V_PER_12 = 14.2;

/**
 * Shore power ratings by AC standard. Source for the 30/50 A and 16/32 A ratings: Blue Sea Systems
 * 2023 Catalog p.165, https://www.delzer.com/oneasg/bss_cat/165/ (a distributor's copy of the
 * catalog), read 2026-11-19.
 */
export const AC_STANDARDS = {
  us120: { volts: 120, hz: 60, shoreOptions: [30, 50], label: '120 V / 60 Hz (North America)' },
  eu230: { volts: 230, hz: 50, shoreOptions: [16, 32], label: '230 V / 50 Hz (Europe / intl.)' },
} as const;

/** ELCI / RCD trip setting for shore power main breaker. Source: Blue Sea Systems 2023 Catalog p.165 (as for AC_STANDARDS). */
export const ELCI_TRIP_MA = 30;
/**
 * Shore-power main breaker must be within this distance of the inlet (wire length, ft).
 * Source: Blue Sea Systems 2023 Catalog p.86, "AC Ground Faults: ELCI, the Boater and ABYC",
 * https://www.delzer.com/oneasg/bss_cat/86/ (a distributor's copy of the catalog), read
 * 2026-11-19. Blue Sea states it for the ELCI and does not say whether it is measured along the wire.
 */
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
