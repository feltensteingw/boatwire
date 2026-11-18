// Check and repair a project before it is used.
//
// Every way a project gets into the app goes through parseProject: browser storage, an opened
// file and a cloud boat. It never trusts the shape of what it is given. Small problems are
// repaired and reported as notes; something that is not a project at all throws ProjectError
// with a message a boat owner can act on.

import { CATALOG_BY_KIND } from './catalog';
import { blankProject, uid } from './examples';
import { makeNode, NODE_DEFS } from './nodeDefs';
import type { Design, DNode, Equipment, EquipmentKind, NodeType, Polarity, Project, PropValue, Scenario, Terminal, Underlay, Wire, WireKind, Zone } from './types';

/** Format of the project data. Raise it, and add a step to MIGRATIONS, when the shape changes. */
export const PROJECT_VERSION = 1;

/** Upgrades from version N to N+1, keyed by N. Each receives and returns loose data. */
const MIGRATIONS: Record<number, (p: Record<string, unknown>) => Record<string, unknown>> = {};

export class ProjectError extends Error {}

type Loose = Record<string, unknown>;
const isObj = (x: unknown): x is Loose => typeof x === 'object' && x !== null && !Array.isArray(x);
const str = (x: unknown, fallback: string) => (typeof x === 'string' ? x : fallback);
const num = (x: unknown, fallback: number) => (typeof x === 'number' && Number.isFinite(x) ? x : fallback);
const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

const POLARITIES: Polarity[] = ['pos', 'neg', 'ac', 'gnd', 'sig'];
const SIDES = ['W', 'E', 'N', 'S'] as const;

export interface Parsed {
  project: Project;
  /** Plain-English notes about anything that was repaired or left out. Empty for a clean project. */
  notes: string[];
}

export function parseProject(raw: unknown): Parsed {
  if (!isObj(raw)) throw new ProjectError('This is not a BoatWire project.');
  if (!isObj(raw.profile) && !Array.isArray(raw.equipment)) throw new ProjectError('This is not a BoatWire project.');
  const notes: string[] = [];

  // Version: bring older data forward, refuse newer.
  let data: Loose = raw;
  let version = num(raw.version, 1);
  if (version > PROJECT_VERSION) {
    throw new ProjectError(`This boat was saved by a newer version of BoatWire (format ${version}; this version reads up to ${PROJECT_VERSION}). Reload the page to get the latest BoatWire, then open it again.`);
  }
  while (version < PROJECT_VERSION) {
    const step = MIGRATIONS[version];
    if (!step) throw new ProjectError(`This boat is in an old format (${version}) that this version of BoatWire cannot upgrade.`);
    data = step(data);
    version++;
  }

  const blank = blankProject();

  // Boat settings and zones
  const p = isObj(data.profile) ? data.profile : {};
  const zones: Zone[] = [];
  const zoneIds = new Set<string>();
  for (const z of Array.isArray(p.zones) ? p.zones : []) {
    if (!isObj(z) || typeof z.id !== 'string' || zoneIds.has(z.id)) continue;
    zoneIds.add(z.id);
    zones.push({ id: z.id, name: str(z.name, 'Zone'), x: num(z.x, 0), rise: num(z.rise, 0) });
  }
  if (!zones.length) {
    zones.push(...blank.profile.zones);
    for (const z of zones) zoneIds.add(z.id);
    notes.push('The boat had no zones, so the standard ones were added.');
  }
  const zoneOr = (x: unknown, fallback: string) => (typeof x === 'string' && zoneIds.has(x) ? x : zoneIds.has(fallback) ? fallback : zones[0].id);
  const profile: Project['profile'] = {
    name: str(p.name, blank.profile.name),
    lengthFt: num(p.lengthFt, blank.profile.lengthFt),
    systemVoltage: p.systemVoltage === 24 ? 24 : 12,
    acStandard: p.acStandard === 'eu230' ? 'eu230' : 'us120',
    batteryZone: zoneOr(p.batteryZone, blank.profile.batteryZone),
    panelZone: zoneOr(p.panelZone, blank.profile.panelZone),
    // Boats saved before the helm had its own setting used the cockpit.
    helmZone: zoneOr(p.helmZone, blank.profile.helmZone),
    zones,
  };

  // Equipment
  const equipment: Equipment[] = [];
  const eqIds = new Set<string>();
  let unknownKinds = 0;
  let brokenItems = 0;
  for (const e of Array.isArray(data.equipment) ? data.equipment : []) {
    if (!isObj(e)) {
      brokenItems++;
      continue;
    }
    const cat = typeof e.kind === 'string' ? CATALOG_BY_KIND[e.kind as EquipmentKind] : undefined;
    if (!cat) {
      unknownKinds++;
      continue;
    }
    let id = str(e.id, '');
    if (!id || eqIds.has(id)) id = uid();
    eqIds.add(id);
    const props: Record<string, PropValue> = { ...cat.props };
    if (isObj(e.props)) {
      for (const [k, v] of Object.entries(e.props)) if (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean') props[k] = v;
    }
    equipment.push({ id, kind: e.kind as EquipmentKind, name: str(e.name, cat.label), zone: str(e.zone, cat.zone), props });
  }
  if (unknownKinds) notes.push(`${plural(unknownKinds, 'item')} of a kind this version of BoatWire does not know ${unknownKinds === 1 ? 'was' : 'were'} left out.`);
  if (brokenItems) notes.push(`${plural(brokenItems, 'damaged equipment item')} ${brokenItems === 1 ? 'was' : 'were'} left out.`);

  // Scenarios
  const scenarios: Scenario[] = [];
  const scenIds = new Set<string>();
  for (const s of Array.isArray(data.scenarios) ? data.scenarios : []) {
    if (!isObj(s) || typeof s.id !== 'string' || scenIds.has(s.id)) continue;
    scenIds.add(s.id);
    const out: Scenario = { id: s.id, name: str(s.name, 'Scenario') };
    if (s.systemVoltage === 12 || s.systemVoltage === 24) out.systemVoltage = s.systemVoltage;
    if (typeof s.houseChemistry === 'string' && ['flooded', 'agm', 'gel', 'lifepo4'].includes(s.houseChemistry)) out.houseChemistry = s.houseChemistry as Scenario['houseChemistry'];
    if (typeof s.houseCapacityAh === 'number' && s.houseCapacityAh > 0) out.houseCapacityAh = s.houseCapacityAh;
    scenarios.push(out);
  }
  if (!scenarios.length) scenarios.push(...blank.scenarios);
  const activeScenario = typeof data.activeScenario === 'string' && scenarios.some((s) => s.id === data.activeScenario) ? data.activeScenario : scenarios[0].id;

  const project: Project = { version: PROJECT_VERSION, profile, equipment, scenarios, activeScenario };
  if (data.existing !== undefined && data.existing !== null) {
    const existing = parseDrawing(data.existing, profile.systemVoltage, notes);
    if (existing) project.existing = existing;
    else notes.push('The existing-boat drawing was damaged and has been left out.');
  }
  return { project, notes };
}

function parseDrawing(raw: unknown, volts: 12 | 24, notes: string[]): Design | undefined {
  if (!isObj(raw) || !Array.isArray(raw.nodes)) return undefined;
  const nodes: DNode[] = [];
  const ids = new Set<string>();
  let droppedNodes = 0;
  for (const n of raw.nodes) {
    if (!isObj(n) || typeof n.id !== 'string' || ids.has(n.id) || typeof n.type !== 'string' || !(n.type in NODE_DEFS)) {
      droppedNodes++;
      continue;
    }
    const type = n.type as NodeType;
    const def = NODE_DEFS[type];
    // Start from a fresh component of this type, then lay the saved values over it.
    const node = makeNode(type, n.id, str(n.label, def.label), { zone: str(n.zone, '') });
    if (typeof n.sublabel === 'string') node.sublabel = n.sublabel;
    if (typeof n.equipmentId === 'string') node.equipmentId = n.equipmentId;
    if (typeof n.role === 'string') node.role = n.role;
    node.col = num(n.col, node.col);
    if (isObj(n.data)) node.data = { ...n.data } as DNode['data'];
    if (Array.isArray(n.notes)) node.notes = n.notes.filter((x): x is string => typeof x === 'string');
    if (isObj(n.pos)) node.pos = { x: num(n.pos.x, 0), y: num(n.pos.y, 0) };
    const terms: Terminal[] = [];
    const termIds = new Set<string>();
    for (const t of Array.isArray(n.terminals) ? n.terminals : []) {
      if (!isObj(t) || typeof t.id !== 'string' || termIds.has(t.id) || !POLARITIES.includes(t.pol as Polarity)) continue;
      termIds.add(t.id);
      const term: Terminal = { id: t.id, pol: t.pol as Polarity, side: SIDES.includes(t.side as (typeof SIDES)[number]) ? (t.side as Terminal['side']) : 'E' };
      if (typeof t.label === 'string') term.label = t.label;
      if (typeof t.rating === 'number') term.rating = t.rating;
      terms.push(term);
    }
    if (terms.length) node.terminals = terms;
    ids.add(node.id);
    nodes.push(node);
  }
  if (droppedNodes) notes.push(`${plural(droppedNodes, 'component')} on the existing-boat drawing could not be read and ${droppedNodes === 1 ? 'was' : 'were'} left out.`);

  const byId = new Map(nodes.map((n) => [n.id, n]));
  const wires: Wire[] = [];
  const wireIds = new Set<string>();
  let droppedWires = 0;
  const end = (x: unknown) => {
    if (!isObj(x) || typeof x.node !== 'string' || typeof x.term !== 'string') return undefined;
    return byId.get(x.node)?.terminals.some((t) => t.id === x.term) ? { node: x.node, term: x.term } : undefined;
  };
  for (const w of Array.isArray(raw.wires) ? raw.wires : []) {
    const from = isObj(w) ? end(w.from) : undefined;
    const to = isObj(w) ? end(w.to) : undefined;
    if (!isObj(w) || !from || !to || !POLARITIES.includes(w.kind as Polarity)) {
      droppedWires++;
      continue;
    }
    let id = str(w.id, '');
    if (!id || wireIds.has(id)) id = uid('w');
    wireIds.add(id);
    const kind = w.kind as WireKind;
    const wire: Wire = { ...(w as unknown as Wire), id, kind, domain: kind === 'ac' || kind === 'gnd' ? 'ac' : 'dc', from, to, lengthFt: Math.max(0, num(w.lengthFt, 3)) };
    if (wire.gauge !== undefined && typeof wire.gauge !== 'string') delete wire.gauge;
    wires.push(wire);
  }
  if (droppedWires) notes.push(`${plural(droppedWires, 'wire')} on the existing-boat drawing pointed at something that is not there and ${droppedWires === 1 ? 'was' : 'were'} left out.`);

  const design: Design = { id: 'existing', name: 'Existing', systemVoltage: volts, nodes, wires, findings: [] };
  const u = raw.underlay;
  if (isObj(u) && typeof u.src === 'string' && u.src.startsWith('data:image/') && num(u.width, 0) > 0 && num(u.height, 0) > 0) {
    const underlay: Underlay = { src: u.src, name: str(u.name, 'diagram'), x: num(u.x, 0), y: num(u.y, 0), width: num(u.width, 0), height: num(u.height, 0), opacity: Math.min(1, Math.max(0.05, num(u.opacity, 0.5))), visible: u.visible !== false, locked: u.locked === true };
    design.underlay = underlay;
  } else if (u !== undefined && u !== null) {
    notes.push('The trace-over diagram was damaged and has been left out.');
  }
  return design;
}
