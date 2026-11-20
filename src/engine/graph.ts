// Electrical graph helpers shared by the audit and current estimation.

import { NODE_DEFS } from '../model/nodeDefs';
import type { Design, DNode, Polarity, Wire } from '../model/types';

export interface Graph {
  design: Design;
  node: Map<string, DNode>;
  /** wires attached to "node|term" */
  at: Map<string, Wire[]>;
}

export const key = (node: string, term: string) => `${node}|${term}`;

export function buildGraph(design: Design): Graph {
  const node = new Map(design.nodes.map((n) => [n.id, n]));
  const at = new Map<string, Wire[]>();
  for (const w of design.wires) {
    if (!node.has(w.from.node) || !node.has(w.to.node)) continue;
    for (const e of [w.from, w.to]) {
      const k = key(e.node, e.term);
      if (!at.has(k)) at.set(k, []);
      at.get(k)!.push(w);
    }
  }
  return { design, node, at };
}

export function otherEnd(w: Wire, node: string, term: string) {
  return w.from.node === node && w.from.term === term ? w.to : w.from;
}

export function termPol(n: DNode, term: string): Polarity | undefined {
  return n.terminals.find((t) => t.id === term)?.pol;
}

/** Terminals reachable *through* a node from a given terminal (same polarity). */
export function passThrough(n: DNode, term: string): string[] {
  const def = NODE_DEFS[n.type];
  if (!def.conducts) return [];
  const pol = termPol(n, term);
  const same = n.terminals.filter((t) => t.pol === pol && t.id !== term).map((t) => t.id);
  if (n.type === 'selector' || n.type === 'transfer-switch') {
    return term === 'out' ? same.filter((t) => t.startsWith('in')) : same.filter((t) => t === 'out');
  }
  if (n.type === 'acr') return same.filter((t) => t === 'a' || t === 'b');
  // Isolator: current flows input → outputs only; outputs are never joined to each other.
  if (n.type === 'isolator') return term === 'in' ? same.filter((t) => t.startsWith('out')) : term.startsWith('out') ? ['in'] : [];
  return same;
}

/** Does crossing this node from `fromTerm` add over-current protection? */
export function crossingProtects(n: DNode, fromTerm: string): boolean {
  const def = NODE_DEFS[n.type];
  if (!def.protective) return false;
  if (n.type === 'dc-panel' || n.type === 'ac-panel' || n.type === 'fuse-block') {
    // protection lives on the output positions
    const t = n.terminals.find((x) => x.id === fromTerm);
    return !!t && t.id !== 'in' && (t.rating ?? 0) > 0;
  }
  return true;
}

/** Terminals that act as current sources for a DC positive net. */
export const SOURCE_TERMS: Record<string, string[]> = {
  alternator: ['b'],
  mppt: ['bat'],
  charger: ['out1', 'out2', 'out3'],
  controller: ['bat'],
  dcdc: ['out'],
  converter: ['out'],
  inverter: ['dcpos'],
  'inverter-charger': ['dcpos'],
};

export const AC_SOURCE_TERMS: Record<string, string[]> = {
  'shore-inlet': ['l'],
  generator: ['l'],
  inverter: ['acout'],
  'inverter-charger': ['acout'],
};

export interface Reach {
  node: DNode;
  term: string;
  protectedPath: boolean;
  switched: boolean;
  selected: boolean;
  via: string[]; // node ids crossed
}

/**
 * Walk outward from a terminal across wires of the given kinds and through
 * conducting nodes, reporting every non-conducting terminal reached.
 */
export function walk(
  g: Graph,
  start: { node: string; term: string },
  kinds: Wire['kind'][],
  opts: { stopAtSwitch?: boolean; exclude?: string } = {},
): Reach[] {
  const out: Reach[] = [];
  const seen = new Set<string>();
  type S = { node: string; term: string; prot: boolean; sw: boolean; sel: boolean; via: string[]; viaWire?: string };
  const stack: S[] = [{ node: start.node, term: start.term, prot: false, sw: false, sel: false, via: [] }];
  while (stack.length) {
    const s = stack.pop()!;
    for (const w of g.at.get(key(s.node, s.term)) ?? []) {
      if (!kinds.includes(w.kind) || w.id === s.viaWire || w.id === opts.exclude) continue;
      const o = otherEnd(w, s.node, s.term);
      const n = g.node.get(o.node);
      if (!n) continue;
      const sk = `${o.node}|${o.term}|${s.prot}|${s.sw}|${s.sel}`;
      if (seen.has(sk)) continue;
      seen.add(sk);
      const through = passThrough(n, o.term);
      if (through.length === 0 || (opts.stopAtSwitch && n.type === 'switch')) {
        out.push({ node: n, term: o.term, protectedPath: s.prot, switched: s.sw, selected: s.sel, via: s.via });
        continue;
      }
      const prot = s.prot || crossingProtects(n, o.term);
      const sw = s.sw || n.type === 'switch' || n.type === 'contactor';
      const sel = s.sel || n.type === 'selector' || n.type === 'transfer-switch';
      for (const t of through) {
        stack.push({ node: n.id, term: t, prot, sw, sel, via: [...s.via, n.id], viaWire: w.id });
      }
    }
  }
  return out;
}

/** Union-find of positive nets (through conducting nodes, switches assumed closed). */
export function positiveNets(g: Graph): Map<string, string> {
  const parent = new Map<string, string>();
  const find = (x: string): string => {
    if (!parent.has(x)) parent.set(x, x);
    const p = parent.get(x)!;
    if (p === x) return x;
    const r = find(p);
    parent.set(x, r);
    return r;
  };
  const union = (a: string, b: string) => parent.set(find(a), find(b));
  for (const w of g.design.wires) if (w.kind === 'pos') union(key(w.from.node, w.from.term), key(w.to.node, w.to.term));
  for (const n of g.design.nodes) {
    if (n.type === 'isolator') continue; // one-way device: each output is its own net
    for (const t of n.terminals) {
      if (t.pol !== 'pos') continue;
      for (const o of passThrough(n, t.id)) union(key(n.id, t.id), key(n.id, o));
    }
  }
  const res = new Map<string, string>();
  for (const k of parent.keys()) res.set(k, find(k));
  return res;
}
