import { describe, expect, it } from 'vitest';
import { audit } from '../src/engine/audit';
import { BATTERY_FUSE_DRAFT_FT, draftRunLength, paletteNode } from '../src/engine/existing';
import { exampleProject } from '../src/model/examples';
import { BATTERY_FUSE_MAX_IN } from '../src/model/standards';
import type { Design, DNode, Wire } from '../src/model/types';

const profile = exampleProject().profile;
const BZ = profile.batteryZone;

function drawing(lengthFt: number, estimated: boolean, fuseZone = BZ): { d: Design; bat: DNode; fuse: DNode } {
  const bat = paletteNode('battery', BZ);
  const fuse = paletteNode('fuse', fuseZone);
  const w: Wire = { id: 'w1', kind: 'pos', domain: 'dc', from: { node: bat.id, term: 'pos' }, to: { node: fuse.id, term: 'in' }, lengthFt, lengthEstimated: estimated || undefined };
  return { d: { id: 'existing', name: 'Existing', systemVoltage: 12, nodes: [bat, fuse], wires: [w], findings: [] }, bat, fuse };
}
const fuseFindings = (d: Design) => audit(d).filter((f) => f.rule === 'battery-fuse');

describe('starting length of a hand-drawn wire', () => {
  it('battery positive to a fuse in the same location starts inside the battery-fuse limit', () => {
    const bat = paletteNode('battery', BZ);
    const fuse = paletteNode('fuse', BZ);
    expect(BATTERY_FUSE_DRAFT_FT * 12).toBeLessThanOrEqual(BATTERY_FUSE_MAX_IN);
    expect(draftRunLength(profile, bat, 'pos', fuse, 'in')).toBe(BATTERY_FUSE_DRAFT_FT);
    // drawn the other way round
    expect(draftRunLength(profile, fuse, 'in', bat, 'pos')).toBe(BATTERY_FUSE_DRAFT_FT);
  });

  it('everything else keeps the location-based estimate', () => {
    const bat = paletteNode('battery', BZ);
    const fuse = paletteNode('fuse', BZ);
    const load = paletteNode('load', BZ);
    const far = paletteNode('fuse', profile.zones.find((z) => z.id !== BZ)!.id);
    expect(draftRunLength(profile, bat, 'neg', fuse, 'in')).toBe(3);
    expect(draftRunLength(profile, fuse, 'out', load, 'pos')).toBe(3);
    expect(draftRunLength(profile, bat, 'pos', far, 'in')).toBeGreaterThan(3);
  });
});

describe('battery-fuse distance check on a hand-drawn boat', () => {
  it('a freshly drawn battery fuse is not warned about, but the user is asked for the length', () => {
    const f = fuseFindings(drawing(BATTERY_FUSE_DRAFT_FT, true).d);
    expect(f).toHaveLength(1);
    expect(f[0].severity).toBe('info');
    expect(f[0].message).toMatch(/has not been entered/);
  });

  it('once a short length is entered there is nothing to report', () => {
    expect(fuseFindings(drawing(0.5, false).d)).toHaveLength(0);
  });

  it('a measured long run is still flagged', () => {
    const warn = fuseFindings(drawing(3, false).d);
    expect(warn.map((f) => f.severity)).toEqual(['warning']);
    expect(warn[0].message).toMatch(/fuse is 36 in from the battery —/);
    expect(fuseFindings(drawing(10, false).d).map((f) => f.severity)).toEqual(['error']);
  });

  it('a fuse placed in another location is flagged from the estimate, and says it is an estimate', () => {
    const far = profile.zones.find((z) => z.id !== BZ)!.id;
    const bat = paletteNode('battery', BZ);
    const fuse = paletteNode('fuse', far);
    const est = draftRunLength(profile, bat, 'pos', fuse, 'in');
    const f = fuseFindings(drawing(est, true, far).d);
    expect(f).toHaveLength(1);
    expect(f[0].severity).not.toBe('info');
    expect(f[0].message).toMatch(/about \d+ in from the battery \(estimated/);
  });
});
