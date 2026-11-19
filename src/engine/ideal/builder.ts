// The drawing board the ideal-design generator works on: add components, run wires between
// their terminals (sized as they are added), and record findings.

import { growTerminal, makeNode } from '../../model/nodeDefs';
import { fmtSize, type Units } from '../../model/units';
import { GAUGES, VDROP } from '../../model/standards';
import type { Chemistry, DNode, Equipment, Finding, NodeType, Severity, Wire, WireKind } from '../../model/types';
import { ampacity, nextStandard, PROTECTION_SIZES, protectionNeeded, sizeConductor, type ProtectionKind } from '../calc';
import { num } from '../energy';

/** One end of a wire: a component and the id of one of its terminals. */
export type End = [DNode, string];

export interface WOpts {
  amps: number;
  /** Rating of the protective device (wire ampacity must meet it). */
  protect?: number;
  limit?: number;
  len: number;
  /** Length used for the voltage-drop calculation (defaults to len). */
  vdLen?: number;
  volts?: number;
  engine?: boolean;
  notes?: string[];
  gauge?: string;
  protectedBy?: string;
  equipmentGround?: boolean;
}

/** A part sized from a list of standard sizes, and what to say if the list has nothing big enough. */
export interface SizeOpts {
  /** The part, as the finding names it, e.g. "Inverter/charger DC fuse". */
  what: string;
  /** Current through the part, in amps. Defaults to the size asked for. */
  carries?: number;
  /** What to do about it. Defaults to splitting the load (or 24 V on a 12 V boat). */
  fix?: string;
  /** Components the finding points at. */
  nodes?: string[];
  /**
   * The part limits its own output (a charge controller, a converter), so too small a one is
   * never overloaded: it just cannot deliver everything.
   */
  limitsItself?: boolean;
}

const CHEM_LABEL: Record<Chemistry, string> = { flooded: 'Flooded', agm: 'AGM', gel: 'Gel', lifepo4: 'LiFePO4' };
export const MPPT_SIZES = [10, 15, 20, 30, 50, 70, 85, 100];
export const CONVERTER_SIZES = [10, 20, 30, 40, 70];
export const SWITCH_SIZES = [300, 350, 600, 800];

export class Builder {
  nodes: DNode[] = [];
  wires: Wire[] = [];
  findings: Finding[] = [];
  private wn = 0;

  constructor(
    public V: number,
    public acV: number,
    public us: boolean,
    /** Units for the wording of notes (sizes and lengths). Calculations are the same either way. */
    public units: Units = 'imperial',
  ) {}

  add(type: NodeType, id: string, label: string, opts: Parameters<typeof makeNode>[3] = {}): DNode {
    const n = makeNode(type, id, label, { role: id, ...opts });
    this.nodes.push(n);
    return n;
  }

  stud(n: DNode, opts: Parameters<typeof growTerminal>[1] = {}): string {
    return growTerminal(n, opts);
  }

  wire(kind: WireKind, a: End, b: End, o: WOpts): Wire {
    const domain = kind === 'ac' || kind === 'gnd' ? 'ac' : 'dc';
    const volts = o.volts ?? (domain === 'ac' ? this.acV : this.V);
    const w: Wire = {
      id: `w${++this.wn}`,
      kind,
      domain,
      from: { node: a[0].id, term: a[1] },
      to: { node: b[0].id, term: b[1] },
      lengthFt: Math.round(o.len * 10) / 10,
      amps: Math.round(o.amps * 10) / 10,
      notes: o.notes,
      protectedBy: o.protectedBy,
      inEngineSpace: o.engine,
      equipmentGround: o.equipmentGround,
    };
    if (kind === 'sig') {
      w.gauge = o.gauge ?? '18';
      w.amps = undefined;
    } else if (o.gauge) {
      w.gauge = o.gauge;
    } else {
      const limit = o.limit ?? VDROP.critical;
      // The cable must carry both its fuse or breaker and its current. The fuse is normally the
      // larger, but not when no fuse is big enough for the current (rating() reports that).
      // A current that is not a number (a blank or zero input upstream) counts only through its fuse.
      const need = Math.max(o.protect ?? o.amps, Number.isFinite(o.amps) ? o.amps : 0);
      const r = sizeConductor({
        designAmps: o.amps,
        protectAmps: need,
        oneWayFt: o.vdLen ?? o.len,
        volts,
        vdropLimit: limit,
        inEngineSpace: o.engine,
        ac: kind === 'ac',
      });
      w.gauge = r.gauge;
      w.vdropLimit = limit;
      w.vdropPct = Math.round(r.vdropPct * 100) / 100;
      if (r.overflow) {
        const big = GAUGES[GAUGES.length - 1];
        const runs = Math.max(2, Math.ceil(need / ampacity(big.awg, o.engine, kind === 'ac')));
        w.cable = `${runs}× ${big.awg}`;
        w.vdropPct = Math.round((r.vdropPct / runs) * 100) / 100;
        this.find('warning', 'conductor-sizing', `${a[0].label} → ${b[0].label} needs ${runs} parallel ${fmtSize(big.awg, this.units)} cables.`, 'Consider a higher system voltage or moving the equipment closer to the batteries.', [a[0].id, b[0].id]);
      }
    }
    if (domain === 'ac' && kind === 'ac') w.cable = w.cable ?? `${w.gauge}/3`;
    this.wires.push(w);
    return w;
  }

  /** Positive + negative pair with identical gauge. */
  pair(pos: [End, End], neg: [End, End], o: WOpts): [Wire, Wire] {
    const p = this.wire('pos', pos[0], pos[1], o);
    const n = this.wire('neg', neg[0], neg[1], { ...o, gauge: p.gauge, notes: ['negative-same-size'], protectedBy: undefined });
    n.vdropPct = p.vdropPct;
    n.vdropLimit = p.vdropLimit;
    n.cable = p.cable;
    return [p, n];
  }

  find(severity: Severity, rule: string, message: string, fix?: string, nodes?: string[]) {
    if (this.findings.some((f) => f.message === message)) return;
    this.findings.push({ id: `g${this.findings.length + 1}`, rule, severity, message, fix, nodes });
  }

  /**
   * The smallest size in `list` of at least `need` amps. When nothing in the list is big enough,
   * the largest is drawn so the design stays complete, and a finding says so: an error when that
   * part is smaller than the current through it, a warning when only its margin is short.
   */
  rating(need: number, list: readonly number[], o: SizeOpts): number {
    const size = nextStandard(need, list);
    if (size !== undefined) return size;
    const max = list[list.length - 1];
    const amps = o.carries ?? need;
    const fix = o.fix ?? (this.V === 12 ? 'Use 24 V, which halves the current, split the load across two circuits, or use a larger dedicated circuit.' : 'Split the load across two circuits, or use a larger dedicated circuit.');
    const largest = `the largest BoatWire can choose is ${max} A`;
    if (max >= amps) {
      this.find('warning', 'beyond-sizes', `${o.what} should be at least ${Math.ceil(need)} A for about ${Math.round(amps)} A, but ${largest}. The ${max} A shown leaves too little margin.`, fix, o.nodes);
    } else if (o.limitsItself) {
      this.find('warning', 'beyond-sizes', `${o.what} would need to handle about ${Math.round(amps)} A, but ${largest}. The ${max} A shown limits its own output, so it cannot deliver all of it.`, fix, o.nodes);
    } else {
      this.find('error', 'beyond-sizes', `${o.what} carries about ${Math.round(amps)} A, but ${largest}. The ${max} A shown is too small for that current.`, fix, o.nodes);
    }
    return max;
  }

  /** Rating of the fuse or breaker for a continuous load of `loadAmps`. See rating() for a load too big for any. */
  protection(loadAmps: number, o: Omit<SizeOpts, 'carries' | 'limitsItself'>, kind: ProtectionKind = 'fuse'): number {
    return this.rating(protectionNeeded(loadAmps), PROTECTION_SIZES[kind], { ...o, carries: loadAmps });
  }
}

/** How a bank's batteries are arranged to reach the system voltage, and what that adds up to. */
export function bankSummary(e: Equipment, V: number) {
  const unitV = num(e, 'unitVolts', 12);
  const units = num(e, 'units', 1);
  const unitAh = num(e, 'unitAh', 100);
  const series = Math.max(1, Math.round(V / unitV));
  const parallel = Math.floor(units / series);
  const chem = (e.props.chemistry as Chemistry) ?? 'agm';
  return {
    unitV,
    units,
    unitAh,
    series,
    parallel,
    chem,
    ah: parallel * unitAh,
    valid: unitV <= V && units % series === 0 && parallel > 0,
    text: `${units}× ${unitV} V ${unitAh} Ah ${CHEM_LABEL[chem]} · ${series}S${parallel}P = ${V} V ${parallel * unitAh} Ah`,
  };
}

export function fuseLabel(rating: number, cls: string) {
  return `${rating} A ${cls}`;
}
