import type { Equipment, Project, Scenario, SystemVoltage } from '../model/types';

export function activeScenario(project: Project): Scenario | undefined {
  return project.scenarios.find((s) => s.id === project.activeScenario);
}

export function scenarioVoltage(project: Project, scenario?: Scenario): SystemVoltage {
  return scenario?.systemVoltage ?? project.profile.systemVoltage;
}

/**
 * Equipment list with scenario overrides applied (house bank chemistry and
 * capacity). Capacity overrides are distributed by changing the unit count.
 *
 * Every battery bank is kept buildable at the scenario's voltage: a single 12 V start battery
 * becomes two in series in a 24 V what-if, as the house bank always has.
 */
export function effectiveEquipment(project: Project, scenario?: Scenario): Equipment[] {
  if (!scenario) return project.equipment;
  const V = scenarioVoltage(project, scenario);
  return project.equipment.map((e) => {
    if (e.kind !== 'battery-bank') return e;
    if (e.props.role !== 'house') {
      // Start and dedicated banks: only the count changes, and only when it has to.
      const series = Math.max(1, Math.round(V / (Number(e.props.unitVolts) || 12)));
      const units = Number(e.props.units) || 1;
      return units % series === 0 ? e : { ...e, props: { ...e.props, units: Math.ceil(units / series) * series } };
    }
    const props = { ...e.props };
    if (scenario.houseChemistry) {
      props.chemistry = scenario.houseChemistry;
      if (scenario.houseChemistry === 'lifepo4') {
        props.unitVolts = 12;
      }
    }
    const unitV = Number(props.unitVolts) || 12;
    const series = Math.max(1, Math.round(V / unitV));
    // Keep the bank wired correctly for the scenario voltage.
    let units = Number(props.units) || 1;
    if (scenario.houseCapacityAh) {
      const unitAh = Number(props.unitAh) || 100;
      units = Math.max(series, Math.ceil(scenario.houseCapacityAh / unitAh) * series);
    }
    if (units % series !== 0) units = Math.ceil(units / series) * series;
    props.units = units;
    return { ...e, props };
  });
}
