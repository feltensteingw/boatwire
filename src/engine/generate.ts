// Ideal-design generator: equipment list + boat profile + scenario → Design.
//
// This file only sets the order of work. Each subsystem is built by its own module in ./ideal:
//
//   plan          what the boat has and draws (no drawing)
//   houseBank     batteries, main fuses, switch, buses, shunt, BMS
//   distribution  always-on circuits, DC panel, 24→12 V converter and sub-panel
//   heavyLoads    windlass, thruster, winches, and dedicated battery banks
//   engine        starter circuit, alternator and charge splitting
//   renewables    solar, wind and hydro
//   ac            shore power, generator, inverter, AC panels, chargers
//
// The order matters: wires and bus studs are numbered as they are added, and later subsystems
// connect to what earlier ones built. tests/generatorGolden.test.ts records the output for a set
// of boats, so a change in what any module produces is caught.

import type { Design, Project, Scenario } from '../model/types';
import { buildAc } from './ideal/ac';
import { Builder } from './ideal/builder';
import { buildAlwaysOn, buildPanels } from './ideal/distribution';
import { buildEngine } from './ideal/engine';
import { buildDedicatedBanks, buildHeavyLoads } from './ideal/heavyLoads';
import { buildHouseBank } from './ideal/houseBank';
import { makePlan, reportPlanProblems } from './ideal/plan';
import { buildSolar, buildWindHydro } from './ideal/renewables';

export function generateIdeal(project: Project, scenario?: Scenario): Design {
  const plan = makePlan(project, scenario);
  const b = new Builder(plan.V, plan.acStd.volts, project.profile.acStandard === 'us120', project.profile.units);
  const design: Design = {
    id: scenario?.id ?? 'ideal',
    name: scenario?.name ?? 'Ideal',
    systemVoltage: plan.V,
    nodes: b.nodes,
    wires: b.wires,
    findings: b.findings,
  };

  if (plan.house.length === 0) {
    b.find('error', 'bank-sizing', 'No house battery bank. Add a battery bank with the role "House" to generate a design.');
    return design;
  }
  reportPlanProblems(b, plan);

  const core = buildHouseBank(b, plan);
  buildAlwaysOn(b, plan, core);
  const { housePanel } = buildPanels(b, plan, core);
  const dedicated = buildDedicatedBanks(b, plan, core);
  buildHeavyLoads(b, plan, core, housePanel, dedicated);
  const { startBus } = buildEngine(b, plan, core);
  buildSolar(b, plan, core);
  buildWindHydro(b, plan, core);
  buildAc(b, plan, core, startBus);

  // Every cable above is sized as a single conductor; bundling is checked only on hand-drawn wires.
  b.find(
    'info',
    'bundling',
    'Cable sizes assume each cable runs on its own, not bundled with other wires that carry current.',
    'Keep heavy cables, such as charging, inverter, windlass and thruster cables, out of looms. A cable in a bundle, loom or conduit is rated for 30% to 60% less current, depending on how many share it, so some need a larger size. To check them, set "Bundled with" on those wires in Existing boat; for a new installation, choose "Start from the ideal design" there first.',
  );

  return design;
}
