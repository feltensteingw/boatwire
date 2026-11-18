// Feet + AWG, or metres + mm².
//
// The model, the standards tables and every calculation stay in feet and AWG. This file turns
// those values into what the user reads and types, and back. Nothing here changes a result:
// a metric boat is sized exactly as before and then shown in metric.

import { GAUGES } from './standards';
import type { Units, Wire } from './types';

export type { Units };

export const M_PER_FT = 0.3048;
const KG_PER_LB = 0.45359237;

/** Standard metric conductor sizes, mm². */
export const METRIC_SIZES = [1, 1.5, 2.5, 4, 6, 10, 16, 25, 35, 50, 70, 95, 120];

const mm2Of = (awg: string) => GAUGES.find((g) => g.awg === awg)?.mm2;

/**
 * The metric cable to buy for a design size given in AWG: the smallest standard size with at
 * least as much copper, so it carries at least as much current with no more voltage drop.
 * (10 AWG is 5.3 mm², so 6 mm².)
 */
export function metricSize(awg: string): number | undefined {
  const mm2 = mm2Of(awg);
  if (mm2 === undefined) return undefined;
  return METRIC_SIZES.find((s) => s >= mm2 - 0.05) ?? METRIC_SIZES[METRIC_SIZES.length - 1];
}

/**
 * The AWG size that stands in for an installed metric cable in the checks: the largest one
 * with no more copper than the cable really has, so the check never flatters it.
 * (6 mm² is checked as 10 AWG, 5.3 mm².)
 */
export function awgForMetric(mm2: number): string {
  let best = GAUGES[0].awg;
  for (const g of GAUGES) if (g.mm2 <= mm2 + 0.05) best = g.awg;
  return best;
}

/** A conductor size in words: "10 AWG" or "6 mm²". */
export function fmtSize(awg: string | undefined, units: Units): string {
  if (!awg) return '—';
  if (units === 'metric') {
    const m = metricSize(awg);
    return m === undefined ? awg : `${m} mm²`;
  }
  return `${awg} AWG`;
}

/** Compact size for a label on the diagram: "10", "2× 4/0", "10/3"; or "6 mm²", "2× 120 mm²", "3G6". */
export function cableLabel(w: Pick<Wire, 'gauge' | 'cable' | 'kind'>, units: Units): string | undefined {
  if (!w.gauge) return undefined;
  const parallel = w.cable?.match(/^(\d+)× /);
  if (units === 'metric') {
    const m = metricSize(w.gauge) ?? w.gauge;
    if (parallel) return `${parallel[1]}× ${m} mm²`;
    // 3G6: three cores including the green/yellow earth, 6 mm² each.
    return w.kind === 'ac' ? `3G${m}` : `${m} mm²`;
  }
  return w.cable ?? (w.kind === 'ac' ? `${w.gauge}/3` : w.gauge);
}

/** The same, spelled out for a table or a sentence: "2× 4/0 AWG", "10/3 AWG", "3G6 mm²". */
export function cableText(w: Pick<Wire, 'gauge' | 'cable' | 'kind'>, units: Units): string {
  const c = cableLabel(w, units);
  if (!c) return '—';
  if (units === 'metric') return c.endsWith('mm²') ? c : `${c} mm²`;
  return `${c} AWG`;
}

export const lenUnit = (units: Units) => (units === 'metric' ? 'm' : 'ft');
const round1 = (x: number) => Math.round(x * 10) / 10;

/** A length held in feet, as the number to show: feet, or metres to one decimal. */
export const toLen = (ft: number, units: Units) => (units === 'metric' ? round1(ft * M_PER_FT) : round1(ft));
/** A number the user typed, back to feet. */
export const fromLen = (v: number, units: Units) => (units === 'metric' ? Math.round((v / M_PER_FT) * 100) / 100 : v);
/** "12 ft" or "3.7 m". */
export const fmtLen = (ft: number, units: Units) => `${toLen(ft, units)} ${lenUnit(units)}`;
/** A short distance held in inches: "7 in" or "18 cm". */
export const fmtShort = (inches: number, units: Units) => (units === 'metric' ? `${Math.round(inches * 2.54)} cm` : `${Math.round(inches)} in`);
/** A weight held in pounds: "12.3 lb" or "5.6 kg". */
export const toWeight = (lb: number, units: Units) => (units === 'metric' ? round1(lb * KG_PER_LB) : round1(lb));
export const weightUnit = (units: Units) => (units === 'metric' ? 'kg' : 'lb');
