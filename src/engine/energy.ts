import { CATALOG_BY_KIND } from '../model/catalog';
import { AC_STANDARDS, ENERGY_ASSUMPTIONS, INVERTER_EFFICIENCY, USABLE_DOD } from '../model/standards';
import type { Chemistry, Equipment, Project, Scenario, SystemVoltage } from '../model/types';
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
  alternatorAmps: number;
  engineHoursToBalance: number;
  /** The figures this budget was worked out with, for showing next to it. */
  assumptions: { solarPeakHours: number; solarDerate: number; windHydroCapacityFactor: number; inverterEfficiency: number; alternatorChargeEfficiency: number };
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
  const A = ENERGY_ASSUMPTIONS;
  const daysAutonomy = A.daysAutonomy;
  const solarW = eq.filter((e) => e.kind === 'solar').reduce((s, e) => s + num(e, 'watts'), 0);
  const whW = eq.filter((e) => e.kind === 'wind' || e.kind === 'hydro').reduce((s, e) => s + num(e, 'watts'), 0);
  const engine = eq.find((e) => e.kind === 'engine');
  const altA = engine ? num(engine, 'alternatorAmps') * (12 / V) : 0;
  const solarAh = (solarW * A.solarPeakHours * A.solarDerate) / V;
  const windAh = (whW * 24 * A.windHydroCapacityFactor) / V;
  const deficit = Math.max(0, totalAh - solarAh - windAh);
  // Lead-acid absorbs slowly; effective alternator contribution ~60% (lead) / 85% (LFP)
  const altEff = chem === 'lifepo4' ? A.alternatorChargeEfficiency.lifepo4 : A.alternatorChargeEfficiency.lead;
  return {
    volts: V,
    rows,
    totalAhPerDay: totalAh,
    totalWhPerDay: totalWh,
    houseAh,
    houseChemistry: chem,
    usableAh: houseAh * dod,
    recommendedAh: Math.ceil((totalAh * daysAutonomy) / dod / 10) * 10,
    daysAutonomy,
    solarAhPerDay: solarAh,
    windHydroAhPerDay: windAh,
    alternatorAmps: altA,
    engineHoursToBalance: altA > 0 ? deficit / (altA * altEff) : Infinity,
    assumptions: { solarPeakHours: A.solarPeakHours, solarDerate: A.solarDerate, windHydroCapacityFactor: A.windHydroCapacityFactor, inverterEfficiency: INVERTER_EFFICIENCY, alternatorChargeEfficiency: altEff },
  };
}

export function acVolts(project: Project): number {
  return AC_STANDARDS[project.profile.acStandard].volts;
}
