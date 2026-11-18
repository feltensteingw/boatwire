import { describe, expect, it } from 'vitest';
import { audit } from '../src/engine/audit';
import { paletteNode } from '../src/engine/existing';
import { generateIdeal } from '../src/engine/generate';
import { changeList } from '../src/engine/reports';
import { exampleProject } from '../src/model/examples';
import { FUSE_CLASSES, LITHIUM_FUSE_MIN_AIC, type FuseClass } from '../src/model/standards';
import type { Design } from '../src/model/types';

/** A battery with one fuse on its positive, as drawn in Existing boat. */
function bank(chemistry: string, fuseClass?: string): Design {
  const bat = paletteNode('battery', 'battery');
  bat.data.chemistry = chemistry;
  bat.data.ah = 400;
  const fuse = paletteNode('fuse', 'battery');
  fuse.data.rating = 300;
  if (fuseClass) fuse.data.fuseClass = fuseClass;
  return {
    id: 'existing',
    name: 'Existing',
    systemVoltage: 12,
    nodes: [bat, fuse],
    findings: [],
    wires: [{ id: 'w1', kind: 'pos', domain: 'dc', from: { node: bat.id, term: 'pos' }, to: { node: fuse.id, term: 'in' }, lengthFt: 0.5, gauge: '4/0' }],
  };
}
const classT = (d: Design) => audit(d).filter((f) => f.rule === 'class-t');

describe('fuse type on a lithium battery (hand-drawn boat)', () => {
  it('only Class T meets the interrupt rating', () => {
    const ok = (Object.keys(FUSE_CLASSES) as FuseClass[]).filter((c) => FUSE_CLASSES[c].aic >= LITHIUM_FUSE_MIN_AIC);
    expect(ok).toEqual(['Class T']);
  });

  it('flags ANL, MRBF, MIDI and blade fuses as errors', () => {
    for (const cls of ['ANL', 'MRBF', 'MIDI', 'ATC']) {
      const f = classT(bank('lifepo4', cls));
      expect(f.map((x) => x.severity), cls).toEqual(['error']);
      expect(f[0].message).toContain(`${cls} fuse`);
    }
    expect(classT(bank('lifepo4', 'ANL'))[0].message).toMatch(/is an ANL fuse, which can only interrupt about 6,000 A/);
  });

  it('accepts Class T', () => {
    expect(classT(bank('lifepo4', 'Class T'))).toHaveLength(0);
  });

  it('asks for the fuse type when it is not set', () => {
    const f = classT(bank('lifepo4'));
    expect(f.map((x) => x.severity)).toEqual(['warning']);
    expect(f[0].message).toMatch(/fuse type is not set/);
  });

  it('leaves lead-acid banks alone', () => {
    for (const chem of ['agm', 'flooded', 'gel']) {
      expect(classT(bank(chem, 'ANL')), chem).toHaveLength(0);
      expect(classT(bank(chem)), chem).toHaveLength(0);
    }
  });

  it('puts the wrong fuse in the upgrade plan as a safety item', () => {
    const p = exampleProject();
    const plan = changeList(bank('lifepo4', 'ANL'), generateIdeal(p, p.scenarios[0]), 120);
    expect(plan.some((c) => c.rule === 'class-t' && c.priority === 'safety')).toBe(true);
  });
});

describe('the ideal design meets its own fuse-type rule', () => {
  it('for every scenario of the example boat', () => {
    const p = exampleProject();
    for (const s of p.scenarios) expect(classT(generateIdeal(p, s)), s.name).toHaveLength(0);
  });

  it('with lithium house, start and dedicated banks', () => {
    const p = exampleProject();
    for (const e of p.equipment) if (e.kind === 'battery-bank') e.props.chemistry = 'lifepo4';
    const d = generateIdeal(p);
    const fusesOnBatteries = d.wires
      .filter((w) => w.kind === 'pos')
      .flatMap((w) => [[w.from.node, w.to.node], [w.to.node, w.from.node]])
      .filter(([a, b]) => d.nodes.find((n) => n.id === a)?.type === 'battery' && d.nodes.find((n) => n.id === b)?.type === 'fuse')
      .map(([, b]) => d.nodes.find((n) => n.id === b)!);
    expect(fusesOnBatteries.length).toBeGreaterThanOrEqual(2);
    for (const f of fusesOnBatteries) expect(f.data.fuseClass, f.label).toBe('Class T');
    expect(classT(d)).toHaveLength(0);
  });
});
