import { describe, expect, it } from 'vitest';
import { audit, estimateCurrents } from '../src/engine/audit';
import { sizeDrawing } from '../src/engine/autosize';
import { existingFromIdeal, paletteNode } from '../src/engine/existing';
import { focusNodes } from '../src/engine/focus';
import { generateIdeal } from '../src/engine/generate';
import { exampleProject } from '../src/model/examples';
import type { Design, DNode, NodeType, Wire, WireKind } from '../src/model/types';
import { acVoltsOf, FINGERPRINT_BOATS, SAMPLE_BOATS } from './sampleBoats';

/** The rules "Size wires and fuses" is there to satisfy. */
const SIZING_RULES = new Set(['conductor-sizing', 'branch-protection', 'battery-fuse', 'charging-source-fuse', 'unsized-wire']);

/** A copy of a design as a hand drawing with no sizes, ratings or stored currents: what an owner draws. */
function stripped(d: Design): Design {
  const c = existingFromIdeal(d, {});
  for (const w of c.wires) {
    if (w.kind === 'pos' || w.kind === 'neg' || w.kind === 'ac') delete w.gauge;
    delete w.vdropPct;
    delete w.amps;
    // keep parallel runs ("2× 4/0"): the owner draws two cables as one wire with that label
    if (!w.cable?.match(/^\d+× /)) delete w.cable;
  }
  for (const n of c.nodes) {
    if (n.type === 'fuse' || n.type === 'breaker') delete n.data.rating;
    if (n.type === 'dc-panel' || n.type === 'ac-panel' || n.type === 'fuse-block') for (const t of n.terminals) if (t.id !== 'in') delete t.rating;
  }
  return c;
}

let seq = 0;
function draw(types: NodeType[], data: Record<number, DNode['data']> = {}): Design {
  const nodes = types.map((t, i) => {
    const n = paletteNode(t, 'nav');
    n.id = `n${i}`;
    Object.assign(n.data, data[i] ?? {});
    return n;
  });
  return { id: 'existing', name: 'Existing', systemVoltage: 12, nodes, wires: [], findings: [] };
}
function wire(d: Design, kind: WireKind, a: [number, string], b: [number, string], lengthFt = 10, extra: Partial<Wire> = {}) {
  d.wires.push({ id: `w${seq++}`, kind, domain: kind === 'ac' ? 'ac' : 'dc', from: { node: `n${a[0]}`, term: a[1] }, to: { node: `n${b[0]}`, term: b[1] }, lengthFt, ...extra });
}
const sizingErrors = (d: Design, acVolts = 120) => audit(d, { acVolts }).filter((f) => f.severity === 'error' && SIZING_RULES.has(f.rule)).map((f) => `${f.rule}: ${f.message}`);

describe('Size wires and fuses', () => {
  it('a bare circuit drawn with no fuse and no sizes comes out passing the check', () => {
    // battery → positive bus → cabin lights, and the negative back
    const d = draw(['battery', 'bus-pos', 'load', 'bus-neg'], { 0: { chemistry: 'agm' }, 2: { amps: 8 } });
    d.nodes[1].terminals.push({ id: 's1', pol: 'pos', side: 'E' }, { id: 's2', pol: 'pos', side: 'E' });
    d.nodes[3].terminals.push({ id: 's1', pol: 'neg', side: 'E' }, { id: 's2', pol: 'neg', side: 'E' });
    wire(d, 'pos', [0, 'pos'], [1, 's1'], 3);
    wire(d, 'pos', [1, 's2'], [2, 'pos'], 15);
    wire(d, 'neg', [2, 'neg'], [3, 's1'], 15);
    wire(d, 'neg', [3, 's2'], [0, 'neg'], 3);
    expect(sizingErrors(d)).not.toEqual([]);

    const r = sizeDrawing(d);
    expect(r.counts.fusesAdded).toBe(2); // one at the battery, one for the load
    expect(r.counts.sized).toBe(d.wires.length);
    expect(sizingErrors(d)).toEqual([]);
    // the new battery fuse sits on a short link, within the 7 in limit
    const batFuse = d.nodes.find((n) => n.type === 'fuse' && d.wires.some((w) => w.from.node === 'n0' && w.to.node === n.id))!;
    expect(batFuse.data.rating).toBeGreaterThanOrEqual(10);
    expect(batFuse.data.fuseClass).toBe('MRBF');
  });

  it('a charging source with no fuse gets one at the battery end of its cable', () => {
    const d = draw(['battery', 'alternator'], { 0: { chemistry: 'agm' }, 1: { amps: 90 } });
    wire(d, 'pos', [1, 'b'], [0, 'pos'], 8);
    wire(d, 'neg', [1, 'neg'], [0, 'neg'], 8);
    const r = sizeDrawing(d);
    expect(r.counts.fusesAdded).toBe(1);
    expect(sizingErrors(d)).toEqual([]);
    const fuse = d.nodes.find((n) => n.type === 'fuse')!;
    expect(fuse.data.rating).toBe(125); // 90 A × 1.25 = 112.5 → next standard size
  });

  it('never makes a wire smaller or lowers a rating the owner entered', () => {
    const d = draw(['battery', 'fuse', 'load'], { 0: { chemistry: 'agm' }, 1: { rating: 30 }, 2: { amps: 5 } });
    wire(d, 'pos', [0, 'pos'], [1, 'in'], 0.4, { gauge: '4' });
    wire(d, 'pos', [1, 'out'], [2, 'pos'], 6, { gauge: '18' });
    wire(d, 'neg', [2, 'neg'], [0, 'neg'], 6, { gauge: '2' });
    sizeDrawing(d);
    expect(d.nodes[1].data.rating).toBe(30);
    expect(d.wires.map((w) => w.gauge)).toEqual(['4', '14', '2']); // 18 AWG is too small for the 30 A fuse; 14 AWG carries 35 A
    expect(sizingErrors(d)).toEqual([]);
  });

  it('raises a fuse that its circuit would blow', () => {
    const d = draw(['battery', 'fuse', 'load'], { 0: { chemistry: 'agm' }, 1: { rating: 10 }, 2: { amps: 25 } });
    wire(d, 'pos', [0, 'pos'], [1, 'in'], 0.4);
    wire(d, 'pos', [1, 'out'], [2, 'pos'], 6);
    wire(d, 'neg', [2, 'neg'], [0, 'neg'], 6);
    const r = sizeDrawing(d);
    expect(d.nodes[1].data.rating).toBe(35);
    expect(r.counts.raised).toBe(1);
  });

  it('says what it could not size instead of guessing', () => {
    // a fuse and a load straight from the palette, their rating and current cleared
    const d = draw(['battery', 'fuse', 'load'], { 0: { chemistry: 'agm' }, 1: { rating: undefined }, 2: { amps: undefined } });
    wire(d, 'pos', [0, 'pos'], [1, 'in'], 0.4);
    wire(d, 'pos', [1, 'out'], [2, 'pos'], 6);
    const r = sizeDrawing(d);
    expect(d.nodes[1].data.rating).toBeUndefined();
    expect(r.notes.join(' ')).toMatch(/current .* not known/);
  });

  it('in a focus, leaves everything outside it alone', () => {
    const p = exampleProject();
    const d = stripped(generateIdeal(p));
    const only = focusNodes(d, 'charging')!;
    sizeDrawing(d, { acVolts: acVoltsOf(p), only });
    const power = d.wires.filter((w) => w.kind === 'pos' || w.kind === 'neg' || w.kind === 'ac');
    const out = power.filter((w) => !only.has(w.from.node) || !only.has(w.to.node));
    expect(out.length).toBeGreaterThan(10);
    expect(out.filter((w) => w.gauge)).toEqual([]);
    const inside = power.filter((w) => only.has(w.from.node) && only.has(w.to.node));
    expect(inside.filter((w) => !w.gauge).map((w) => w.id)).toEqual([]);
  });

  describe('every sample boat, drawn bare, comes out passing the check', () => {
    for (const b of [...SAMPLE_BOATS, ...FINGERPRINT_BOATS]) {
      const ideal = generateIdeal(b.project, b.scenario);
      if (ideal.findings.some((f) => f.severity === 'error')) continue; // the generator itself says it cannot be built as asked
      it(b.name, () => {
        const d = stripped(ideal);
        const acVolts = acVoltsOf(b.project);
        sizeDrawing(d, { acVolts, units: b.project.profile.units });
        expect(audit(d, { acVolts }).filter((f) => f.severity === 'error' && SIZING_RULES.has(f.rule)).map((f) => `${f.rule}: ${f.message}`)).toEqual([]);
      });
    }
  });
});

describe('Focus', () => {
  const d = generateIdeal(exampleProject());
  const label = (set: Set<string> | undefined) => d.nodes.filter((n) => set?.has(n.id)).map((n) => n.label);

  it('Whole boat is no filter', () => {
    expect(focusNodes(d, 'all')).toBeUndefined();
  });

  it('Charging: the sources and what joins them to the batteries, not the loads on the same bus', () => {
    const c = label(focusNodes(d, 'charging'));
    for (const want of ['Alternator', 'Alternator output fuse', 'Automatic charging relay', 'House bank', 'Start battery', 'Solar arch (2 × 200 W)', 'PV disconnect', 'MPPT controller', 'MPPT output fuse', 'Main positive bus', 'Main negative bus', 'Inverter/charger']) expect(c).toContain(want);
    for (const not of ['Cabin lights (LED)', 'DC panel', 'Microwave', 'Shore power 30 A', 'Diesel engine (40 hp)']) expect(c).not.toContain(not);
  });

  it('Engine starting: the starter back to its battery', () => {
    const c = label(focusNodes(d, 'start'));
    expect(c).toEqual(expect.arrayContaining(['Diesel engine (40 hp)', 'Start battery', 'Start battery fuse', 'Start battery switch']));
    expect(c).not.toContain('Alternator');
    expect(c).not.toContain('Cabin lights (LED)');
  });

  it('DC loads: panels and loads back to the house bank, without the charging parts', () => {
    const c = label(focusNodes(d, 'loads'));
    expect(c).toEqual(expect.arrayContaining(['Cabin lights (LED)', 'DC panel', 'DC panel feeder fuse', 'House main fuse', 'House bank', 'Anchor windlass (1000 W)']));
    for (const not of ['Alternator', 'Automatic charging relay', 'MPPT controller', 'Shore power 30 A']) expect(c).not.toContain(not);
  });

  it('AC mains: every AC part, and the chargers and inverters on its edge', () => {
    const c = label(focusNodes(d, 'ac'));
    expect(c).toEqual(expect.arrayContaining(['Shore power 30 A', 'Shore main breaker + ELCI', 'Galvanic isolator', 'AC panel', 'Microwave', 'Inverter/charger']));
    expect(c).not.toContain('Cabin lights (LED)');
  });
});

describe('current estimates for a hand drawing (shared by the check and sizing)', () => {
  const panelWith = (d: Design, i: number, n: number, pol: 'ac' | 'pos') => {
    for (let k = 1; k <= n; k++) d.nodes[i].terminals.push({ id: `b${k}`, pol, side: 'E', rating: undefined });
  };

  it('an AC branch carries its own appliance, not the inverter/charger charge current', () => {
    // inverter/charger (2000 W, charges at 80 A) → AC panel → outlets 2.5 A
    const d = draw(['inverter-charger', 'ac-panel', 'ac-load'], { 0: { watts: 2000, amps: 80 }, 2: { amps: 2.5 } });
    d.nodes[1].terminals = d.nodes[1].terminals.filter((t) => t.id === 'in');
    panelWith(d, 1, 1, 'ac');
    d.nodes[1].terminals[1].rating = 15;
    wire(d, 'ac', [0, 'acout'], [1, 'in'], 10, { gauge: '10' });
    wire(d, 'ac', [1, 'b1'], [2, 'l'], 20, { gauge: '14' });
    const amps = estimateCurrents(d, 120);
    expect(amps.get(d.wires[1].id)).toBeCloseTo(2.5, 6);
    expect(amps.get(d.wires[0].id)).toBeCloseTo(2.5, 6);
    expect(sizingErrors(d)).toEqual([]);
  });

  it('a shore cable carries the inlet rating', () => {
    const d = draw(['shore-inlet', 'elci', 'ac-panel'], { 0: { amps: 30 } });
    wire(d, 'ac', [0, 'l'], [1, 'in'], 6);
    wire(d, 'ac', [1, 'out'], [2, 'in'], 10);
    expect(estimateCurrents(d, 120).get(d.wires[0].id)).toBe(30);
    sizeDrawing(d);
    expect(d.nodes[1].data.rating).toBe(30);
    expect(d.wires.map((w) => w.gauge)).toEqual(['10', '10']);
  });

  it('a charging relay carries charge current, not the loads on the other bank', () => {
    // house bank + 200 A of loads on one side, start battery + 150 A starter on the other
    const d = draw(['battery', 'acr', 'battery', 'load', 'engine'], { 0: { chemistry: 'agm' }, 1: { rating: 140 }, 2: { chemistry: 'agm' }, 3: { amps: 200 }, 4: { amps: 150 } });
    wire(d, 'pos', [0, 'pos'], [1, 'a'], 2);
    wire(d, 'pos', [1, 'b'], [2, 'pos'], 2);
    wire(d, 'pos', [0, 'pos'], [3, 'pos'], 5);
    wire(d, 'pos', [2, 'pos'], [4, 'pos'], 5);
    const amps = estimateCurrents(d);
    expect(amps.get(d.wires[0].id)).toBe(140);
    expect(amps.get(d.wires[1].id)).toBe(140);
  });

  it('wiring between solar panels and their controller is measured at the array voltage', () => {
    // 400 W at Vmp 36 V: 11.1 A. 25 ft of 12 AWG loses 2.8 % at 36 V, 8.4 % if worked out at 12 V.
    const d = draw(['solar-panel', 'mppt'], { 0: { watts: 400, amps: 400 / 36 } });
    wire(d, 'pos', [0, 'pos'], [1, 'pvpos'], 25, { gauge: '12', vdropLimit: 3 });
    wire(d, 'neg', [0, 'neg'], [1, 'pvneg'], 25, { gauge: '12', vdropLimit: 3 });
    expect(audit(d).filter((f) => f.rule === 'conductor-sizing')).toEqual([]);
  });

  it('a feed beyond the largest single cable is run as parallel cables', () => {
    // 4000 W inverter on 12 V: about 435 A, a 600 A Class T fuse
    const d = draw(['battery', 'fuse', 'inverter'], { 0: { chemistry: 'lifepo4' }, 1: { rating: undefined }, 2: { watts: 4000 } });
    wire(d, 'pos', [0, 'pos'], [1, 'in'], 0.5);
    wire(d, 'pos', [1, 'out'], [2, 'dcpos'], 6);
    wire(d, 'neg', [2, 'dcneg'], [0, 'neg'], 6);
    const r = sizeDrawing(d);
    expect(d.wires.every((w) => /^[23]× /.test(w.cable ?? ''))).toBe(true);
    expect(d.nodes[1].data.fuseClass).toBe('Class T');
    expect(sizingErrors(d)).toEqual([]);
    expect(r.notes).toEqual([]);
  });
});
