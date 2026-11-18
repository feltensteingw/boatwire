import type { DNode, Domain, NodeType, Polarity, Terminal } from './types';

type T = [id: string, pol: Polarity, side: Terminal['side'], label?: string];

interface NodeDef {
  label: string;
  domain: Domain;
  col: number;
  terminals: T[];
  /** Terminals created on demand (bus studs, panel outputs). */
  growable?: { prefix: string; pol: Polarity };
  /** Conducts between all same-polarity terminals (used by audit net tracing). */
  conducts: boolean;
  /** Provides over-current protection on its pass-through path. */
  protective?: boolean;
  /** Shown in the manual-design palette. */
  palette?: string;
}

// Column hints: 0 sources · 1 source protection · 2 converters · 3 batteries
// 4 battery protection · 5 buses · 6 feeders · 7 panels/contactors · 8 loads
export const NODE_DEFS: Record<NodeType, NodeDef> = {
  battery: { label: 'Battery bank', domain: 'dc', col: 3, terminals: [['pos', 'pos', 'E', '+'], ['neg', 'neg', 'E', '−']], conducts: false, palette: 'Storage' },
  fuse: { label: 'Fuse', domain: 'dc', col: 4, terminals: [['in', 'pos', 'W'], ['out', 'pos', 'E']], conducts: true, protective: true, palette: 'Protection' },
  breaker: { label: 'Circuit breaker', domain: 'dc', col: 6, terminals: [['in', 'pos', 'W'], ['out', 'pos', 'E']], conducts: true, protective: true, palette: 'Protection' },
  switch: { label: 'Battery switch', domain: 'dc', col: 4, terminals: [['in', 'pos', 'W'], ['out', 'pos', 'E']], conducts: true, palette: 'Switching' },
  selector: { label: 'AC source selector', domain: 'ac', col: 2, terminals: [['in1', 'ac', 'W', 'Shore'], ['in2', 'ac', 'W', 'Gen'], ['out', 'ac', 'E']], conducts: true, palette: 'AC' },
  'transfer-switch': { label: 'Automatic transfer switch', domain: 'ac', col: 2, terminals: [['in1', 'ac', 'W', 'Shore'], ['in2', 'ac', 'W', 'Inv'], ['out', 'ac', 'E']], conducts: true, palette: 'AC' },
  'bus-pos': { label: 'Positive busbar', domain: 'dc', col: 5, terminals: [], growable: { prefix: 's', pol: 'pos' }, conducts: true, palette: 'Distribution' },
  'bus-neg': { label: 'Negative busbar', domain: 'dc', col: 5, terminals: [], growable: { prefix: 's', pol: 'neg' }, conducts: true, palette: 'Distribution' },
  'fuse-block': { label: 'Fuse block', domain: 'dc', col: 6, terminals: [['in', 'pos', 'W']], growable: { prefix: 'f', pol: 'pos' }, conducts: true, protective: true, palette: 'Distribution' },
  shunt: { label: 'Battery monitor shunt', domain: 'dc', col: 4, terminals: [['bat', 'neg', 'W', 'BAT−'], ['sys', 'neg', 'E', 'SYS−']], conducts: true, palette: 'Distribution' },
  acr: { label: 'Automatic charging relay (ACR)', domain: 'dc', col: 4, terminals: [['a', 'pos', 'W', 'A'], ['b', 'pos', 'E', 'B'], ['neg', 'neg', 'W', '−']], conducts: true, palette: 'Charging' },
  isolator: { label: 'Battery isolator (diode / FET)', domain: 'dc', col: 4, terminals: [['in', 'pos', 'W', 'ALT'], ['out1', 'pos', 'E', 'B1'], ['out2', 'pos', 'E', 'B2'], ['neg', 'neg', 'W', '−']], conducts: true, palette: 'Charging' },
  dcdc: { label: 'DC-DC charger', domain: 'dc', col: 4, terminals: [['in', 'pos', 'W', 'IN+'], ['inneg', 'neg', 'W', 'IN−'], ['out', 'pos', 'E', 'OUT+'], ['outneg', 'neg', 'E', 'OUT−'], ['run', 'sig', 'N', 'run']], conducts: false, palette: 'Charging' },
  bms: { label: 'External BMS', domain: 'dc', col: 4, terminals: [['cells', 'sig', 'W', 'cells'], ['atc', 'sig', 'E', 'ATC'], ['atd', 'sig', 'E', 'ATD'], ['ctl', 'sig', 'E', 'ctl']], conducts: false, palette: 'Storage' },
  contactor: { label: 'Contactor / solenoid', domain: 'dc', col: 7, terminals: [['in', 'pos', 'W'], ['out', 'pos', 'E'], ['coil', 'sig', 'N', 'coil']], conducts: true, palette: 'Switching' },
  apd: { label: 'Alternator protection device', domain: 'dc', col: 1, terminals: [['b', 'pos', 'W', 'B+'], ['neg', 'neg', 'W', '−']], conducts: false, palette: 'Charging' },
  regulator: { label: 'External alternator regulator', domain: 'dc', col: 1, terminals: [['field', 'sig', 'W', 'field'], ['sense', 'sig', 'E', 'sense'], ['atc', 'sig', 'E', 'ATC']], conducts: false, palette: 'Charging' },
  alternator: { label: 'Alternator', domain: 'dc', col: 0, terminals: [['b', 'pos', 'E', 'B+'], ['neg', 'neg', 'E', 'B−'], ['field', 'sig', 'E', 'F']], conducts: false, palette: 'Charging' },
  'solar-panel': { label: 'Solar array', domain: 'dc', col: 0, terminals: [['pos', 'pos', 'E', 'PV+'], ['neg', 'neg', 'E', 'PV−']], conducts: false, palette: 'Charging' },
  mppt: { label: 'MPPT solar controller', domain: 'dc', col: 2, terminals: [['pvpos', 'pos', 'W', 'PV+'], ['pvneg', 'neg', 'W', 'PV−'], ['bat', 'pos', 'E', 'BAT+'], ['batneg', 'neg', 'E', 'BAT−'], ['atc', 'sig', 'N', 'ATC']], conducts: false, palette: 'Charging' },
  'wind-gen': { label: 'Wind generator', domain: 'dc', col: 0, terminals: [['pos', 'pos', 'E', '+'], ['neg', 'neg', 'E', '−']], conducts: false, palette: 'Charging' },
  'hydro-gen': { label: 'Hydro generator', domain: 'dc', col: 0, terminals: [['pos', 'pos', 'E', '+'], ['neg', 'neg', 'E', '−']], conducts: false, palette: 'Charging' },
  controller: { label: 'Charge controller', domain: 'dc', col: 2, terminals: [['in', 'pos', 'W', 'IN+'], ['inneg', 'neg', 'W', 'IN−'], ['bat', 'pos', 'E', 'BAT+'], ['batneg', 'neg', 'E', 'BAT−'], ['dump', 'pos', 'E', 'DUMP']], conducts: false, palette: 'Charging' },
  'dump-load': { label: 'Dump load', domain: 'dc', col: 3, terminals: [['pos', 'pos', 'W', '+'], ['neg', 'neg', 'W', '−']], conducts: false, palette: 'Charging' },
  'shore-inlet': { label: 'Shore power inlet', domain: 'ac', col: 0, terminals: [['l', 'ac', 'E', 'L/N'], ['g', 'gnd', 'E', 'G']], conducts: false, palette: 'AC' },
  generator: { label: 'AC generator', domain: 'ac', col: 0, terminals: [['l', 'ac', 'E', 'L/N'], ['g', 'gnd', 'E', 'G']], conducts: false, palette: 'AC' },
  elci: { label: 'Main breaker + ELCI', domain: 'ac', col: 1, terminals: [['in', 'ac', 'W'], ['out', 'ac', 'E']], conducts: true, protective: true, palette: 'AC' },
  'galvanic-isolator': { label: 'Galvanic isolator', domain: 'ac', col: 1, terminals: [['a', 'gnd', 'W'], ['b', 'gnd', 'E']], conducts: true, palette: 'AC' },
  'ac-panel': { label: 'AC panel', domain: 'ac', col: 7, terminals: [['in', 'ac', 'W', 'MAIN']], growable: { prefix: 'b', pol: 'ac' }, conducts: true, protective: true, palette: 'AC' },
  'ac-ground-bus': { label: 'AC grounding bus', domain: 'ac', col: 5, terminals: [], growable: { prefix: 's', pol: 'gnd' }, conducts: true, palette: 'AC' },
  charger: { label: 'Battery charger', domain: 'dc', col: 2, terminals: [['acin', 'ac', 'W', 'AC in'], ['g', 'gnd', 'W', 'G'], ['out1', 'pos', 'E', 'OUT1+'], ['neg', 'neg', 'E', '−']], conducts: false, palette: 'Charging' },
  inverter: { label: 'Inverter', domain: 'dc', col: 2, terminals: [['dcpos', 'pos', 'E', 'DC+'], ['dcneg', 'neg', 'E', 'DC−'], ['acout', 'ac', 'W', 'AC out'], ['g', 'gnd', 'W', 'G']], conducts: false, palette: 'Charging' },
  'inverter-charger': { label: 'Inverter / charger', domain: 'dc', col: 2, terminals: [['acin', 'ac', 'W', 'AC in'], ['acout', 'ac', 'W', 'AC out'], ['g', 'gnd', 'W', 'G'], ['dcpos', 'pos', 'E', 'DC+'], ['dcneg', 'neg', 'E', 'DC−'], ['atc', 'sig', 'N', 'ATC']], conducts: false, palette: 'Charging' },
  'dc-panel': { label: 'DC distribution panel', domain: 'dc', col: 7, terminals: [['in', 'pos', 'W', 'MAIN']], growable: { prefix: 'b', pol: 'pos' }, conducts: true, protective: true, palette: 'Distribution' },
  converter: { label: 'DC-DC converter 24→12 V', domain: 'dc', col: 6, terminals: [['in', 'pos', 'W', '24V+'], ['inneg', 'neg', 'W', '−'], ['out', 'pos', 'E', '12V+'], ['outneg', 'neg', 'E', '−']], conducts: false, palette: 'Distribution' },
  engine: { label: 'Engine / starter', domain: 'dc', col: 8, terminals: [['pos', 'pos', 'W', 'Starter +'], ['neg', 'neg', 'W', 'Block −'], ['run', 'sig', 'N', 'D+']], conducts: false, palette: 'Loads' },
  load: { label: 'DC load', domain: 'dc', col: 8, terminals: [['pos', 'pos', 'W', '+'], ['neg', 'neg', 'W', '−']], conducts: false, palette: 'Loads' },
  'ac-load': { label: 'AC load', domain: 'ac', col: 8, terminals: [['l', 'ac', 'W', 'L/N'], ['g', 'gnd', 'W', 'G']], conducts: false, palette: 'Loads' },
  'bilge-switch': { label: 'Bilge switch (Auto/Off/Man)', domain: 'dc', col: 7, terminals: [['in', 'pos', 'W'], ['out', 'pos', 'E']], conducts: true, palette: 'Switching' },
  'helm-switch': { label: 'Helm control switch', domain: 'dc', col: 6, terminals: [['out', 'sig', 'E', 'ctl']], conducts: false, palette: 'Switching' },
  // A label for anything BoatWire has no symbol for. It has no terminals and takes no part in the checks or reports.
  note: { label: 'Note', domain: 'dc', col: 8, terminals: [], conducts: false, palette: 'Notes' },
};

export function makeNode(
  type: NodeType,
  id: string,
  label: string,
  opts: Partial<Omit<DNode, 'id' | 'type' | 'label' | 'terminals'>> & { extraTerminals?: T[] } = {},
): DNode {
  const def = NODE_DEFS[type];
  const { extraTerminals, ...rest } = opts;
  return {
    id,
    type,
    label,
    domain: def.domain,
    col: def.col,
    zone: '',
    data: {},
    ...rest,
    terminals: [...def.terminals, ...(extraTerminals ?? [])].map(([tid, pol, side, tl]) => ({ id: tid, pol, side, label: tl })),
  };
}

/** Add an on-demand terminal (bus stud, panel breaker position…) and return its id. */
export function growTerminal(node: DNode, opts: { pol?: Polarity; label?: string; rating?: number; side?: Terminal['side'] } = {}): string {
  const def = NODE_DEFS[node.type];
  const prefix = def.growable?.prefix ?? 't';
  const n = node.terminals.filter((t) => t.id.startsWith(prefix) && /\d+$/.test(t.id)).length + 1;
  const id = `${prefix}${n}`;
  node.terminals.push({
    id,
    pol: opts.pol ?? def.growable?.pol ?? 'pos',
    side: opts.side ?? 'E',
    label: opts.label,
    rating: opts.rating,
  });
  return id;
}

export function isBridge(node: DNode): boolean {
  const pols = new Set(node.terminals.map((t) => t.pol));
  return pols.has('ac') && (pols.has('pos') || pols.has('neg'));
}

export function terminal(node: DNode, term: string): Terminal | undefined {
  return node.terminals.find((t) => t.id === term);
}
