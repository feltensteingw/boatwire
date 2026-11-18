import { describe, expect, it } from 'vitest';
import { audit } from '../src/engine/audit';
import { isUnsized } from '../src/engine/calc';
import { paletteNode } from '../src/engine/existing';
import { generateIdeal } from '../src/engine/generate';
import { changeList } from '../src/engine/reports';
import { exampleProject } from '../src/model/examples';
import type { Design, Wire } from '../src/model/types';

/** battery → fuse → 20 A load and back, as a user would draw it: no sizes yet. */
function drawn(gauge?: string): Design {
  const bat = paletteNode('battery', 'battery');
  const fuse = paletteNode('fuse', 'battery');
  const load = paletteNode('load', 'saloon');
  load.data.amps = 20;
  const wire = (id: string, kind: Wire['kind'], a: [string, string], b: [string, string], lengthFt: number): Wire => ({ id, kind, domain: 'dc', from: { node: a[0], term: a[1] }, to: { node: b[0], term: b[1] }, lengthFt, gauge });
  return {
    id: 'existing',
    name: 'Existing',
    systemVoltage: 12,
    nodes: [bat, fuse, load],
    findings: [],
    wires: [wire('w1', 'pos', [bat.id, 'pos'], [fuse.id, 'in'], 0.5), wire('w2', 'pos', [fuse.id, 'out'], [load.id, 'pos'], 20), wire('w3', 'neg', [load.id, 'neg'], [bat.id, 'neg'], 20)],
  };
}

describe('wires with no size set', () => {
  it('counts power wires only', () => {
    expect(isUnsized({ kind: 'pos' })).toBe(true);
    expect(isUnsized({ kind: 'neg' })).toBe(true);
    expect(isUnsized({ kind: 'ac' })).toBe(true);
    expect(isUnsized({ kind: 'sig' })).toBe(false);
    expect(isUnsized({ kind: 'gnd' })).toBe(false);
    expect(isUnsized({ kind: 'pos', gauge: '10' })).toBe(false);
  });

  it('a drawing with unsized wires is reported as not fully checked', () => {
    const f = audit(drawn()).filter((x) => x.rule === 'unsized-wire');
    expect(f).toHaveLength(1);
    expect(f[0].severity).toBe('warning');
    expect(f[0].message).toMatch(/^3 wires have no size set/);
    expect(f[0].wires).toEqual(['w1', 'w2', 'w3']);
  });

  it('uses the singular for one wire', () => {
    const d = drawn('10');
    delete d.wires[1].gauge;
    expect(audit(d).find((x) => x.rule === 'unsized-wire')!.message).toMatch(/^1 wire has no size set, so it is not checked/);
  });

  it('goes away once every wire has a size, and the real checks then run', () => {
    // 16 AWG is far too small for 20 A over 20 ft behind a 30 A fuse
    const f = audit(drawn('16'));
    expect(f.some((x) => x.rule === 'unsized-wire')).toBe(false);
    expect(f.some((x) => x.rule === 'branch-protection' || x.rule === 'conductor-sizing')).toBe(true);
  });

  it('never fires on a generated design', () => {
    const p = exampleProject();
    for (const s of p.scenarios) expect(audit(generateIdeal(p, s)).some((x) => x.rule === 'unsized-wire')).toBe(false);
  });

  it('shows up in the upgrade plan', () => {
    const p = exampleProject();
    const plan = changeList(drawn(), generateIdeal(p, p.scenarios[0]), 120);
    expect(plan.some((c) => c.rule === 'unsized-wire' && c.priority === 'recommended')).toBe(true);
  });
});
