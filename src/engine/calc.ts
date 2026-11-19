import {
  AC_CABLE_AMPACITY,
  ENGINE_SPACE_DERATE,
  FUSE_CLASSES,
  INVERTER_EFFICIENCY,
  LOW_BATTERY_FACTOR,
  MIN_GAUGE_AC,
  GAUGES,
  MIN_GAUGE,
  PROTECTION_FACTOR,
  STANDARD_BREAKERS_AC,
  STANDARD_BREAKERS_DC,
  STANDARD_FUSES,
  VDROP_K,
  type FuseClass,
  type GaugeSpec,
} from '../model/standards';
import type { BoatProfile, Wire, Zone } from '../model/types';

export function gaugeSpec(awg: string): GaugeSpec | undefined {
  return GAUGES.find((g) => g.awg === awg);
}

export function gaugeIndex(awg: string): number {
  return GAUGES.findIndex((g) => g.awg === awg);
}

export function ampacity(awg: string, inEngineSpace = false, acCable = false): number {
  const g = gaugeSpec(awg);
  if (!g) return 0;
  const base = acCable ? (AC_CABLE_AMPACITY[awg] ?? 0) : g.ampacity105;
  return base * (inEngineSpace ? ENGINE_SPACE_DERATE : 1);
}

/**
 * Voltage drop in percent.
 * @param oneWayFt one-way run length; the conductor path is round trip for DC
 *   and for single-phase AC (hot + neutral), so we double it.
 */
export function vdropPct(amps: number, oneWayFt: number, awg: string, volts: number): number {
  const g = gaugeSpec(awg);
  if (!g || volts <= 0) return Infinity;
  const vd = (VDROP_K * amps * (oneWayFt * 2)) / g.cm;
  return (vd / volts) * 100;
}

export interface SizeResult {
  gauge: string;
  vdropPct: number;
  limitedBy: 'ampacity' | 'vdrop' | 'minimum';
  /** True when even the largest gauge cannot meet the requirement. */
  overflow: boolean;
}

/**
 * Smallest conductor meeting (a) ampacity ≥ required amps (normally the
 * protection rating, so the device protects the wire) and (b) voltage drop
 * ≤ limit at the design current.
 */
export function sizeConductor(opts: {
  designAmps: number;
  protectAmps: number;
  oneWayFt: number;
  volts: number;
  vdropLimit: number;
  inEngineSpace?: boolean;
  minGauge?: string;
  /** Size as sheathed multi-conductor AC cable. */
  ac?: boolean;
}): SizeResult {
  const minIdx = Math.max(0, gaugeIndex(opts.minGauge ?? (opts.ac ? MIN_GAUGE_AC : MIN_GAUGE)));
  let ampIdx = -1;
  let vdIdx = -1;
  for (let i = 0; i < GAUGES.length; i++) {
    if (ampIdx < 0 && ampacity(GAUGES[i].awg, opts.inEngineSpace, opts.ac) >= opts.protectAmps) ampIdx = i;
    if (vdIdx < 0 && vdropPct(opts.designAmps, opts.oneWayFt, GAUGES[i].awg, opts.volts) <= opts.vdropLimit)
      vdIdx = i;
  }
  const overflow = ampIdx < 0 || vdIdx < 0;
  const a = ampIdx < 0 ? GAUGES.length - 1 : ampIdx;
  const v = vdIdx < 0 ? GAUGES.length - 1 : vdIdx;
  const idx = Math.max(minIdx, a, v);
  const limitedBy = idx === minIdx && minIdx > Math.max(a, v) ? 'minimum' : v >= a ? 'vdrop' : 'ampacity';
  const awg = GAUGES[idx].awg;
  return { gauge: awg, vdropPct: vdropPct(opts.designAmps, opts.oneWayFt, awg, opts.volts), limitedBy, overflow };
}

/**
 * DC current an inverter draws at full output, in amps: its AC watts, divided by its efficiency,
 * at low battery voltage. The ideal design and the check of a hand-drawn boat both use this.
 */
export function inverterDcAmps(watts: number, systemVolts: number): number {
  return watts / (systemVolts * LOW_BATTERY_FACTOR * INVERTER_EFFICIENCY);
}

/** A power wire with no conductor size recorded. Nothing about it can be checked until it has one. */
export function isUnsized(w: Pick<Wire, 'gauge' | 'kind'>): boolean {
  return !w.gauge && (w.kind === 'pos' || w.kind === 'neg' || w.kind === 'ac');
}

/**
 * The smallest size in `list` (smallest first) of at least `amps`, or `undefined` when even the
 * largest is too small. The generator goes through Builder.rating, which reports that case.
 */
export function nextStandard(amps: number, list: readonly number[]): number | undefined {
  return list.find((s) => s >= amps);
}

/**
 * Standard sizes of each kind of protective device. A `feeder-fuse` is on a main feeder or at a
 * battery, where it is a Class T above 300 A (see fuseClassFor), so its sizes go on up to the
 * largest Class T, as the main battery fuse does. Other fuses stop at the largest standard size.
 */
export const PROTECTION_SIZES = {
  fuse: STANDARD_FUSES,
  'feeder-fuse': [...STANDARD_FUSES, FUSE_CLASSES['Class T'].max],
  'breaker-dc': STANDARD_BREAKERS_DC,
  'breaker-ac': STANDARD_BREAKERS_AC,
} as const;
export type ProtectionKind = keyof typeof PROTECTION_SIZES;

/** Rating a protective device needs for a continuous load, before rounding up to a standard size. */
export function protectionNeeded(loadAmps: number): number {
  return Math.max(1, loadAmps * PROTECTION_FACTOR);
}

/**
 * Protection rating for a continuous load, or `undefined` when it is above every standard size of
 * that kind. The generator goes through Builder.protection, which reports that case.
 */
export function protectionFor(loadAmps: number, kind: ProtectionKind = 'fuse'): number | undefined {
  return nextStandard(protectionNeeded(loadAmps), PROTECTION_SIZES[kind]);
}

/** Pick a fuse family for a given position and rating. */
export function fuseClassFor(rating: number, opts: { atBattery?: boolean; lithium?: boolean; mainFeeder?: boolean }): FuseClass {
  if (opts.atBattery && (opts.lithium || rating > 300)) return 'Class T';
  if (opts.mainFeeder && rating > 300) return 'Class T';
  if (opts.atBattery) return 'MRBF';
  if (rating <= 30) return 'ATC';
  if (rating <= 200) return 'MIDI';
  return 'ANL';
}

export function zoneById(profile: BoatProfile, id: string): Zone | undefined {
  return profile.zones.find((z) => z.id === id);
}

/** Run length assumed when one end is in a zone that is not in the list. The design check reports these. */
export const MISSING_ZONE_RUN_FT = 10;

/** Estimated one-way cable run between two zones, feet (includes 2 ft of slack/terminations). */
export function runLength(profile: BoatProfile, zoneA: string, zoneB: string): number {
  if (zoneA === zoneB) return 3;
  const a = zoneById(profile, zoneA);
  const b = zoneById(profile, zoneB);
  if (!a || !b) return MISSING_ZONE_RUN_FT;
  // Cables follow the hull, not a straight line: add 20% routing allowance.
  return Math.round((Math.abs(a.x - b.x) * 1.2 + a.rise + b.rise + 2) * 10) / 10;
}

export function fmtAmps(a: number | undefined): string {
  if (a === undefined) return '—';
  return a >= 10 ? `${Math.round(a)} A` : `${Math.round(a * 10) / 10} A`;
}

export function fmtGauge(awg: string | undefined): string {
  if (!awg) return '—';
  const g = gaugeSpec(awg);
  return g ? `${awg} AWG (${g.mm2} mm²)` : awg;
}
