// Reports derived from designs: wire schedule, bill of materials, scenario
// comparison metrics, and the existing → ideal change list.

import { NODE_DEFS } from '../model/nodeDefs';
import { FUSE_CLASSES, GAUGES } from '../model/standards';
import type { Design, DNode, Finding, Wire } from '../model/types';
import { audit, estimateCurrents, protectionOf } from './audit';
import { ampacity, fuseClassFor, gaugeIndex, gaugeSpec } from './calc';
import { ruleInfo } from './rules';
import { cableLabel, cableText, fmtLen, fmtSize, lenUnit, M_PER_FT, toLen, type Units } from '../model/units';

// ------------------------------------------------------------ wire schedule

export interface WireRow {
  id: string;
  circuit: string;
  from: string;
  to: string;
  kind: Wire['kind'];
  color: string;
  gauge: string;
  mm2: string;
  lengthFt: number;
  /** Size and length as shown in the boat's units: "10" / "6 mm²", feet / metres. */
  size: string;
  length: number;
  amps?: number;
  protection: string;
  vdrop?: number;
  vdropLimit?: number;
}

export function wireColor(w: Wire, hasAc: boolean): string {
  switch (w.kind) {
    case 'pos':
      return 'Red';
    case 'neg':
      return hasAc ? 'Yellow' : 'Black or yellow';
    case 'ac':
      return 'Black / white / green (3-cond)';
    case 'gnd':
      return 'Green';
    default:
      return 'Signal (any, labelled)';
  }
}

export function wireSchedule(design: Design, units: Units = 'imperial'): WireRow[] {
  const N = new Map(design.nodes.map((n) => [n.id, n]));
  const hasAc = design.nodes.some((n) => n.domain === 'ac');
  const est = estimateCurrents(design);
  return design.wires.map((w) => {
    const a = N.get(w.from.node);
    const b = N.get(w.to.node);
    const end = (n: DNode | undefined, t: string) => {
      if (!n) return '?';
      const term = n.terminals.find((x) => x.id === t);
      const tl = term?.label && !/^\d+ A ·/.test(term.label) ? ` (${term.label})` : '';
      return `${n.label}${tl}`;
    };
    const prot = w.protectedBy ? N.get(w.protectedBy) : undefined;
    let protection = prot ? `${prot.label}${prot.data.rating ? ` ${prot.data.rating} A` : ''}` : '';
    const panelEnd = [w.from, w.to].find((e) => N.get(e.node)?.terminals.some((t) => t.id === e.term && t.rating));
    const panelNode = panelEnd ? N.get(panelEnd.node) : undefined;
    const panelTerm = panelNode?.terminals.find((t) => t.id === panelEnd!.term);
    if (panelTerm?.rating) protection = `${panelTerm.rating} A ${panelNode!.type === 'fuse-block' ? 'fuse' : 'breaker'}`;
    const g = w.gauge ? gaugeSpec(w.gauge) : undefined;
    const loadEnd = [a, b].find((n) => n?.type === 'load' || n?.type === 'ac-load' || n?.type === 'engine');
    return {
      id: w.id,
      circuit: loadEnd?.label ?? `${a?.label ?? ''} → ${b?.label ?? ''}`,
      from: end(a, w.from.term),
      to: end(b, w.to.term),
      kind: w.kind,
      color: wireColor(w, hasAc),
      gauge: w.cable ?? (w.kind === 'ac' && w.gauge ? `${w.gauge}/3` : w.gauge ?? '—'),
      mm2: g ? String(g.mm2) : '',
      lengthFt: w.lengthFt,
      size: cableLabel(w, units) ?? '—',
      length: toLen(w.lengthFt, units),
      amps: w.amps ?? est.get(w.id),
      protection,
      vdrop: w.vdropPct,
      vdropLimit: w.vdropLimit,
    };
  });
}

// ------------------------------------------------------------ bill of materials

export interface BomRow {
  category: string;
  item: string;
  spec: string;
  qty: number;
  unit: string;
  /** Which entry of the price list (model/prices.ts) prices this line, if any does. */
  priceKey?: string;
  /** How many of that entry's units the line amounts to: feet of cable, kWh of battery, amps, watts, or a count. */
  priceQty?: number;
}

export function billOfMaterials(design: Design, units: Units = 'imperial'): BomRow[] {
  const rows = new Map<string, BomRow>();
  /** `price` = the price-list entry for this line and how many of its units one of these is (1 for a part sold each). */
  const add = (category: string, item: string, spec: string, qty: number, unit = 'ea', price?: [key: string, perItem: number]) => {
    const k = `${category}|${item}|${spec}|${unit}`;
    const priceQty = price && Number.isFinite(price[1]) && price[1] > 0 ? price[1] * (unit === 'ea' ? qty : 1) : undefined;
    const r = rows.get(k);
    if (r) {
      r.qty += qty;
      if (r.priceQty !== undefined && priceQty !== undefined) r.priceQty += priceQty;
      else r.priceQty = undefined;
    } else rows.set(k, { category, item, spec, qty, unit, priceKey: price?.[0], priceQty });
  };
  for (const n of design.nodes) {
    if (n.type === 'load' || n.type === 'ac-load' || n.type === 'engine' || n.type === 'note') continue;
    const def = NODE_DEFS[n.type];
    let spec = String(n.data.part ?? '');
    if (!spec && n.type === 'fuse' && n.data.fuseClass) {
      const cls = n.data.fuseClass as keyof typeof FUSE_CLASSES;
      spec = `${FUSE_CLASSES[cls]?.desc ?? cls}, ${n.data.rating} A + holder`;
    }
    if (!spec) spec = n.sublabel ?? (n.data.rating ? `${n.data.rating} A` : '');
    const cat = ['battery', 'bms'].includes(n.type)
      ? 'Batteries'
      : ['fuse', 'breaker', 'elci'].includes(n.type)
        ? 'Protection'
        : ['bus-pos', 'bus-neg', 'fuse-block', 'dc-panel', 'ac-panel', 'ac-ground-bus', 'shunt'].includes(n.type)
          ? 'Distribution'
          : n.domain === 'ac'
            ? 'AC equipment'
            : 'Charging & control';
    add(cat, def.label, spec, 1, 'ea', nodePrice(n, design.systemVoltage));
    // panel breakers
    if (n.type === 'dc-panel' || n.type === 'ac-panel' || n.type === 'fuse-block') {
      for (const t of n.terminals) {
        if (!t.rating) continue;
        const what = n.type === 'fuse-block' ? 'ATC/ATO blade fuse' : n.type === 'ac-panel' ? 'AC breaker (double-pole)' : 'DC panel breaker';
        add('Protection', what, `${t.rating} A`, 1, 'ea', [n.type === 'fuse-block' ? 'part:blade-fuse' : n.type === 'ac-panel' ? 'part:ac-breaker' : 'part:dc-breaker', 1]);
      }
    }
  }
  // cable by gauge and colour (+10% waste), lugs for ≥ 8 AWG
  const hasAc = design.nodes.some((n) => n.domain === 'ac');
  for (const w of design.wires) {
    if (!w.gauge) continue;
    const runs = w.cable?.match(/^(\d+)×/) ? Number(w.cable.split('×')[0]) : 1;
    // one run of this wire's size, whatever its parallel count: "4/0 AWG" or "120 mm²", "10/3" or "3G6"
    const single = { gauge: w.gauge, kind: w.kind };
    const len = w.lengthFt * 1.1 * runs;
    const label = w.kind === 'ac' ? `Marine AC cable ${cableLabel(single, units)}` : `Marine tinned wire ${fmtSize(w.gauge, units)}`;
    add('Cable', label, w.kind === 'ac' ? 'Type 3 boat cable' : wireColor(w, hasAc), len, lenUnit(units), [`${w.kind === 'ac' ? 'accable' : 'cable'}:${w.gauge}`, 1]);
    if (gaugeIndex(w.gauge) >= gaugeIndex('8') && w.kind !== 'ac') add('Terminals', 'Tinned lug', fmtSize(w.gauge, units), 2 * runs, 'ea', ['part:lug', 1]);
    else if (w.kind !== 'ac') add('Terminals', 'Heat-shrink ring terminal', fmtSize(w.gauge, units), 2, 'ea', ['part:ring-terminal', 1]);
  }
  // Cable was summed in feet; round each total up to whole feet or metres to buy. It is priced per foot.
  for (const r of rows.values()) {
    if (r.category !== 'Cable') continue;
    r.qty = Math.ceil(units === 'metric' ? r.qty * M_PER_FT : r.qty);
    if (r.priceKey) r.priceQty = units === 'metric' ? r.qty / M_PER_FT : r.qty;
  }
  return [...rows.values()].sort((a, b) => a.category.localeCompare(b.category) || a.item.localeCompare(b.item));
}

/**
 * The price-list entry for a component, and how many of that entry's units the component is:
 * 1 for a part sold each, kWh for a battery, amps or watts for equipment priced by its rating.
 */
function nodePrice(n: DNode, systemVolts: number): [string, number] | undefined {
  const d = n.data;
  const numOf = (v: unknown) => (typeof v === 'number' && v > 0 ? v : NaN);
  switch (n.type) {
    case 'battery':
      return [`battery:${String(d.chemistry ?? 'agm')}`, (numOf(d.ah) * (numOf(d.volts) || systemVolts)) / 1000];
    case 'fuse':
      // a hand-drawn fuse with no type recorded is priced as the usual type for its rating
      return [`fuse:${String(d.fuseClass ?? fuseClassFor(Number(d.rating ?? 0), {}))}`, 1];
    case 'bus-pos':
    case 'bus-neg':
    case 'ac-ground-bus':
      return ['part:busbar', 1];
    case 'dcdc':
    case 'converter':
    case 'mppt':
      return [`rate:${n.type}`, numOf(d.rating)];
    case 'charger':
    case 'alternator':
      return [`rate:${n.type}`, numOf(d.amps)];
    case 'inverter':
    case 'inverter-charger':
    case 'generator':
      return [`rate:${n.type}`, numOf(d.watts)];
    case 'solar-panel':
      return ['rate:solar', numOf(d.watts)];
    case 'wind-gen':
      return ['rate:wind', numOf(d.watts)];
    case 'hydro-gen':
      return ['rate:hydro', numOf(d.watts)];
    default:
      return [`part:${n.type}`, 1];
  }
}

// ------------------------------------------------------------ scenario metrics

export interface Metrics {
  volts: number;
  houseBank: string;
  mainFuse: string;
  mainCable: string;
  largestCable: string;
  copperLb: number;
  cableFt: number;
  components: number;
  errors: number;
  warnings: number;
  roles: Set<string>;
}

const LB_PER_CM_FT = 3.03e-6; // copper weight

export function designMetrics(design: Design, acVolts: number, units: Units = 'imperial'): Metrics {
  const house = design.nodes.find((n) => n.id === 'house0-bat');
  const fuse = design.nodes.find((n) => n.id === 'house0-fuse');
  const mainWire = design.wires.find((w) => w.from.node === 'house0-bat');
  let largest = -1;
  let copper = 0;
  let ft = 0;
  for (const w of design.wires) {
    if (!w.gauge) continue;
    const runs = w.cable?.match(/^(\d+)×/) ? Number(w.cable.split('×')[0]) : 1;
    const g = gaugeSpec(w.gauge);
    largest = Math.max(largest, gaugeIndex(w.gauge));
    const cond = w.kind === 'ac' ? 3 : 1;
    copper += (g?.cm ?? 0) * w.lengthFt * LB_PER_CM_FT * runs * cond;
    ft += w.lengthFt * runs;
  }
  const f = audit(design, { acVolts, units });
  const all = [...design.findings, ...f];
  return {
    volts: design.systemVoltage,
    houseBank: house?.sublabel ?? '—',
    mainFuse: fuse?.sublabel ?? '—',
    mainCable: mainWire ? cableText(mainWire, units) : '—',
    largestCable: largest >= 0 ? fmtSize(GAUGES[largest].awg, units) : '—',
    copperLb: Math.round(copper * 10) / 10,
    cableFt: Math.round(ft),
    components: design.nodes.filter((n) => !['load', 'ac-load', 'engine', 'note'].includes(n.type)).length,
    errors: all.filter((x) => x.severity === 'error').length,
    warnings: all.filter((x) => x.severity === 'warning').length,
    roles: new Set(design.nodes.map((n) => `${NODE_DEFS[n.type].label}`)),
  };
}

// ------------------------------------------------------------ change list

export interface Change {
  priority: 'safety' | 'recommended' | 'improvement';
  title: string;
  detail?: string;
  rule?: string;
  /** Parts the change needs, where they are known: price-list entry and how many of its units. Used for the cost estimate. */
  parts?: [key: string, qty: number][];
}

const INFRA: DNode['type'][] = [
  'fuse', 'switch', 'shunt', 'acr', 'isolator', 'dcdc', 'bms', 'contactor', 'apd', 'regulator', 'mppt', 'controller', 'dump-load',
  'elci', 'galvanic-isolator', 'selector', 'transfer-switch', 'ac-panel', 'ac-ground-bus', 'dc-panel', 'fuse-block',
  'bus-pos', 'bus-neg', 'converter', 'bilge-switch', 'breaker',
];

export function changeList(existing: Design, ideal: Design, acVolts: number, units: Units = 'imperial'): Change[] {
  const changes: Change[] = [];
  // 1. Fix audit problems in the existing design
  for (const f of audit(existing, { acVolts, units })) {
    if (f.severity === 'info') continue;
    changes.push({
      priority: f.severity === 'error' ? 'safety' : 'recommended',
      title: f.message,
      detail: [f.fix, ruleInfo(f.rule, units).why].filter(Boolean).join(' — '),
      rule: f.rule,
    });
  }
  // 2. Equipment missing from the existing drawing
  const exEq = new Set(existing.nodes.map((n) => n.equipmentId).filter(Boolean));
  const idealEqNodes = ideal.nodes.filter((n) => n.equipmentId && !n.id.startsWith('mppt-') && !n.id.startsWith('ctl-'));
  for (const n of idealEqNodes) {
    if (!exEq.has(n.equipmentId)) changes.push({ priority: 'improvement', title: `Install / connect: ${n.label}`, detail: n.sublabel });
  }
  // 3. Infrastructure the ideal design uses that the existing lacks (and vice versa)
  const count = (d: Design) => {
    const m = new Map<string, DNode[]>();
    for (const n of d.nodes) {
      if (!INFRA.includes(n.type)) continue;
      if (!m.has(n.type)) m.set(n.type, []);
      m.get(n.type)!.push(n);
    }
    return m;
  };
  const ci = count(ideal);
  const ce = count(existing);
  for (const [type, nodes] of ci) {
    const have = ce.get(type)?.length ?? 0;
    if (have >= nodes.length) continue;
    const missing = nodes.slice(have);
    const prio: Change['priority'] = ['fuse', 'elci', 'galvanic-isolator', 'selector', 'transfer-switch', 'apd'].includes(type) ? 'recommended' : 'improvement';
    changes.push({
      priority: prio,
      title: `Add ${missing.length} × ${NODE_DEFS[type as DNode['type']].label}`,
      detail: missing.map((n) => `${n.label}${n.sublabel ? ` (${n.sublabel})` : ''}`).join('; '),
      rule: missing[0].notes?.[0],
      parts: missing.map((n) => nodePrice(n, ideal.systemVoltage)).filter((x): x is [string, number] => !!x),
    });
  }
  for (const [type, nodes] of ce) {
    if (!ci.has(type)) {
      changes.push({
        priority: 'improvement',
        title: `Replace or remove ${nodes.length} × ${NODE_DEFS[type as DNode['type']].label}`,
        detail: `The ideal design doesn't use ${NODE_DEFS[type as DNode['type']].label.toLowerCase()} here (e.g. ${nodes[0].label}).`,
      });
    }
  }
  // 4. Per-load circuit comparison (gauge and protection)
  const ex = new Map(existing.nodes.filter((n) => n.equipmentId).map((n) => [n.equipmentId!, n]));
  const exNode = new Map(existing.nodes.map((n) => [n.id, n]));
  const exAmps = estimateCurrents(existing);
  const supply = (d: Design, n: DNode) => {
    const term = n.type === 'ac-load' ? 'l' : 'pos';
    const w = d.wires.find((x) => (x.to.node === n.id && x.to.term === term) || (x.from.node === n.id && x.from.term === term));
    return w;
  };
  for (const iNode of ideal.nodes) {
    if (!iNode.equipmentId || !['load', 'ac-load'].includes(iNode.type)) continue;
    const eNode = ex.get(iNode.equipmentId);
    if (!eNode) continue;
    const iw = supply(ideal, iNode);
    const ew = supply(existing, eNode);
    if (!iw || !ew || !iw.gauge) continue;
    if (!ew.gauge) {
      changes.push({ priority: 'improvement', title: `${iNode.label}: record the wire size`, detail: `Ideal: ${fmtSize(iw.gauge, units)}.` });
    } else {
      const current = ew.amps ?? exAmps.get(ew.id) ?? iw.amps ?? 0;
      // The ideal size assumes a cable on its own. A DC wire drawn as bundled needs the smallest
      // size from there up that the check accepts in its bundle: one that carries its current and
      // its fuse. If none does, the check's own finding says what to do.
      const bundled = ew.kind === 'pos' || ew.kind === 'neg' ? Math.floor(ew.bundledWith ?? 0) : 0;
      const need = Math.max(current, ...protectionOf(ew, (id) => exNode.get(id)).map((p) => p.rating));
      const target = bundled > 0 ? GAUGES.slice(gaugeIndex(iw.gauge)).find((g) => ampacity(g.awg, ew.inEngineSpace, false, bundled) >= need)?.awg : iw.gauge;
      if (target && gaugeIndex(ew.gauge) < gaugeIndex(target)) {
        const inBundle = bundled > 0 ? `, bundled with ${bundled} other wire${bundled === 1 ? '' : 's'}` : '';
        changes.push({ priority: 'recommended', title: `${iNode.label}: upsize wire ${fmtSize(ew.gauge, units)} → ${fmtSize(target, units)}`, detail: `At ~${Math.round(current)} A over ${fmtLen(iw.lengthFt, units)}${inBundle}.`, rule: 'conductor-sizing' , parts: [[`${iw.kind === 'ac' ? 'accable' : 'cable'}:${target}`, iw.lengthFt * (iw.kind === 'ac' ? 1 : 2)]] });
      }
    }
  }
  const order = { safety: 0, recommended: 1, improvement: 2 };
  return changes.sort((a, b) => order[a.priority] - order[b.priority]);
}

export function allFindings(design: Design, acVolts: number, units: Units = 'imperial'): Finding[] {
  return [...design.findings, ...audit(design, { acVolts, units })];
}

export interface FindingCounts {
  errors: number;
  warnings: number;
  notes: number;
}

/** Tally of findings by severity, for report summaries. */
export function findingCounts(findings: Finding[]): FindingCounts {
  return {
    errors: findings.filter((f) => f.severity === 'error').length,
    warnings: findings.filter((f) => f.severity === 'warning').length,
    notes: findings.filter((f) => f.severity === 'info').length,
  };
}
