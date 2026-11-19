import type { Equipment, Project, Scenario, SystemVoltage } from '../model/types';

export function activeScenario(project: Project): Scenario | undefined {
  return project.scenarios.find((s) => s.id === project.activeScenario);
}

export function scenarioVoltage(project: Project, scenario?: Scenario): SystemVoltage {
  return scenario?.systemVoltage ?? project.profile.systemVoltage;
}

/** A battery bank as a what-if scenario has it, beside the bank on the equipment list. */
export interface BankChange {
  listed: Equipment;
  assumed: Equipment;
  /** What set the number of batteries: whole series strings at the scenario's voltage, or the scenario's house capacity. */
  why: 'voltage' | 'capacity';
}

/**
 * The bank as this scenario has it, or undefined when the scenario leaves it as listed.
 *
 * A scenario changes a bank only when it really changes something about it: the system voltage
 * (every bank), or the house bank's chemistry or capacity. The bank is then kept buildable at the
 * scenario's voltage: a single 12 V start battery becomes two in series in a 24 V what-if. At the
 * boat's own voltage nothing is rounded: a bank that cannot be built is drawn as listed, and the
 * design says so.
 */
function assumeBank(project: Project, scenario: Scenario, V: SystemVoltage, e: Equipment): BankChange | undefined {
  const house = (e.props.role ?? 'house') === 'house';
  const chem = house ? scenario.houseChemistry : undefined;
  const cap = house && scenario.houseCapacityAh ? scenario.houseCapacityAh : undefined;
  const unitAh = Number(e.props.unitAh) || 100;
  const listedUnits = Number(e.props.units) || 1;
  const listedUnitV = Number(e.props.unitVolts) || 12;
  // What the listed batteries store, as amp-hours at the scenario's voltage.
  const listedAh = (listedUnits * listedUnitV * unitAh) / V;
  const changes = V !== project.profile.systemVoltage || (chem !== undefined && chem !== e.props.chemistry) || (cap !== undefined && cap !== listedAh);
  if (!changes) return undefined;

  const props = { ...e.props };
  if (chem) {
    props.chemistry = chem;
    // (lithium is taken as 12 V batteries)
    if (chem === 'lifepo4') props.unitVolts = 12;
  }
  const unitV = Number(props.unitVolts) || 12;
  const series = Math.max(1, Math.round(V / unitV));
  let why: BankChange['why'];
  if (cap) {
    props.units = Math.max(series, Math.ceil(cap / unitAh) * series);
    why = 'capacity';
  } else {
    props.units = Math.ceil(listedUnits / series) * series;
    why = 'voltage';
  }
  return { listed: e, assumed: { ...e, props }, why };
}

/** The battery banks a scenario changes. None for a scenario that changes nothing about the boat. */
export function bankChanges(project: Project, scenario?: Scenario): BankChange[] {
  if (!scenario) return [];
  const V = scenarioVoltage(project, scenario);
  return project.equipment.flatMap((e) => {
    const c = e.kind === 'battery-bank' ? assumeBank(project, scenario, V, e) : undefined;
    return c ? [c] : [];
  });
}

/**
 * Equipment list with scenario overrides applied (system voltage, house bank chemistry and
 * capacity). Capacity overrides are distributed by changing the unit count. See `bankChanges`.
 */
export function effectiveEquipment(project: Project, scenario?: Scenario): Equipment[] {
  const assumed = new Map(bankChanges(project, scenario).map((c) => [c.listed, c.assumed]));
  return assumed.size ? project.equipment.map((e) => assumed.get(e) ?? e) : project.equipment;
}
