import ELK, { type ElkNode, type ElkExtendedEdge } from 'elkjs/lib/elk.bundled.js';
import { isBridge } from '../model/nodeDefs';
import type { Design, DNode, LayerSettings, Polarity, Wire } from '../model/types';

export type Side = 'W' | 'E' | 'N' | 'S';

export interface LaidPort {
  id: string;
  term: string;
  x: number;
  y: number;
  side: Side;
  pol: Polarity;
  label?: string;
}

export interface LaidNode {
  id: string;
  x: number;
  y: number;
  w: number;
  h: number;
  ports: LaidPort[];
  node: DNode;
  negHidden?: boolean;
  /** Panel only: number of branch circuits collapsed by the "Panel loads" layer. */
  hiddenCircuits?: number;
  hiddenAmps?: number;
}

export interface LaidEdge {
  id: string;
  wire: Wire;
  source: string;
  target: string;
  sourcePort: string;
  targetPort: string;
  points?: { x: number; y: number }[];
}

export interface Layout {
  nodes: LaidNode[];
  edges: LaidEdge[];
}

const PORT_GAP = 16;

export function baseSize(n: DNode): { w: number; h: number } {
  switch (n.type) {
    case 'bus-pos':
    case 'bus-neg':
    case 'ac-ground-bus':
      return { w: 22, h: 60 };
    case 'dc-panel':
    case 'ac-panel':
    case 'fuse-block':
      return { w: 190, h: 60 };
    case 'battery':
      return { w: 150, h: 78 };
    case 'fuse':
    case 'breaker':
      return { w: 112, h: 46 };
    case 'load':
    case 'ac-load':
      return { w: 150, h: 50 };
    case 'mppt':
    case 'dcdc':
    case 'charger':
    case 'inverter':
    case 'inverter-charger':
    case 'controller':
    case 'converter':
    case 'shunt':
    case 'acr':
    case 'isolator':
    case 'alternator':
    case 'engine':
    case 'selector':
    case 'transfer-switch':
      return { w: 200, h: 60 };
    case 'helm-switch':
      return { w: 120, h: 40 };
    default:
      return { w: 150, h: 60 };
  }
}

/** Which nodes and wires are visible under the current layer settings. */
export function visibleSubset(design: Design, layers: LayerSettings) {
  const nodeVisible = (n: DNode) => (n.domain === 'dc' ? layers.dc : layers.ac) || (isBridge(n) && (layers.dc || layers.ac));
  let nodes = design.nodes.filter(nodeVisible);
  // Optionally collapse loads fed from DC panel breakers into a per-panel summary.
  const hiddenCircuits = new Map<string, { count: number; amps: number }>();
  if (layers.panelLoads === 'collapse') {
    const byId = new Map(design.nodes.map((n) => [n.id, n]));
    const collapsed = new Set<string>();
    for (const w of design.wires) {
      if (w.kind !== 'pos') continue;
      for (const [pe, le] of [[w.from, w.to], [w.to, w.from]] as const) {
        const panel = byId.get(pe.node);
        const load = byId.get(le.node);
        if (panel?.type !== 'dc-panel' || load?.type !== 'load' || pe.term === 'in' || collapsed.has(load.id)) continue;
        collapsed.add(load.id);
        const h = hiddenCircuits.get(panel.id) ?? { count: 0, amps: 0 };
        h.count++;
        h.amps += Number(load.data.amps ?? 0);
        hiddenCircuits.set(panel.id, h);
      }
    }
    nodes = nodes.filter((n) => !collapsed.has(n.id));
  }
  const ids = new Set(nodes.map((n) => n.id));
  const N = new Map(nodes.map((n) => [n.id, n]));
  const negHidden = new Set<string>();
  const wires = design.wires.filter((w) => {
    if (!ids.has(w.from.node) || !ids.has(w.to.node)) return false;
    if (w.kind === 'sig') return layers.signal && layers.dc;
    if (w.kind === 'gnd') return w.equipmentGround ? layers.grounding : layers.ac || layers.grounding;
    if (w.kind === 'ac') return layers.ac;
    if (w.kind === 'neg') {
      if (!layers.dc) return false;
      if (layers.negatives === 'hidden') {
        negHidden.add(w.from.node).add(w.to.node);
        return false;
      }
      if (layers.negatives === 'buses') {
        const loadEnd = [N.get(w.from.node), N.get(w.to.node)].find((n) => n?.type === 'load');
        if (loadEnd) {
          negHidden.add(loadEnd.id);
          return false;
        }
      }
      return true;
    }
    return layers.dc || (w.domain === 'ac' && layers.ac);
  });
  // In collapsed view, a negative bus left with only its feeder is a dead end: hide it too.
  if (layers.panelLoads === 'collapse') {
    const count = new Map<string, number>();
    for (const w of wires) for (const e of [w.from, w.to]) count.set(e.node, (count.get(e.node) ?? 0) + 1);
    const stub = new Set(nodes.filter((n) => n.type === 'bus-neg' && (count.get(n.id) ?? 0) <= 1).map((n) => n.id));
    for (let i = wires.length - 1; i >= 0; i--) if (stub.has(wires[i].from.node) || stub.has(wires[i].to.node)) wires.splice(i, 1);
  }
  // drop "connector-only" nodes left with no wires
  const used = new Set(wires.flatMap((w) => [w.from.node, w.to.node]));
  const droppable = new Set<DNode['type']>(['bus-neg', 'ac-ground-bus', 'helm-switch', 'bms', 'regulator', 'apd', 'shunt']);
  nodes = nodes.filter((n) => used.has(n.id) || !droppable.has(n.type));
  return { nodes, wires, negHidden, hiddenCircuits };
}

function termOf(n: DNode, term: string) {
  return n.terminals.find((t) => t.id === term);
}

const elk = new ELK();

/** Automatic layered layout (used for generated designs). */
export async function autoLayout(design: Design, layers: LayerSettings): Promise<Layout> {
  const { nodes, wires, negHidden, hiddenCircuits } = visibleSubset(design, layers);
  const N = new Map(nodes.map((n) => [n.id, n]));
  // ports: one per wire end, side chosen by relative column
  const ports = new Map<string, LaidPort[]>();
  for (const n of nodes) ports.set(n.id, []);
  const edges: LaidEdge[] = [];
  for (const w of wires) {
    let a = N.get(w.from.node)!;
    let b = N.get(w.to.node)!;
    let ae = w.from;
    let be = w.to;
    if (a.col > b.col) {
      [a, b] = [b, a];
      [ae, be] = [be, ae];
    }
    const ta = termOf(a, ae.term);
    const tb = termOf(b, be.term);
    const sig = w.kind === 'sig';
    const sideA: Side = sig && ta?.side === 'N' ? 'N' : 'E';
    const sideB: Side = sig && tb?.side === 'N' ? 'N' : 'W';
    const pa: LaidPort = { id: `${w.id}:a`, term: ae.term, x: 0, y: 0, side: sideA, pol: ta?.pol ?? 'pos', label: ta?.label };
    const pb: LaidPort = { id: `${w.id}:b`, term: be.term, x: 0, y: 0, side: sideB, pol: tb?.pol ?? 'pos', label: tb?.label };
    ports.get(a.id)!.push(pa);
    ports.get(b.id)!.push(pb);
    edges.push({ id: w.id, wire: w, source: a.id, target: b.id, sourcePort: pa.id, targetPort: pb.id });
  }

  const sizes = new Map<string, { w: number; h: number }>();
  for (const n of nodes) {
    const base = baseSize(n);
    const ps = ports.get(n.id)!;
    const perSide = Math.max(ps.filter((p) => p.side === 'W').length, ps.filter((p) => p.side === 'E').length);
    const header = n.type === 'dc-panel' || n.type === 'ac-panel' || n.type === 'fuse-block' ? 44 : 14;
    const chip = hiddenCircuits.has(n.id) ? 26 : 0;
    sizes.set(n.id, { w: base.w, h: Math.max(base.h, header + perSide * PORT_GAP + 8 + chip) });
  }

  const sideName = { W: 'WEST', E: 'EAST', N: 'NORTH', S: 'SOUTH' } as const;
  const graph: ElkNode = {
    id: 'root',
    layoutOptions: {
      'elk.algorithm': 'layered',
      'elk.direction': 'RIGHT',
      'elk.edgeRouting': 'ORTHOGONAL',
      'elk.partitioning.activate': 'true',
      'elk.layered.spacing.nodeNodeBetweenLayers': '64',
      'elk.layered.spacing.edgeNodeBetweenLayers': '18',
      'elk.layered.spacing.edgeEdgeBetweenLayers': '8',
      'elk.spacing.nodeNode': '26',
      'elk.spacing.edgeEdge': '7',
      'elk.spacing.edgeNode': '14',
      'elk.layered.nodePlacement.strategy': 'NETWORK_SIMPLEX',
      'elk.layered.considerModelOrder.strategy': 'NODES_AND_EDGES',
      'elk.separateConnectedComponents': 'false',
    },
    children: nodes.map((n) => {
      const s = sizes.get(n.id)!;
      const ps = ports.get(n.id)!;
      // order: positive above negative within a side
      const rank = (p: LaidPort) => ({ sig: 0, ac: 1, pos: 2, gnd: 3, neg: 4 })[p.pol];
      ps.sort((x, y) => rank(x) - rank(y));
      const isPanel = n.type === 'dc-panel' || n.type === 'ac-panel' || n.type === 'fuse-block';
      const header = isPanel ? 44 : 14;
      // Panels and buses: let ELK order the positions to avoid crossings.
      const free = isPanel || n.type === 'bus-pos' || n.type === 'bus-neg' || n.type === 'ac-ground-bus';
      return {
        id: n.id,
        width: s.w,
        height: s.h,
        layoutOptions: {
          'elk.partitioning.partition': String(n.col),
          'elk.portConstraints': free ? 'FIXED_SIDE' : 'FIXED_ORDER',
          'elk.spacing.portPort': String(PORT_GAP - 4),
          'elk.layered.portAlignment.default': 'CENTER',
          'elk.padding': `[top=${header},left=0,bottom=4,right=0]`,
        },
        ports: ps.map((p, i) => ({
          id: p.id,
          width: 4,
          height: 4,
          layoutOptions: { 'elk.port.side': sideName[p.side], 'elk.port.index': String(p.side === 'W' ? ps.length - i : i) },
        })),
      };
    }),
    edges: edges.map((e) => ({ id: e.id, sources: [e.sourcePort], targets: [e.targetPort] }) as ElkExtendedEdge),
  };

  let res = await elk.layout(graph);
  // Pass 2: pin panel / bus ports at evenly spaced positions below the header,
  // in the order ELK chose in pass 1 (pass 1 ignores header padding).
  const freeIds = new Set(nodes.filter((n) => ['dc-panel', 'ac-panel', 'fuse-block', 'bus-pos', 'bus-neg', 'ac-ground-bus'].includes(n.type)).map((n) => n.id));
  if (freeIds.size) {
    for (const c of graph.children ?? []) {
      if (!freeIds.has(c.id)) continue;
      const rc = res.children?.find((x) => x.id === c.id);
      const n = N.get(c.id)!;
      const isPanel = n.type === 'dc-panel' || n.type === 'ac-panel' || n.type === 'fuse-block';
      const header = isPanel ? 44 : 4;
      const yOf = new Map((rc?.ports ?? []).map((p) => [p.id, p.y ?? 0]));
      c.layoutOptions = { ...c.layoutOptions, 'elk.portConstraints': 'FIXED_POS' };
      for (const side of ['W', 'E'] as const) {
        const sp = (c.ports ?? []).filter((p) => p.layoutOptions?.['elk.port.side'] === sideName[side]);
        sp.sort((a, b) => (yOf.get(a.id) ?? 0) - (yOf.get(b.id) ?? 0));
        sp.forEach((p, k) => {
          p.x = side === 'W' ? -4 : (c.width ?? 0);
          p.y = header + PORT_GAP * k + PORT_GAP / 2 - 2;
        });
      }
    }
    res = await elk.layout(graph);
  }
  const laid: LaidNode[] = [];
  for (const c of res.children ?? []) {
    const n = N.get(c.id)!;
    const ps = ports.get(c.id)!;
    for (const p of c.ports ?? []) {
      const lp = ps.find((x) => x.id === p.id);
      if (lp) {
        lp.x = (p.x ?? 0) + 2;
        lp.y = (p.y ?? 0) + 2;
        if (lp.side === 'W') lp.x = 0;
        if (lp.side === 'E') lp.x = c.width ?? 0;
        if (lp.side === 'W' || lp.side === 'E') lp.y = (p.y ?? 0) + 2;
        if (lp.side === 'N') lp.y = 0;
      }
    }
    const hc = hiddenCircuits.get(c.id);
    laid.push({ id: c.id, x: c.x ?? 0, y: c.y ?? 0, w: c.width ?? 100, h: c.height ?? 50, ports: ps, node: n, negHidden: negHidden.has(c.id), hiddenCircuits: hc?.count, hiddenAmps: hc?.amps });
  }
  const elkEdges = new Map((res.edges ?? []).map((e) => [e.id, e as ElkExtendedEdge]));
  for (const e of edges) {
    const s = elkEdges.get(e.id)?.sections?.[0];
    if (s) e.points = [s.startPoint, ...(s.bendPoints ?? []), s.endPoint];
  }
  return { nodes: laid, edges };
}

/** Layout for hand-drawn designs: user positions, one port per terminal. */
export function manualLayout(design: Design, layers: LayerSettings): Layout {
  const { nodes, wires, negHidden, hiddenCircuits } = visibleSubset(design, layers);
  const laid: LaidNode[] = nodes.map((n, i) => {
    const base = baseSize(n);
    const bySide: Record<Side, typeof n.terminals> = { W: [], E: [], N: [], S: [] };
    for (const t of n.terminals) bySide[t.side].push(t);
    const header = n.type === 'dc-panel' || n.type === 'ac-panel' || n.type === 'fuse-block' ? 44 : 18;
    const h = Math.max(base.h, header + Math.max(bySide.W.length, bySide.E.length) * PORT_GAP + 8);
    const w = base.w;
    const ports: LaidPort[] = [];
    for (const side of ['W', 'E'] as Side[]) {
      bySide[side].forEach((t, k) => {
        const y = bySide[side].length === 1 && header < 30 ? h / 2 : header + PORT_GAP * k + PORT_GAP / 2;
        ports.push({ id: t.id, term: t.id, x: side === 'W' ? 0 : w, y, side, pol: t.pol, label: t.rating ? t.label ?? `${t.rating} A` : t.label });
      });
    }
    for (const side of ['N', 'S'] as Side[]) {
      bySide[side].forEach((t, k) => {
        const x = ((k + 1) * w) / (bySide[side].length + 1);
        ports.push({ id: t.id, term: t.id, x, y: side === 'N' ? 0 : h, side, pol: t.pol, label: t.label });
      });
    }
    const pos = n.pos ?? { x: n.col * 230, y: (i % 8) * 90 };
    const hc = hiddenCircuits.get(n.id);
    return { id: n.id, x: pos.x, y: pos.y, w, h, ports, node: n, negHidden: negHidden.has(n.id), hiddenCircuits: hc?.count, hiddenAmps: hc?.amps };
  });
  const edges: LaidEdge[] = wires.map((w) => ({ id: w.id, wire: w, source: w.from.node, target: w.to.node, sourcePort: w.from.term, targetPort: w.to.term }));
  return { nodes: laid, edges };
}

/** Run ELK on a hand-drawn design and return positions. */
export async function arrangePositions(design: Design): Promise<Record<string, { x: number; y: number }>> {
  const all: LayerSettings = { dc: true, ac: true, negatives: 'full', signal: true, grounding: true, labels: { gauge: false, protection: false, current: false, length: false, vdrop: false, parts: false } };
  const l = await autoLayout(design, all);
  return Object.fromEntries(l.nodes.map((n) => [n.id, { x: n.x, y: n.y }]));
}
