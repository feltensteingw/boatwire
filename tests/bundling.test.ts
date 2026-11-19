import { describe, expect, it } from 'vitest';
import { audit } from '../src/engine/audit';
import { ampacity } from '../src/engine/calc';
import { paletteNode } from '../src/engine/existing';
import { generateIdeal } from '../src/engine/generate';
import { AMPACITY_105_BUNDLED, GAUGES } from '../src/model/standards';
import type { Design, Wire } from '../src/model/types';
import { parseProject } from '../src/model/validate';
import { exampleProject } from '../src/model/examples';
import { describeChange } from '../src/state/changes';
import { SAMPLE_BOATS } from './sampleBoats';

// Bundled conductors, from Blue Sea Systems' 2023 Catalog p.164, read 2026-11-19: E-11 Table VI-B
// ("up to three conductors in a sheath, conduit or bundle"), outside and inside the engine space.
const BLUE_SEA_VI_B: Record<string, [outside: number, inside: number]> = {
  '18': [14, 12],
  '16': [18, 15],
  '14': [25, 21],
  '12': [32, 27],
  '10': [42, 36],
  '8': [56, 48],
  '6': [84, 71],
  '4': [112, 95],
  '2': [147, 125],
  '1': [172, 146],
  '1/0': [200, 170],
  '2/0': [231, 196],
  '3/0': [270, 229],
  '4/0': [312, 265],
};

describe('ampacity of bundled DC conductors', () => {
  it('runs on its own: the single-conductor table', () => {
    for (const g of GAUGES) expect(ampacity(g.awg, false, false, 0), g.awg).toBe(g.ampacity105);
  });

  it('with one or two others: the up-to-three table, as printed', () => {
    for (const g of GAUGES) {
      expect(ampacity(g.awg, false, false, 1), g.awg).toBe(BLUE_SEA_VI_B[g.awg][0]);
      expect(ampacity(g.awg, false, false, 2), g.awg).toBe(BLUE_SEA_VI_B[g.awg][0]);
    }
  });

  it('in the engine space as well: within 0.5 A of the printed inside figure', () => {
    for (const g of GAUGES) expect(Math.abs(ampacity(g.awg, true, false, 2) - BLUE_SEA_VI_B[g.awg][1]), g.awg).toBeLessThanOrEqual(0.5);
  });

  it('larger bundles multiply the up-to-three figure by 0.857, 0.714 and 0.571', () => {
    const tiers: [others: number, factor: number][] = [
      [3, 0.857],
      [5, 0.857],
      [6, 0.714],
      [23, 0.714],
      [24, 0.571],
      [60, 0.571],
    ];
    for (const [others, factor] of tiers) expect(ampacity('10', false, false, others), `${others} others`).toBeCloseTo(42 * factor, 5);
    expect(ampacity('10', true, false, 3)).toBeCloseTo(42 * 0.857 * 0.85, 5);
  });

  it('every size is rated lower the bigger the bundle', () => {
    for (const g of GAUGES) {
      const r = [0, 1, 3, 6, 24].map((n) => ampacity(g.awg, false, false, n));
      expect(r, g.awg).toEqual([...r].sort((a, b) => b - a));
      expect(new Set(r).size, g.awg).toBe(5);
    }
  });

  it('every size in the bundled table is one of the gauges', () => {
    expect(Object.keys(AMPACITY_105_BUNDLED).sort()).toEqual(GAUGES.map((g) => g.awg).sort());
  });

  it('AC cable is not derated for bundling', () => {
    expect(ampacity('10', false, true, 5)).toBe(ampacity('10', false, true));
  });
});

/** Battery → 30 A fuse → 12 AWG wire → a 28 A load, as drawn in Existing boat. */
function circuit(o: Partial<Wire> = {}): Design {
  const bat = paletteNode('battery', 'battery');
  const fuse = paletteNode('fuse', 'battery');
  fuse.data.fuseClass = 'MRBF';
  const load = paletteNode('load', 'cabin');
  load.data.amps = 28;
  return {
    id: 'existing',
    name: 'Existing',
    systemVoltage: 12,
    nodes: [bat, fuse, load],
    findings: [],
    wires: [
      { id: 'w1', kind: 'pos', domain: 'dc', from: { node: bat.id, term: 'pos' }, to: { node: fuse.id, term: 'in' }, lengthFt: 0.5, gauge: '4/0' },
      { id: 'w2', kind: 'pos', domain: 'dc', from: { node: fuse.id, term: 'out' }, to: { node: load.id, term: 'pos' }, lengthFt: 1, gauge: '12', ...o },
    ],
  };
}
const about = (d: Design) =>
  audit(d)
    .filter((f) => f.wires?.includes('w2') && (f.rule === 'conductor-sizing' || f.rule === 'branch-protection'))
    .map((f) => `${f.message} → ${f.fix}`);

describe('the design check of a bundled wire', () => {
  it('a 12 AWG wire on its own is fine at 28 A on a 30 A fuse', () => {
    expect(about(circuit())).toEqual([]);
  });

  it('bundled with three others it is rated 27 A, and the finding says why and what to do', () => {
    expect(about(circuit({ bundledWith: 3 }))).toEqual([
      'Fuse → DC load: 12 AWG (bundled with 3 other wires) carries ~28 A, above its 27 A ampacity. → Use a larger conductor, or route it outside the bundle.',
      'Fuse → DC load: protected by 30 A but 12 AWG (bundled with 3 other wires) is only rated 27 A. → Use a smaller fuse/breaker or a larger wire, or route it outside the bundle.',
    ]);
  });

  it('bundled with one other it is rated 32 A, enough for its fuse', () => {
    expect(about(circuit({ bundledWith: 1 }))).toEqual([]);
  });
});

describe('the "Bundled with" field', () => {
  const withWire = (w: Record<string, unknown>) => {
    const p = exampleProject();
    const d = circuit();
    return { ...JSON.parse(JSON.stringify(p)), existing: { ...d, wires: [d.wires[0], { ...d.wires[1], ...w }] } };
  };
  const loaded = (w: Record<string, unknown>) => parseProject(withWire(w)).project.existing!.wires[1];

  it('is saved and opened again as a whole number', () => {
    expect(loaded({ bundledWith: 3 }).bundledWith).toBe(3);
    expect(loaded({ bundledWith: 2.7 }).bundledWith).toBe(2);
  });

  it('is left out when it is missing, zero, negative or not a number, so older files open unchanged', () => {
    for (const v of [undefined, 0, -2, '3', null, Infinity]) expect(loaded({ bundledWith: v }), String(v)).not.toHaveProperty('bundledWith');
  });

  it('is one undo step labelled "Edited a wire"', () => {
    const p = parseProject(withWire({})).project;
    const q = structuredClone(p);
    q.existing!.wires[1].bundledWith = 4;
    expect(describeChange(p, q)).toEqual({ label: 'Edited a wire', mergeKey: 'wire:w2' });
  });
});

describe('the ideal design assumes cables run on their own', () => {
  it('says so in one design note on every sample boat, and no wire is marked bundled', () => {
    for (const b of SAMPLE_BOATS) {
      const d = generateIdeal(b.project, b.scenario);
      if (d.wires.length === 0) continue;
      expect(d.findings.filter((f) => f.rule === 'bundling').map((f) => f.severity), b.name).toEqual(['info']);
      expect(d.wires.filter((w) => w.bundledWith !== undefined), b.name).toEqual([]);
    }
  });
});
