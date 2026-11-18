// Reports derived from designs: wire schedule, bill of materials, scenario
// comparison metrics, and the existing → ideal change list.

import { NODE_DEFS } from '../model/nodeDefs';
import { FUSE_CLASSES, GAUGES } from '../model/standards';
import type { Design, DNode, Finding, Wire } from '../model/types';
import { audit, estimateCurrents } from './audit';
import { gaugeIndex, gaugeSpec } from './calc';
import { ruleInfo } from './rules';

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

export function wireSchedule(design: Design): WireRow[] {
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
}

export function billOfMaterials(design: Design): BomRow[] {
  const rows = new Map<string, BomRow>();
  const add = (category: string, item: string, spec: string, qty: number, unit = 'ea') => {
    const k = `${category}|${item}|${spec}|${unit}`;
    const r = rows.get(k);
    if (r) r.qty += qty;
    else rows.set(k, { category, item, spec, qty, unit });
  };
  for (const n of design.nodes) {
    if (n.type === 'load' || n.type === 'ac-load' || n.type === 'engine') continue;
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
    add(cat, def.label, spec, 1);
    // panel breakers
    if (n.type === 'dc-panel' || n.type === 'ac-panel' || n.type === 'fuse-block') {
      for (const t of n.terminals) {
        if (!t.rating) continue;
        const what = n.type === 'fuse-block' ? 'ATC/ATO blade fuse' : n.type === 'ac-panel' ? 'AC breaker (double-pole)' : 'DC panel breaker';
        add('Protection', what, `${t.rating} A`, 1);
      }
    }
  }
  // cable by gauge and colour (+10% waste), lugs for ≥ 8 AWG
  const hasAc = design.nodes.some((n) => n.domain === 'ac');
  for (const w of design.wires) {
    if (!w.gauge) continue;
    const runs = w.cable?.match(/^(\d+)×/) ? Number(w.cable.split('×')[0]) : 1;
    const len = Math.ceil(w.lengthFt * 1.1 * runs);
    const label = w.kind === 'ac' ? `Marine AC cable ${w.gauge}/3` : `Marine tinned wire ${w.gauge} AWG`;
    add('Cable', label, w.kind === 'ac' ? 'Type 3 boat cable' : wireColor(w, hasAc), len, 'ft');
    if (gaugeIndex(w.gauge) >= gaugeIndex('8') && w.kind !== 'ac') add('Terminals', 'Tinned lug', `${w.gauge} AWG`, 2 * runs);
    else if (w.kind !== 'ac') add('Terminals', 'Heat-shrink ring terminal', `${w.gauge} AWG`, 2);
  }
  return [...rows.values()].sort((a, b) => a.category.localeCompare(b.category) || a.item.localeCompare(b.item));
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

export function designMetrics(design: Design, acVolts: number): Metrics {
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
  const f = audit(design, { acVolts });
  const all = [...design.findings, ...f];
  return {
    volts: design.systemVoltage,
    houseBank: house?.sublabel ?? '—',
    mainFuse: fuse?.sublabel ?? '—',
    mainCable: mainWire ? mainWire.cable ?? `${mainWire.gauge} AWG` : '—',
    largestCable: largest >= 0 ? `${GAUGES[largest].awg} AWG` : '—',
    copperLb: Math.round(copper * 10) / 10,
    cableFt: Math.round(ft),
    components: design.nodes.filter((n) => !['load', 'ac-load', 'engine'].includes(n.type)).length,
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
}

const INFRA: DNode['type'][] = [
  'fuse', 'switch', 'shunt', 'acr', 'isolator', 'dcdc', 'bms', 'contactor', 'apd', 'regulator', 'mppt', 'controller', 'dump-load',
  'elci', 'galvanic-isolator', 'selector', 'transfer-switch', 'ac-panel', 'ac-ground-bus', 'dc-panel', 'fuse-block',
  'bus-pos', 'bus-neg', 'converter', 'bilge-switch', 'breaker',
];

export function changeList(existing: Design, ideal: Design, acVolts: number): Change[] {
  const changes: Change[] = [];
  // 1. Fix audit problems in the existing design
  for (const f of audit(existing, { acVolts })) {
    if (f.severity === 'info') continue;
    changes.push({
      priority: f.severity === 'error' ? 'safety' : 'recommended',
      title: f.message,
      detail: [f.fix, ruleInfo(f.rule).why].filter(Boolean).join(' — '),
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
      changes.push({ priority: 'improvement', title: `${iNode.label}: record the wire size`, detail: `Ideal: ${iw.gauge} AWG.` });
    } else if (gaugeIndex(ew.gauge) < gaugeIndex(iw.gauge)) {
      changes.push({ priority: 'recommended', title: `${iNode.label}: upsize wire ${ew.gauge} → ${iw.gauge} AWG`, detail: `At ~${Math.round(ew.amps ?? exAmps.get(ew.id) ?? iw.amps ?? 0)} A over ${iw.lengthFt} ft.`, rule: 'conductor-sizing' });
    }
  }
  const order = { safety: 0, recommended: 1, improvement: 2 };
  return changes.sort((a, b) => order[a.priority] - order[b.priority]);
}

export function allFindings(design: Design, acVolts: number): Finding[] {
  return [...design.findings, ...audit(design, { acVolts })];
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
