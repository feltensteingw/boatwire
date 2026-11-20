import { CATALOG_BY_KIND, MAX_ENGINES } from '../model/catalog';
import { AC_STANDARDS, ENERGY_ASSUMPTIONS, ENERGY_LIMITS, INVERTER_EFFICIENCY, USABLE_DOD } from '../model/standards';
import type { Chemistry, EnergyAssumptions, Equipment, Project, Scenario, SystemVoltage } from '../model/types';
import { effectiveEquipment, scenarioVoltage } from './scenario';

export interface EnergyRow {
  id: string;
  name: string;
  watts: number;
  amps: number;
  hoursPerDay: number;
  dutyCycle: number;
  ahPerDay: number;
  whPerDay: number;
  ac: boolean;
}

export interface EnergyBudget {
  volts: SystemVoltage;
  rows: EnergyRow[];
  totalAhPerDay: number;
  totalWhPerDay: number;
  houseAh: number;
  houseChemistry?: Chemistry;
  usableAh: number;
  recommendedAh: number;
  daysAutonomy: number;
  solarAhPerDay: number;
  windHydroAhPerDay: number;
  /** From the battery charger(s) while on shore power: what is needed, up to what the hours assumed allow. */
  shoreAhPerDay: number;
  /** From the alternator in the hours the engine is assumed to run anyway: what is still needed, up to what those hours allow. */
  engineAhPerDay: number;
  /** The most the charger and the alternator could put back in the hours assumed. */
  shoreCanGiveAhPerDay: number;
  engineCanGiveAhPerDay: number;
  /** All charging in a day under the assumptions. */
  chargingAhPerDay: number;
  /** Daily use that the charging does not cover (0 when it does). */
  shortfallAhPerDay: number;
  /** Solar and wind charge beyond the day's use (0 when there is a shortfall). */
  surplusAhPerDay: number;
  /** Output of every alternator drawn, together, at the system voltage. */
  alternatorAmps: number;
  /** How many alternators that is: one per engine drawn, up to two. */
  alternators: number;
  /** Output of the battery charger(s), 0 with no shore power aboard. */
  chargerAmps: number;
  /** Engine hours a day that would cover everything solar, wind and shore power do not. Infinity with no alternator. */
  engineHoursToBalance: number;
  /** Engine hours a day needed on top of the hours assumed, to cover the shortfall. Infinity with no alternator and a shortfall. */
  extraEngineHours: number;
  /** The figures this budget was worked out with, for showing next to it. */
  assumptions: EnergyAssumptions & { inverterEfficiency: number; alternatorChargeEfficiency: number };
}

const OWNER_KEYS = Object.keys(ENERGY_LIMITS) as (keyof EnergyAssumptions)[];

/** A value an owner entered, held to its range. Anything that is not a number falls back to the default. */
export function clampAssumption(key: keyof EnergyAssumptions, value: unknown): number {
  const [lo, hi] = ENERGY_LIMITS[key];
  return typeof value === 'number' && Number.isFinite(value) ? Math.min(hi, Math.max(lo, value)) : ENERGY_ASSUMPTIONS[key];
}

/**
 * The assumptions in force: the defaults, then what the owner set for the boat, then what they
 * set for this scenario.
 */
export function energyAssumptions(project: Project, scenario?: Scenario): EnergyAssumptions {
  const out = {} as EnergyAssumptions;
  for (const k of OWNER_KEYS) out[k] = clampAssumption(k, scenario?.energy?.[k] ?? project.energy?.[k] ?? ENERGY_ASSUMPTIONS[k]);
  return out;
}

/** "two days", "1 day", "3.5 days": the days of autonomy in a sentence. */
export function daysText(days: number): string {
  return days === 2 ? 'two days' : days === 1 ? '1 day' : `${days} days`;
}


export function num(e: Equipment, key: string, dflt = 0): number {
  const v = e.props[key];
  return typeof v === 'number' ? v : typeof v === 'string' && v !== '' && !isNaN(+v) ? +v : dflt;
}

export function energyBudget(project: Project, scenario?: Scenario): EnergyBudget {
  const V = scenarioVoltage(project, scenario);
  const eq = effectiveEquipment(project, scenario);
  const rows: EnergyRow[] = [];
  for (const e of eq) {
    const cat = CATALOG_BY_KIND[e.kind];
    if (!cat) continue;
    if (cat.category === 'dc-load') {
      const watts = num(e, 'watts');
      const hours = num(e, 'hoursPerDay');
      const duty = num(e, 'dutyCycle', 100) / 100;
      const wh = watts * hours * duty;
      rows.push({ id: e.id, name: e.name, watts, amps: watts / V, hoursPerDay: hours, dutyCycle: duty * 100, whPerDay: wh, ahPerDay: wh / V, ac: false });
    } else if (cat.category === 'ac-load') {
      // Only loads that may run on the inverter count against the battery.
      if (e.props.shoreOnly) continue;
      const hasInverter = eq.some((x) => x.kind === 'inverter' || x.kind === 'inverter-charger');
      if (!hasInverter) continue;
      const watts = num(e, 'watts');
      const hours = num(e, 'hoursPerDay');
      const wh = (watts * hours) / INVERTER_EFFICIENCY;
      rows.push({ id: e.id, name: `${e.name} (via inverter)`, watts, amps: watts / INVERTER_EFFICIENCY / V, hoursPerDay: hours, dutyCycle: 100, whPerDay: wh, ahPerDay: wh / V, ac: true });
    }
  }
  const totalWh = rows.reduce((s, r) => s + r.whPerDay, 0);
  const totalAh = totalWh / V;
  const house = eq.filter((e) => e.kind === 'battery-bank' && e.props.role === 'house');
  let houseAh = 0;
  let chem: Chemistry | undefined;
  for (const h of house) {
    const unitV = num(h, 'unitVolts', 12);
    const series = Math.max(1, Math.round(V / unitV));
    houseAh += (num(h, 'unitAh') * num(h, 'units', 1)) / series;
    chem = h.props.chemistry as Chemistry;
  }
  const dod = USABLE_DOD[chem ?? 'agm'] ?? 0.5;
  const A = energyAssumptions(project, scenario);
  const daysAutonomy = A.daysAutonomy;
  const solarW = eq.filter((e) => e.kind === 'solar').reduce((s, e) => s + num(e, 'watts'), 0);
  const whW = eq.filter((e) => e.kind === 'wind' || e.kind === 'hydro').reduce((s, e) => s + num(e, 'watts'), 0);
  // the engines the design draws; with two, both are taken to run the hours assumed
  const engines = eq.filter((e) => e.kind === 'engine').slice(0, MAX_ENGINES);
  const altA = engines.reduce((s, e) => s + num(e, 'alternatorAmps') * (12 / V), 0);
  const alternators = engines.filter((e) => num(e, 'alternatorAmps') > 0).length;
  const solarAh = (solarW * A.solarPeakHours * A.solarDerate) / V;
  const windAh = (whW * 24 * A.windHydroCapacityFactor) / V;
  // Lead-acid absorbs slowly; effective alternator contribution ~60% (lead) / 85% (LFP). A mains charger tapers the same way.
  const altEff = chem === 'lifepo4' ? ENERGY_ASSUMPTIONS.alternatorChargeEfficiency.lifepo4 : ENERGY_ASSUMPTIONS.alternatorChargeEfficiency.lead;
  const hasShore = eq.some((e) => e.kind === 'shore-power');
  const chargerAmps = hasShore ? eq.reduce((s, e) => s + (e.kind === 'battery-charger' ? num(e, 'amps') : e.kind === 'inverter-charger' ? num(e, 'chargeAmps') : 0), 0) : 0;
  // Solar and wind give what the weather gives. A charger or an alternator only puts back what
  // has been taken out, so each is counted up to what is still needed, in that order.
  const shoreCanGive = chargerAmps * altEff * A.shoreHoursPerDay;
  const shoreAh = Math.min(shoreCanGive, Math.max(0, totalAh - solarAh - windAh));
  const engineCanGive = altA * altEff * A.engineHoursPerDay;
  const engineAh = Math.min(engineCanGive, Math.max(0, totalAh - solarAh - windAh - shoreAh));
  const deficit = Math.max(0, totalAh - solarAh - windAh - shoreAh);
  const charging = solarAh + windAh + shoreAh + engineAh;
  const shortfall = Math.max(0, totalAh - charging);
  // The bank carries what the charging counted on during the autonomy days does not, and never less than a day's use.
  const carriedPerDay = Math.max(0, totalAh - (solarAh + windAh) * A.chargingDuringAutonomy);
  const bankAh = Math.max(carriedPerDay * daysAutonomy, totalAh * Math.min(1, daysAutonomy)) / dod;
  return {
    volts: V,
    rows,
    totalAhPerDay: totalAh,
    totalWhPerDay: totalWh,
    houseAh,
    houseChemistry: chem,
    usableAh: houseAh * dod,
    recommendedAh: Math.ceil(bankAh / 10) * 10,
    daysAutonomy,
    solarAhPerDay: solarAh,
    windHydroAhPerDay: windAh,
    shoreAhPerDay: shoreAh,
    engineAhPerDay: engineAh,
    shoreCanGiveAhPerDay: shoreCanGive,
    engineCanGiveAhPerDay: engineCanGive,
    chargingAhPerDay: charging,
    shortfallAhPerDay: shortfall,
    surplusAhPerDay: Math.max(0, charging - totalAh),
    alternatorAmps: altA,
    alternators,
    chargerAmps,
    engineHoursToBalance: altA > 0 ? deficit / (altA * altEff) : Infinity,
    extraEngineHours: shortfall === 0 ? 0 : altA > 0 ? shortfall / (altA * altEff) : Infinity,
    assumptions: { ...A, inverterEfficiency: INVERTER_EFFICIENCY, alternatorChargeEfficiency: altEff },
  };
}

export function acVolts(project: Project): number {
  return AC_STANDARDS[project.profile.acStandard].volts;
}
