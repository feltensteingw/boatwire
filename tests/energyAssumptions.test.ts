import { describe, expect, it } from 'vitest';
import { daysText, energyAssumptions, energyBudget } from '../src/engine/energy';
import { generateIdeal } from '../src/engine/generate';
import { exampleProject, newEquipment } from '../src/model/examples';
import { ENERGY_ASSUMPTIONS, ENERGY_LIMITS, ENERGY_PRESETS } from '../src/model/standards';
import type { EnergyAssumptions, Project } from '../src/model/types';
import { parseProject } from '../src/model/validate';

const boat = (energy?: Partial<EnergyAssumptions>): Project => ({ ...exampleProject(), energy });
const base = energyBudget(boat());

describe('energy assumptions', () => {
  it('start from the defaults, which give the same budget as before they could be changed', () => {
    const { alternatorChargeEfficiency: _unused, ...defaults } = ENERGY_ASSUMPTIONS;
    expect(energyAssumptions(boat())).toEqual(defaults);
    // the example boat: 183 Ah a day, 740 Ah recommended for two days of AGM at 50%
    expect(Math.round(base.totalAhPerDay)).toBe(183);
    expect(base.recommendedAh).toBe(740);
    expect(base.daysAutonomy).toBe(2);
    expect(base.shoreAhPerDay).toBe(0);
    expect(base.engineAhPerDay).toBe(0);
    expect(base.engineHoursToBalance).toBeCloseTo((base.totalAhPerDay - base.solarAhPerDay) / (90 * 0.6), 6);
    expect(base.extraEngineHours).toBeCloseTo(base.engineHoursToBalance, 6);
  });

  it('more sun means more solar charge and less engine running', () => {
    const sunny = energyBudget(boat({ solarPeakHours: 6 }));
    const dull = energyBudget(boat({ solarPeakHours: 1 }));
    expect(sunny.solarAhPerDay).toBeCloseTo((400 * 6 * 0.75) / 12, 6);
    expect(sunny.engineHoursToBalance).toBeLessThan(base.engineHoursToBalance);
    expect(dull.engineHoursToBalance).toBeGreaterThan(base.engineHoursToBalance);
    // with no charging counted during the autonomy days (the default), the bank size does not depend on the sun
    expect(sunny.recommendedAh).toBe(base.recommendedAh);
  });

  it('sun hours change the recommended bank once some charging is counted during the autonomy days', () => {
    const sunny = energyBudget(boat({ chargingDuringAutonomy: 0.5, solarPeakHours: 6 }));
    const dull = energyBudget(boat({ chargingDuringAutonomy: 0.5, solarPeakHours: 1 }));
    expect(sunny.recommendedAh).toBeLessThan(dull.recommendedAh);
    expect(dull.recommendedAh).toBeLessThan(base.recommendedAh);
    // carried per day = use − half the solar; two days of that at 50% depth of discharge
    expect(sunny.recommendedAh).toBe(Math.ceil(((sunny.totalAhPerDay - sunny.solarAhPerDay * 0.5) * 2) / 0.5 / 10) * 10);
  });

  it('never recommends less than a day of use, however much charging is counted', () => {
    const p = boat({ chargingDuringAutonomy: 1, solarPeakHours: 12 });
    p.equipment.find((e) => e.kind === 'solar')!.props.watts = 3000;
    const b = energyBudget(p);
    expect(b.recommendedAh).toBe(Math.ceil(b.totalAhPerDay / 0.5 / 10) * 10);
  });

  it('days of autonomy scale the recommended bank and are named in the design note', () => {
    expect(energyBudget(boat({ daysAutonomy: 3 })).recommendedAh).toBe(Math.ceil((base.totalAhPerDay * 3) / 0.5 / 10) * 10);
    expect(energyBudget(boat({ daysAutonomy: 1 })).recommendedAh).toBe(370);
    const note = (days: number) => generateIdeal(boat({ daysAutonomy: days })).findings.find((f) => f.rule === 'bank-sizing')?.message;
    expect(note(2)).toContain('for two days at safe depth of discharge');
    expect(note(3)).toContain('~1100 Ah for 3 days');
    expect(note(1), 'a 400 Ah bank is enough for one day').toBeUndefined();
    expect([daysText(1), daysText(2), daysText(3.5)]).toEqual(['1 day', 'two days', '3.5 days']);
  });

  it('shore power and planned engine hours count as charging, up to what is needed', () => {
    const marina = energyBudget(boat({ shoreHoursPerDay: 24 }));
    // 80 A inverter/charger, 60% reaching a lead-acid bank, 24 h: far more than a day's use
    expect(marina.chargerAmps).toBe(80);
    expect(marina.shoreCanGiveAhPerDay).toBeCloseTo(80 * 0.6 * 24, 6);
    // a charger only puts back what was taken out: the part of the day's use the sun did not cover
    expect(marina.shoreAhPerDay).toBeCloseTo(marina.totalAhPerDay - marina.solarAhPerDay, 6);
    expect(marina.shortfallAhPerDay).toBe(0);
    expect(marina.surplusAhPerDay).toBe(0);
    expect(marina.engineHoursToBalance).toBe(0);
    expect(marina.extraEngineHours).toBe(0);

    // an hour plugged in is not enough: it gives all it can
    const hour = energyBudget(boat({ shoreHoursPerDay: 1 }));
    expect(hour.shoreAhPerDay).toBeCloseTo(80 * 0.6, 6);
    expect(hour.shortfallAhPerDay).toBeCloseTo(base.shortfallAhPerDay - 48, 6);

    const motoring = energyBudget(boat({ engineHoursPerDay: 1 }));
    expect(motoring.engineAhPerDay).toBeCloseTo(90 * 0.6, 6);
    expect(motoring.extraEngineHours).toBeCloseTo(base.extraEngineHours - 1, 6);
    // total engine hours to break even does not depend on how many are planned
    expect(motoring.engineHoursToBalance).toBeCloseTo(base.engineHoursToBalance, 6);
    // motoring all day: the alternator covers the rest and no more
    const allDay = energyBudget(boat({ engineHoursPerDay: 12 }));
    expect(allDay.engineAhPerDay).toBeCloseTo(allDay.totalAhPerDay - allDay.solarAhPerDay, 6);
    expect(allDay.extraEngineHours).toBe(0);

    // a boat with no shore power inlet gets nothing from shore hours
    const p = boat({ shoreHoursPerDay: 24 });
    p.equipment = p.equipment.filter((e) => e.kind !== 'shore-power');
    expect(energyBudget(p).shoreAhPerDay).toBe(0);
  });

  it('only sun and wind can give more than the boat uses', () => {
    const p = boat({ solarPeakHours: 6 });
    p.equipment.find((e) => e.kind === 'solar')!.props.watts = 1200;
    const b = energyBudget(p);
    expect(b.surplusAhPerDay).toBeCloseTo(b.solarAhPerDay - b.totalAhPerDay, 6);
    expect(b.surplusAhPerDay).toBeGreaterThan(100);
  });

  it('the day adds up: use = charging + shortfall − surplus', () => {
    for (const energy of [{}, { shoreHoursPerDay: 3 }, { engineHoursPerDay: 2, solarPeakHours: 2 }, { shoreHoursPerDay: 24 }]) {
      const b = energyBudget(boat(energy));
      expect(b.chargingAhPerDay).toBeCloseTo(b.solarAhPerDay + b.windHydroAhPerDay + b.shoreAhPerDay + b.engineAhPerDay, 6);
      expect(b.totalAhPerDay).toBeCloseTo(b.chargingAhPerDay + b.shortfallAhPerDay - b.surplusAhPerDay, 6);
    }
  });

  it('with no alternator a shortfall cannot be made up by the engine', () => {
    const p = boat();
    p.equipment = p.equipment.filter((e) => e.kind !== 'engine');
    expect(energyBudget(p).extraEngineHours).toBe(Infinity);
    p.energy = { shoreHoursPerDay: 24 };
    expect(energyBudget(p).extraEngineHours).toBe(0);
  });

  it("a scenario's own assumptions win over the boat's, which win over the defaults", () => {
    const p = boat({ solarPeakHours: 5, daysAutonomy: 3 });
    const winter = { id: 'w', name: 'Winter', energy: { solarPeakHours: 1.5 } };
    expect(energyAssumptions(p, winter)).toMatchObject({ solarPeakHours: 1.5, daysAutonomy: 3, solarDerate: ENERGY_ASSUMPTIONS.solarDerate });
    expect(energyBudget(p, winter).solarAhPerDay).toBeLessThan(energyBudget(p, { id: 's', name: 'Summer' }).solarAhPerDay);
  });

  it('holds every value to its range, whatever was stored', () => {
    const wild = energyAssumptions(boat({ solarPeakHours: 99, solarDerate: -1, daysAutonomy: 0, shoreHoursPerDay: 30, chargingDuringAutonomy: 5, windHydroCapacityFactor: NaN }));
    expect(wild).toMatchObject({ solarPeakHours: 12, solarDerate: 0.1, daysAutonomy: 0.5, shoreHoursPerDay: 24, chargingDuringAutonomy: 1, windHydroCapacityFactor: ENERGY_ASSUMPTIONS.windHydroCapacityFactor });
  });

  it('wind and hydro follow their own assumption', () => {
    const p = boat({ windHydroCapacityFactor: 0.4 });
    p.equipment.push(newEquipment('wind', { props: { watts: 400 } }));
    expect(energyBudget(p).windHydroAhPerDay).toBeCloseTo((400 * 24 * 0.4) / 12, 6);
  });

  it('every preset sets only known assumptions, within range', () => {
    for (const preset of [...ENERGY_PRESETS.sun, ...ENERGY_PRESETS.use]) {
      for (const [k, v] of Object.entries(preset.set)) {
        const [lo, hi] = ENERGY_LIMITS[k as keyof typeof ENERGY_LIMITS];
        expect(v, `${preset.label}: ${k}`).toBeGreaterThanOrEqual(lo);
        expect(v).toBeLessThanOrEqual(hi);
      }
    }
  });
});

describe('energy assumptions saved with the project', () => {
  it('survive save and load, for the boat and for a scenario', () => {
    const p = boat({ solarPeakHours: 5.5, daysAutonomy: 3 });
    p.scenarios[1].energy = { solarPeakHours: 2.5 };
    const back = parseProject(JSON.parse(JSON.stringify(p))).project;
    expect(back.energy).toEqual({ solarPeakHours: 5.5, daysAutonomy: 3 });
    expect(back.scenarios[1].energy).toEqual({ solarPeakHours: 2.5 });
    expect(back.scenarios[0].energy).toBeUndefined();
  });

  it('unknown names and nonsense values are dropped; out-of-range values are pulled into range', () => {
    const raw = JSON.parse(JSON.stringify(exampleProject()));
    raw.energy = { solarPeakHours: 40, madeUp: 3, daysAutonomy: 'lots', solarDerate: null };
    expect(parseProject(raw).project.energy).toEqual({ solarPeakHours: 12 });
    raw.energy = { madeUp: 1 };
    expect(parseProject(raw).project.energy).toBeUndefined();
  });
});
