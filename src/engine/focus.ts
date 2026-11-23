// Focus: one part of the wiring job at a time ("just the charging", "just the AC").
// Given a design, which components belong to that part. Pure, so the diagram, the layout worker and
// "Size wires and fuses" all use the same answer, and it is unit-tested without the app.

import { NODE_DEFS } from '../model/nodeDefs';
import type { Design, DNode, Focus, NodeType, WireKind } from '../model/types';

export type { Focus };

export const FOCUS_OPTIONS: { id: Focus; label: string; tip: string }[] = [
  { id: 'all', label: 'Whole boat', tip: 'Everything.' },
  { id: 'charging', label: 'Charging', tip: 'What charges the batteries: alternators, chargers, solar, wind, DC-DC chargers, charging relays and isolators, and the fuses, buses and switches between them and the batteries.' },
  { id: 'start', label: 'Engine starting', tip: 'Each engine starter and its cables, fuse and switch back to the battery that starts it.' },
  { id: 'loads', label: 'DC loads', tip: 'The DC circuits that use power: panels, fuse blocks, loads, inverters and converters, and their feed back to the batteries.' },
  { id: 'ac', label: 'AC mains', tip: 'Shore power, generator, inverter output, AC panel, outlets and AC appliances, with the chargers and inverters that join AC to DC.' },
];

/** Where each part of the job starts. The rest is found by following wires from these to the batteries. */
const SEEDS: Record<Exclude<Focus, 'all' | 'ac'>, NodeType[]> = {
  charging: ['alternator', 'apd', 'regulator', 'charger', 'mppt', 'solar-panel', 'wind-gen', 'hydro-gen', 'controller', 'dump-load', 'dcdc', 'acr', 'isolator', 'inverter-charger'],
  start: ['engine'],
  loads: ['load', 'dc-panel', 'fuse-block', 'inverter', 'inverter-charger', 'converter'],
};

/** Parts that join one battery to another for charging. Outside the charging focus, a path to a battery does not go through them. */
const CHARGE_LINKS = new Set<NodeType>(['acr', 'isolator', 'dcdc']);

/** AC parts that are also on the DC side. */
const BRIDGES = new Set<NodeType>(['charger', 'inverter', 'inverter-charger']);

/**
 * The ids of the components in a focus, or `undefined` for the whole boat.
 *
 * DC parts: the starting components (alternators for Charging, and so on), and every component on
 * the shortest run of positive wires, and separately of negative wires, from each of them to each
 * battery or other starting component it reaches (so the breaker between a solar panel and its
 * controller is in, and so is the bus between a load and its panel's feed). So Charging shows the alternator fuse and the bus it lands on, but not the
 * cabin lights on that bus. AC: every AC component, plus the chargers and inverters on its edge.
 */
export function focusNodes(design: Design, focus: Focus | undefined): Set<string> | undefined {
  if (!focus || focus === 'all') return undefined;
  if (focus === 'ac') return new Set(design.nodes.filter((n) => n.domain === 'ac' || BRIDGES.has(n.type)).map((n) => n.id));
  const seedTypes = new Set(SEEDS[focus]);
  const byId = new Map(design.nodes.map((n) => [n.id, n]));
  const out = new Set<string>();
  const seeds = design.nodes.filter((n) => seedTypes.has(n.type));
  for (const s of seeds) out.add(s.id);
  // A bridge's AC side is not part of a DC focus: only its DC wires are followed (the wire kinds below).
  const passes = (n: DNode) => NODE_DEFS[n.type].conducts && (focus === 'charging' || !CHARGE_LINKS.has(n.type));
  for (const kind of ['pos', 'neg'] as WireKind[]) {
    const adj = new Map<string, string[]>();
    for (const w of design.wires) {
      if (w.kind !== kind) continue;
      if (!adj.has(w.from.node)) adj.set(w.from.node, []);
      if (!adj.has(w.to.node)) adj.set(w.to.node, []);
      adj.get(w.from.node)!.push(w.to.node);
      adj.get(w.to.node)!.push(w.from.node);
    }
    for (const s of seeds) {
      // Breadth-first from the seed: the first time a battery is reached is the shortest run to it.
      const parent = new Map<string, string | null>([[s.id, null]]);
      const queue = [s.id];
      while (queue.length) {
        const id = queue.shift()!;
        const n = byId.get(id);
        if (!n) continue;
        if (id !== s.id && (n.type === 'battery' || seedTypes.has(n.type))) {
          for (let p: string | null = id; p !== null; p = parent.get(p) ?? null) out.add(p);
          // The end of this run: a battery does not conduct to its other wires, and another
          // starting component follows its own runs.
          continue;
        }
        if (id !== s.id && !passes(n)) continue;
        for (const next of adj.get(id) ?? []) {
          if (parent.has(next)) continue;
          parent.set(next, id);
          queue.push(next);
        }
      }
    }
  }
  return out;
}

/** Wires inside a focus: both ends on components in it. */
export function inFocus(set: Set<string> | undefined, w: { from: { node: string }; to: { node: string } }): boolean {
  return !set || (set.has(w.from.node) && set.has(w.to.node));
}
