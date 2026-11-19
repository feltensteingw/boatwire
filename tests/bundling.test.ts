import { describe, expect, it } from 'vitest';
import { audit } from '../src/engine/audit';
import { ampacity } from '../src/engine/calc';
import { paletteNode } from '../src/engine/existing';
import { generateIdeal } from '../src/engine/generate';
import { changeList } from '../src/engine/reports';
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

  it('in the engine space as well: the printed inside figure, except 3/0 at 1 A more', () => {
    for (const g of GAUGES) {
      // 270 × 0.85 = 229.5 rounds to 230; Blue Sea prints 229. No stock fuse or breaker lies between.
      const printed = g.awg === '3/0' ? 230 : BLUE_SEA_VI_B[g.awg][1];
      expect(ampacity(g.awg, true, false, 2), g.awg).toBe(printed);
    }
  });

  it('larger bundles multiply the up-to-three figure by 0.857, 0.714 and 0.571, in whole amps', () => {
    const tiers: [others: number, amps: number][] = [
      [3, 36], // 42 × 0.857 = 35.99
      [5, 36],
      [6, 30], // 42 × 0.714 = 29.99
      [23, 30],
      [24, 24], // 42 × 0.571 = 23.98
      [60, 24],
    ];
    for (const [others, amps] of tiers) expect(ampacity('10', false, false, others), `${others} others`).toBe(amps);
    expect(ampacity('10', true, false, 3)).toBe(31); // 42 × 0.857 × 0.85 = 30.6
  });

  it('every DC rating is in whole amps, so a finding never says a wire is rated the same as the fuse it rejects', () => {
    for (const g of GAUGES)
      for (const engine of [false, true])
        for (let others = 0; others <= 30; others++) expect(Number.isInteger(ampacity(g.awg, engine, false, others)), `${g.awg} ${engine} ${others}`).toBe(true);
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

  // Blue Sea's 7-to-24 multiplier, 0.714, on the up-to-three figure comes to a hair under the
  // stock fuse sizes these wires usually carry. In whole amps, as printed, they fit.
  for (const [gauge, fuse] of [['18', 10], ['10', 30], ['8', 40], ['6', 60], ['4', 80]] as const) {
    it(`${gauge} AWG bundled with 6 others is rated ${fuse} A and passes on a ${fuse} A fuse`, () => {
      const d = circuit({ gauge, bundledWith: 6 });
      d.nodes[1].data.rating = fuse;
      d.nodes[2].data.amps = fuse / 2;
      expect(about(d)).toEqual([]);
      d.nodes[1].data.rating = fuse + 5;
      expect(about(d)).toEqual([expect.stringContaining(`is only rated ${fuse} A.`)]);
    });
  }

  it('2 AWG bundled with one other in the engine space is rated 125 A, as printed, and passes on a 125 A fuse', () => {
    const d = circuit({ gauge: '2', bundledWith: 1, inEngineSpace: true });
    d.nodes[1].data.rating = 125;
    d.nodes[2].data.amps = 90;
    expect(about(d)).toEqual([]);
  });
});

describe('the upgrade plan for a bundled wire', () => {
  /** The ideal: 12 AWG on its own. The existing drawing: the same circuit with `o` on its wire. */
  const plan = (o: Partial<Wire>, fuse = 30) => {
    const ideal = circuit();
    const existing = circuit(o);
    for (const d of [ideal, existing]) {
      d.nodes[1].data.rating = fuse;
      d.nodes[2].equipmentId = 'pump';
    }
    if (fuse > 30) ideal.wires[1].gauge = '4/0';
    const lines = changeList(existing, ideal, 120).filter((c) => c.title.includes('upsize'));
    return { existing, lines: lines.map((c) => [c.title, c.detail, c.parts]) };
  };

  it('a wire on its own is upsized to the ideal size, as before', () => {
    expect(plan({ gauge: '14' }).lines).toEqual([['DC load: upsize wire 14 AWG → 12 AWG', 'At ~28 A over 1 ft.', [['cable:12', 2]]]]);
  });

  it('a bundled wire is upsized to the size its bundle needs, and the check then passes', () => {
    // 12 AWG with three others is rated 27 A, below the 30 A fuse; 10 AWG is rated 36 A.
    const { existing, lines } = plan({ gauge: '14', bundledWith: 3 });
    expect(lines).toEqual([['DC load: upsize wire 14 AWG → 10 AWG', 'At ~28 A over 1 ft, bundled with 3 other wires.', [['cable:10', 2]]]]);
    existing.wires[1].gauge = '10';
    expect(about(existing)).toEqual([]);
  });

  it('a bundled wire already at the ideal size is upsized when its bundle needs more', () => {
    expect(plan({ bundledWith: 3 }).lines.map((l) => l[0])).toEqual(['DC load: upsize wire 12 AWG → 10 AWG']);
    expect(plan({ bundledWith: 1 }).lines).toEqual([]);
  });

  it('no upsize line when no size is enough in that bundle; the check says what to do', () => {
    // 4/0 with 30 others is rated 178 A, below a 300 A fuse.
    const { existing, lines } = plan({ gauge: '2/0', bundledWith: 30 }, 300);
    expect(lines).toEqual([]);
    expect(about(existing)).toEqual([expect.stringContaining('protected by 300 A but 2/0 AWG (bundled with 30 other wires) is only rated 132 A')]);
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
