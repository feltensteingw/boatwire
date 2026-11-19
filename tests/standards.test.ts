import { describe, expect, it } from 'vitest';
import { audit } from '../src/engine/audit';
import { ampacity, sizeConductor } from '../src/engine/calc';
import { paletteNode } from '../src/engine/existing';
import { STANDARDS_NOTICE } from '../src/engine/rules';
import {
  AC_CABLE_AMPACITY,
  BATTERY_FUSE_MAX_IN,
  BATTERY_FUSE_SHEATHED_MAX_IN,
  ENGINE_SPACE_DERATE,
  GAUGES,
  SHEATHED_NOT_AT_BATTERY_FUSE_MAX_IN,
  STANDARDS_VERIFIED,
  VDROP,
} from '../src/model/standards';
import type { Design } from '../src/model/types';

// The wire tables checked against Blue Sea Systems' 2023 Catalog, p.164 ("ABYC Ampacity Rating
// Table at 30°C", 105 °C wire), read 2026-11-19. Outside and inside the engine space, as printed.
const BLUE_SEA_P164: Record<string, [outside: number, inside: number]> = {
  '18': [20, 17],
  '16': [25, 21],
  '14': [35, 30],
  '12': [45, 38],
  '10': [60, 51],
  '8': [80, 68],
  '6': [120, 102],
  '4': [160, 136],
  '2': [210, 179],
  '1': [245, 208],
  '1/0': [285, 242],
  '2/0': [330, 281],
  '3/0': [385, 327],
  '4/0': [445, 378],
};

describe('wire tables against Blue Sea Systems p.164', () => {
  it('outside the engine space, every size has the printed ampacity', () => {
    expect(GAUGES.map((g) => [g.awg, ampacity(g.awg)])).toEqual(GAUGES.map((g) => [g.awg, BLUE_SEA_P164[g.awg][0]]));
  });

  it('inside the engine space, every size has the printed ampacity', () => {
    expect(GAUGES.map((g) => [g.awg, ampacity(g.awg, true)])).toEqual(GAUGES.map((g) => [g.awg, BLUE_SEA_P164[g.awg][1]]));
  });

  it('engine-space DC wire is rated at 0.85 of its free-air ampacity, in whole amps as printed', () => {
    expect(ENGINE_SPACE_DERATE).toBe(0.85);
    expect(ampacity('10', true)).toBe(51);
    expect(ampacity('6', true)).toBe(102);
    expect(ampacity('14', true)).toBe(30); // 29.75
    expect(ampacity('2', true)).toBe(179); // 178.5
  });

  it('AC cable in the engine space keeps the 0.82 factor (Blue Sea publishes none for AC cable)', () => {
    expect(ampacity('10', true, true)).toBeCloseTo(AC_CABLE_AMPACITY['10'] * 0.82, 5);
    expect(ampacity('2', true, true)).toBeCloseTo(AC_CABLE_AMPACITY['2'] * 0.82, 5);
  });

  it('AC cable figures (not published by Blue Sea) are at or below its ratings for 7 to 24 bundled conductors', () => {
    for (const [awg, amps] of Object.entries(AC_CABLE_AMPACITY)) {
      expect(amps, awg).toBeLessThanOrEqual(ampacity(awg, false, false, 6));
      expect(amps, awg).toBeGreaterThan(ampacity(awg, false, false, 24));
    }
  });

  it('voltage-drop limits and battery fuse distances are the published ones', () => {
    expect(VDROP).toEqual({ critical: 3, nonCritical: 10 });
    expect([BATTERY_FUSE_MAX_IN, SHEATHED_NOT_AT_BATTERY_FUSE_MAX_IN, BATTERY_FUSE_SHEATHED_MAX_IN]).toEqual([7, 40, 72]);
  });
});

describe('engine-space wire on the stock sizes the factor moved past', () => {
  // 50 A, 100 A and 175 A are the stock fuse and breaker sizes between 0.82 and 0.85 of an ampacity.
  for (const [protect, gauge] of [[50, '10'], [100, '6'], [175, '2']] as const) {
    it(`a ${protect} A fuse needs ${gauge} AWG in the engine space`, () => {
      const r = sizeConductor({ designAmps: protect / 1.25, protectAmps: protect, oneWayFt: 1, volts: 24, vdropLimit: 10, inEngineSpace: true });
      expect(r).toMatchObject({ gauge, limitedBy: 'ampacity' });
    });
  }

  it('the design check accepts 6 AWG through the engine space on a 100 A fuse', () => {
    const d = engineCircuit(100, '6');
    expect(protection(d)).toEqual([]);
    d.wires[1].gauge = '8';
    expect(protection(d)).toEqual([expect.stringMatching(/protected by 100 A but 8 AWG is only rated 68 A/)]);
  });

  it('the design check accepts 14 AWG through the engine space on a 30 A fuse, as p.164 prints 30 A', () => {
    expect(protection(engineCircuit(30, '14'))).toEqual([]);
    expect(protection(engineCircuit(35, '14'))).toEqual(['Fuse → DC load: protected by 35 A but 14 AWG is only rated 30 A.']);
  });
});

/** Battery → fuse → wire through the engine space → a 20 A load, as drawn in Existing boat. */
function engineCircuit(fuseAmps: number, gauge: string): Design {
  const bat = paletteNode('battery', 'battery');
  const fuse = paletteNode('fuse', 'battery');
  fuse.data.rating = fuseAmps;
  fuse.data.fuseClass = 'MRBF';
  const load = paletteNode('load', 'engine');
  load.data.amps = 20;
  return {
    id: 'existing',
    name: 'Existing',
    systemVoltage: 12,
    nodes: [bat, fuse, load],
    findings: [],
    wires: [
      { id: 'w1', kind: 'pos', domain: 'dc', from: { node: bat.id, term: 'pos' }, to: { node: fuse.id, term: 'in' }, lengthFt: 0.5, gauge: '4/0' },
      { id: 'w2', kind: 'pos', domain: 'dc', from: { node: fuse.id, term: 'out' }, to: { node: load.id, term: 'pos' }, lengthFt: 3, gauge, inEngineSpace: true },
    ],
  };
}
const protection = (d: Design) => audit(d).filter((f) => f.rule === 'branch-protection' && f.wires?.includes('w2')).map((f) => f.message);

describe('safety notice', () => {
  it('stays on and names the source the numbers were checked against', () => {
    expect(STANDARDS_VERIFIED).toBe(false);
    expect(STANDARDS_NOTICE).toMatch(/Blue Sea Systems' published tables \(2023 catalog\)/);
    expect(STANDARDS_NOTICE).toMatch(/not the ABYC standard itself/);
    expect(STANDARDS_NOTICE).toMatch(/qualified marine electrician/);
  });
});
