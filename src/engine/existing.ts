// Helpers for the hand-drawn "existing" design.

import { CATALOG_BY_KIND } from '../model/catalog';
import { growTerminal, makeNode, NODE_DEFS } from '../model/nodeDefs';
import { uid } from '../model/examples';
import type { Design, DNode, Equipment, NodeType, Project } from '../model/types';
import { num } from './energy';

/** Create a palette node with sensible starting terminals. */
export function paletteNode(type: NodeType, zone: string): DNode {
  const n = makeNode(type, uid('n'), NODE_DEFS[type].label, { zone });
  const def = NODE_DEFS[type];
  if (def.growable) {
    if (type === 'dc-panel' || type === 'ac-panel' || type === 'fuse-block') {
      const r = type === 'fuse-block' ? 10 : 15;
      for (let i = 0; i < 6; i++) growTerminal(n, { rating: r, label: `${r} A`, side: 'E' });
    } else {
      for (let i = 0; i < 8; i++) growTerminal(n, { side: i % 2 ? 'E' : 'W' });
    }
  }
  if (type === 'fuse' || type === 'breaker') n.data.rating = 30;
  if (type === 'battery') {
    n.data.chemistry = 'agm';
    n.data.ah = 100;
  }
  if (type === 'load') {
    n.data.amps = 5;
  }
  return n;
}

/** Node representing an equipment item on the existing drawing. */
export function equipmentNode(e: Equipment, project: Project): DNode | undefined {
  const V = project.profile.systemVoltage;
  const c = CATALOG_BY_KIND[e.kind];
  if (!c) return undefined;
  const base = { zone: e.zone, equipmentId: e.id };
  const id = uid('n');
  switch (c.category) {
    case 'storage': {
      const units = num(e, 'units', 1);
      const unitV = num(e, 'unitVolts', 12);
      const series = Math.max(1, Math.round(V / unitV));
      return makeNode('battery', id, e.name, { ...base, sublabel: `${units}× ${unitV} V ${num(e, 'unitAh')} Ah`, data: { chemistry: String(e.props.chemistry), ah: (num(e, 'unitAh') * units) / series, volts: V } });
    }
    case 'engine':
      return makeNode('engine', id, e.name, { ...base, data: { amps: num(e, 'starterAmps', 150) * (12 / V), kind: 'engine' } });
    case 'dc-load': {
      const watts = num(e, 'watts');
      return makeNode('load', id, e.name, {
        ...base,
        sublabel: `${watts} W`,
        data: { watts, amps: watts / V, critical: !!e.props.critical, kind: e.kind, v24ok: e.props.v24ok !== false, alwaysOn: !!e.props.alwaysOn, glyph: c.glyph },
      });
    }
    case 'ac-load': {
      const watts = num(e, 'watts');
      const acV = project.profile.acStandard === 'us120' ? 120 : 230;
      return makeNode('ac-load', id, e.name, { ...base, sublabel: `${watts} W`, data: { watts, amps: watts / acV, kind: e.kind, shoreOnly: !!e.props.shoreOnly, glyph: c.glyph } });
    }
    case 'ac-source':
      return makeNode(e.kind === 'shore-power' ? 'shore-inlet' : 'generator', id, e.name, { ...base, data: { amps: num(e, 'amps', 30) } });
    case 'charging': {
      const map: Partial<Record<string, NodeType>> = {
        solar: 'solar-panel',
        wind: 'wind-gen',
        hydro: 'hydro-gen',
        'battery-charger': 'charger',
        'inverter-charger': 'inverter-charger',
        inverter: 'inverter',
      };
      const t = map[e.kind];
      if (!t) return undefined;
      const amps = num(e, 'amps') || num(e, 'chargeAmps') || num(e, 'watts') / V;
      return makeNode(t, id, e.name, { ...base, data: { amps, watts: num(e, 'watts') || undefined } });
    }
  }
  return undefined;
}

export function existingFromEquipment(project: Project): Design {
  const nodes: DNode[] = [];
  const perCol = new Map<number, number>();
  for (const e of project.equipment) {
    const n = equipmentNode(e, project);
    if (!n) continue;
    const k = perCol.get(n.col) ?? 0;
    perCol.set(n.col, k + 1);
    n.pos = { x: n.col * 240, y: k * 90 };
    nodes.push(n);
  }
  return { id: 'existing', name: 'Existing', systemVoltage: project.profile.systemVoltage, nodes, wires: [], findings: [] };
}

export function existingFromIdeal(ideal: Design, positions: Record<string, { x: number; y: number }>): Design {
  const copy: Design = JSON.parse(JSON.stringify(ideal));
  copy.id = 'existing';
  copy.name = 'Existing';
  copy.findings = [];
  for (const n of copy.nodes) n.pos = positions[n.id] ?? n.pos;
  return copy;
}
