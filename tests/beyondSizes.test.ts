import { describe, expect, it } from 'vitest';
import { audit } from '../src/engine/audit';
import { nextStandard, protectionFor } from '../src/engine/calc';
import { generateIdeal } from '../src/engine/generate';
import { Builder } from '../src/engine/ideal/builder';
import { exampleProject, newEquipment } from '../src/model/examples';
import type { Design, EquipmentKind, Project, PropValue, Scenario } from '../src/model/types';

// Fuses, breakers, switches and controllers are picked from lists of standard sizes. When a current
// is above the largest in a list, the generator still draws the largest (so the diagram is whole)
// and says so, instead of quietly drawing a part that is too small.

const V24: Scenario = { id: 'v24', name: '24 V', systemVoltage: 24 };
const beyond = (d: Design) => d.findings.filter((f) => f.rule === 'beyond-sizes');
const about = (d: Design, what: string) => beyond(d).filter((f) => f.message.startsWith(what));
const rating = (d: Design, id: string) => d.nodes.find((n) => n.id === id)?.data.rating;
const the = (p: Project, kind: EquipmentKind) => p.equipment.find((e) => e.kind === kind)!;
const boat = (change: (p: Project) => void) => {
  const p = exampleProject();
  change(p);
  return p;
};
const add = (p: Project, kind: EquipmentKind, props: Record<string, PropValue> = {}, name?: string) => {
  const e = newEquipment(kind, { name, props });
  p.equipment.push(e);
  return e;
};

describe('picking a standard size', () => {
  it('nextStandard says when nothing in the list is big enough', () => {
    expect(nextStandard(0.5, [1, 2, 3])).toBe(1);
    expect(nextStandard(800, [100, 800])).toBe(800);
    expect(nextStandard(801, [100, 800])).toBeUndefined();
  });

  it('protectionFor adds the margin and says when no device is big enough', () => {
    expect(protectionFor(480)).toBe(600);
    expect(protectionFor(481)).toBeUndefined();
    expect(protectionFor(40, 'breaker-ac')).toBe(50);
    expect(protectionFor(41, 'breaker-ac')).toBeUndefined();
    expect(protectionFor(120, 'breaker-dc')).toBe(150);
    expect(protectionFor(121, 'breaker-dc')).toBeUndefined();
  });

  it('the builder draws the largest size and reports it: an error below the current, a warning when only the margin is short', () => {
    const b = new Builder(12, 120, true);
    expect(b.rating(150, [100, 200], { what: 'Fits' })).toBe(200);
    expect(b.findings).toEqual([]);

    expect(b.rating(1000, [100, 800], { what: 'Too small', carries: 900, nodes: ['x'] })).toBe(800);
    expect(b.rating(1000, [100, 800], { what: 'Short margin', carries: 700 })).toBe(800);
    expect(b.rating(1000, [100, 800], { what: 'Limits itself', carries: 900, limitsItself: true })).toBe(800);
    expect(b.findings.map((f) => [f.severity, f.message])).toEqual([
      ['error', 'Too small carries about 900 A, but the largest BoatWire can choose is 800 A. The 800 A shown is too small for that current.'],
      ['warning', 'Short margin should be at least 1000 A for about 700 A, but the largest BoatWire can choose is 800 A. The 800 A shown leaves too little margin.'],
      ['warning', 'Limits itself would need to handle about 900 A, but the largest BoatWire can choose is 800 A. The 800 A shown limits its own output, so it cannot deliver all of it.'],
    ]);
    expect(b.findings[0].nodes).toEqual(['x']);
    expect(b.findings.every((f) => f.rule === 'beyond-sizes' && f.fix?.startsWith('Use 24 V'))).toBe(true);
    // a 24 V boat is not told to use 24 V
    const b24 = new Builder(24, 120, true);
    b24.protection(1000, { what: 'Fuse' });
    expect(b24.findings[0].fix).toBe('Split the load across two circuits, or use a larger dedicated circuit.');
  });
});

describe('every part of the generator reports a current beyond its largest size', () => {
  it('house bank: the main fuse error', () => {
    const p = boat((q) => void (the(q, 'inverter-charger').props.watts = 8000));
    const d = generateIdeal(p);
    expect(about(d, 'Main DC current')).toEqual([
      expect.objectContaining({ severity: 'error', message: 'Main DC current (~915 A) is beyond practical fuse and switch sizes.', nodes: ['house0-fuse'] }),
    ]);
    expect(rating(d, 'house0-fuse')).toBe(800);
    // at 24 V the same boat fits the lists
    expect(beyond(generateIdeal(p, V24))).toEqual([]);
  });

  it('heavy loads: a thruster fuse and contactor, on the house bank or its own bank', () => {
    const p = boat((q) => void add(q, 'bow-thruster', { watts: 8000 }, 'Bow thruster'));
    const d = generateIdeal(p);
    expect(about(d, 'Bow thruster').map((f) => [f.severity, f.message.split(',')[0]])).toEqual([
      ['error', 'Bow thruster fuse carries about 667 A'],
      ['error', 'Bow thruster contactor carries about 667 A'],
    ]);
    expect(about(d, 'Bow thruster')[0].fix).toBe('Use 24 V, which halves the current, or choose a smaller model.');

    // 583 A: the 600 A fuse is above the current, but without its 25% margin
    const q = boat((r) => void add(r, 'bow-thruster', { watts: 7000 }, 'Bow thruster'));
    expect(about(generateIdeal(q), 'Bow thruster').map((f) => [f.severity, f.message.split(',')[0]])).toEqual([['warning', 'Bow thruster fuse should be at least 730 A for about 583 A']]);

    add(p, 'battery-bank', { role: 'thruster', chemistry: 'agm', unitVolts: 12, unitAh: 100, units: 4 }, 'Thruster battery');
    const ded = generateIdeal(p);
    expect(about(ded, 'Thruster battery').map((f) => [f.severity, f.message.split(',')[0]])).toEqual([['error', 'Thruster battery fuse carries about 667 A']]);
    // the bank's switch is sized for the current, which the 800 A switch carries
    expect(rating(ded, 'th-switch')).toBe(800);
  });

  it('distribution: a DC panel main breaker, and a 24→12 V converter', () => {
    const p = boat((q) => {
      for (let i = 1; i <= 8; i++) add(q, 'water-pump', { watts: 300 }, `Pump ${i}`);
    });
    const d = generateIdeal(p);
    expect(about(d, 'DC panel main breaker')).toEqual([
      expect.objectContaining({
        severity: 'error',
        message: 'DC panel main breaker carries about 163 A, but the largest BoatWire can choose is 150 A. The 150 A shown is too small for that current.',
        fix: 'Split the loads between two panels, each with its own feeder and main breaker, or use 24 V, which halves the current.',
        nodes: ['dc-panel'],
      }),
    ]);
    expect(rating(d, 'dc-panel')).toBe(150);

    const q = boat((r) => {
      for (let i = 1; i <= 3; i++) add(r, 'fridge', { watts: 360, v24ok: false }, `12 V fridge ${i}`);
    });
    const d24 = generateIdeal(q, V24);
    // a converter limits its own output, so it is a warning, not an error
    expect(about(d24, '24→12 V converter').map((f) => [f.severity, f.message.split(',')[0]])).toEqual([['warning', '24→12 V converter would need to handle about 102 A']]);
    expect(rating(d24, 'conv-24-12')).toBe(70);
  });

  it('engine: the start fuse, a battery isolator and the alternator fuse', () => {
    // 200 A is a typical starter: the 300 A fuse is enough for the current but not twice it
    const typical = generateIdeal(boat((p) => void (the(p, 'engine').props.starterAmps = 200)));
    expect(about(typical, 'Start battery fuse')).toEqual([
      expect.objectContaining({
        severity: 'warning',
        message: 'Start battery fuse should be at least 400 A for about 200 A, but the largest BoatWire can choose is 300 A. The 300 A shown leaves too little margin.',
        fix: 'Fit a larger start fuse (Class T or ANL, about 400 A) or the size the engine maker recommends, and check the starter current entered.',
      }),
    ]);
    const big = generateIdeal(boat((p) => void (the(p, 'engine').props.starterAmps = 400)));
    expect(about(big, 'Start battery fuse').map((f) => f.severity)).toEqual(['error']);
    expect(beyond(generateIdeal(exampleProject()))).toEqual([]);

    const iso = generateIdeal(boat((p) => void Object.assign(the(p, 'engine').props, { alternatorAmps: 400, chargeSplit: 'isolator-fet' })));
    expect(about(iso, 'FET battery isolator').map((f) => [f.severity, f.message.split(',')[0]])).toEqual([['error', 'FET battery isolator carries about 400 A']]);
    expect(rating(iso, 'alt-isolator')).toBe(350);

    const alt = generateIdeal(boat((p) => void (the(p, 'engine').props.alternatorAmps = 700)));
    expect(about(alt, 'Alternator output fuse').map((f) => [f.severity, f.message.split(',')[0]])).toEqual([['error', 'Alternator output fuse carries about 700 A']]);
  });

  it('renewables: an MPPT controller and the PV disconnect', () => {
    const p = boat((q) => void (the(q, 'solar').props.watts = 1500));
    const d = generateIdeal(p);
    const solar = the(p, 'solar');
    expect(beyond(d).map((f) => [f.severity, f.message.split(',')[0], f.nodes])).toEqual([
      // a controller limits its own output: too small a one wastes sun but is not overloaded
      ['warning', `MPPT controller for ${solar.name} would need to handle about 106 A`, [`mppt-${solar.id}`]],
      ['warning', `PV disconnect for ${solar.name} should be at least 72 A for about 46 A`, [`pvbrk-${solar.id}`]],
    ]);
    // nothing else in that design is wrong: warnings only, and the check agrees
    expect(audit(d).filter((f) => f.severity === 'error')).toEqual([]);
    // at 24 V one controller is enough
    expect(beyond(generateIdeal(p, V24)).map((f) => f.message.split(' for ')[0])).toEqual(['PV disconnect']);

    const huge = generateIdeal(boat((q) => void (the(q, 'solar').props.watts = 3000)));
    expect(about(huge, 'PV disconnect').map((f) => [f.severity, f.message.split(',')[0]])).toEqual([['error', `PV disconnect for ${solar.name} carries about 92 A`]]);
  });

  it('AC: the inverter DC fuse, a generator breaker, an appliance breaker and an inverter-only panel main', () => {
    const inv = generateIdeal(boat((p) => void (the(p, 'inverter-charger').props.watts = 8000)));
    expect(about(inv, 'Inverter/charger DC fuse')).toEqual([
      expect.objectContaining({ severity: 'error', fix: 'Use 24 V, which halves the current, or a smaller inverter.', nodes: ['ic-fuse'] }),
    ]);
    expect(about(inv, 'Inverter/charger DC fuse')[0].message.split(',')[0]).toBe('Inverter/charger DC fuse carries about 847 A');

    const p = boat((q) => {
      add(q, 'generator', { watts: 8000 }, 'Generator');
      add(q, 'air-conditioner', { watts: 7000 }, 'Air conditioner');
    });
    expect(beyond(generateIdeal(p)).map((f) => [f.severity, f.message.split(',')[0]])).toEqual([
      ['error', 'Generator main breaker carries about 67 A'],
      ['error', 'Air conditioner breaker carries about 58 A'],
    ]);
    // the same equipment on 230 V draws less than half the current
    p.profile.acStandard = 'eu230';
    expect(beyond(generateIdeal(p))).toEqual([]);

    const invOnly = boat((q) => {
      q.equipment = q.equipment.filter((e) => e.kind !== 'shore-power' && e.kind !== 'inverter-charger');
      add(q, 'inverter', { watts: 8000 }, 'Inverter');
    });
    expect(about(generateIdeal(invOnly, V24), 'AC panel main breaker').map((f) => [f.severity, f.message.split(',')[0], f.nodes])).toEqual([['error', 'AC panel main breaker carries about 67 A', ['ac-panel']]]);
  });
});
