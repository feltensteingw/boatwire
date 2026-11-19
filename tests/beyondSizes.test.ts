import { describe, expect, it } from 'vitest';
import { audit } from '../src/engine/audit';
import { ampacity, nextStandard, protectionFor } from '../src/engine/calc';
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
    // a fuse on a main feeder or at a battery is a Class T above 300 A, so it goes on to 800 A like the main fuse
    expect(protectionFor(481, 'feeder-fuse')).toBe(800);
    expect(protectionFor(640, 'feeder-fuse')).toBe(800);
    expect(protectionFor(641, 'feeder-fuse')).toBeUndefined();
  });

  it('the builder draws the largest size and reports it: an error below the current, a warning when only the margin is short', () => {
    const b = new Builder(12, 120, true);
    expect(b.rating(150, [100, 200], { what: 'Fits' })).toBe(200);
    expect(b.findings).toEqual([]);

    expect(b.rating(1000, [100, 800], { what: 'Too small', carries: 900, nodes: ['x'] })).toBe(800);
    expect(b.rating(1000, [100, 800], { what: 'Short margin', carries: 700 })).toBe(800);
    expect(b.rating(1000, [100, 800], { what: 'Limits itself', carries: 900, limitsItself: true })).toBe(800);
    expect(b.findings.map((f) => [f.severity, f.message])).toEqual([
      ['error', 'Too small carries about 900 A, but the largest BoatWire can choose for it is 800 A. The 800 A shown is too small for that current.'],
      ['warning', 'Short margin should be at least 1000 A for about 700 A, but the largest BoatWire can choose for it is 800 A. The 800 A shown leaves too little margin.'],
      ['warning', 'Limits itself would need to handle about 900 A, but the largest BoatWire can choose for it is 800 A. The 800 A shown limits its own output, so it cannot deliver all of it.'],
    ]);
    expect(b.findings[0].nodes).toEqual(['x']);
    expect(b.findings.every((f) => f.rule === 'beyond-sizes' && f.fix?.startsWith('Use 24 V'))).toBe(true);
    // a 24 V boat is not told to use 24 V
    const b24 = new Builder(24, 120, true);
    b24.protection(1000, { what: 'Fuse' });
    expect(b24.findings[0].fix).toBe('Split the load across two circuits, or use a larger dedicated circuit.');
  });

  it('parallel cables are counted from the current when no fuse is big enough for it', () => {
    const b = new Builder(12, 120, true);
    const bat = b.add('battery', 'bat', 'Battery');
    const fuse = b.add('fuse', 'fuse', 'Fuse');
    // 915 A through an 800 A fuse: two 4/0 (890 A) would carry less than the current
    expect(b.wire('pos', [bat, 'pos'], [fuse, 'in'], { amps: 915, protect: 800, len: 0.5 }).cable).toBe('3× 4/0');
    // the usual case, a fuse above the current, is unchanged
    expect(b.wire('pos', [bat, 'pos'], [fuse, 'in'], { amps: 480, protect: 600, len: 0.5 }).cable).toBe('2× 4/0');
    // in the engine space a 4/0 is good for less, as the design check counts it
    expect(b.wire('pos', [bat, 'pos'], [fuse, 'in'], { amps: 700, protect: 800, len: 0.5, engine: true }).cable).toBe('3× 4/0');
    // a current that is not a number (a solar Vmp of 0 upstream) counts only through its fuse
    expect(b.wire('pos', [bat, 'pos'], [fuse, 'in'], { amps: Infinity, protect: 63, len: 25.8 }).cable).toBe('2× 4/0');
  });

  it('a single cable is sized for the current when no breaker is big enough for it', () => {
    const b = new Builder(12, 120, true);
    const gen = b.add('generator', 'gen', 'Generator');
    const brk = b.add('elci', 'brk', 'Generator main breaker');
    // 100 A through a 50 A breaker: the cable is chosen for the 100 A
    const w = b.wire('ac', [gen, 'l'], [brk, 'in'], { amps: 100, protect: 50, len: 2 });
    expect(ampacity(w.gauge!, false, true)).toBeGreaterThanOrEqual(100);
    expect(ampacity(b.wire('ac', [gen, 'l'], [brk, 'in'], { amps: 49, protect: 50, len: 2 }).gauge!, false, true)).toBeLessThan(100);
    // the usual case, a breaker above the current, is unchanged: the breaker sets the size
    expect(b.wire('ac', [gen, 'l'], [brk, 'in'], { amps: 20, protect: 30, len: 2 }).gauge).toBe(b.wire('ac', [gen, 'l'], [brk, 'in'], { amps: 30, protect: 30, len: 2 }).gauge);
  });
});

describe('every part of the generator reports a current beyond its largest size', () => {
  it('house bank: the main fuse error, and main cables sized for the real current', () => {
    const p = boat((q) => void (the(q, 'inverter-charger').props.watts = 8000));
    const d = generateIdeal(p);
    expect(about(d, 'Main DC current')).toEqual([
      expect.objectContaining({ severity: 'error', message: 'Main DC current (~915 A) is beyond practical fuse and switch sizes.', nodes: ['house0-fuse'] }),
    ]);
    expect(rating(d, 'house0-fuse')).toBe(800);
    const mainCable = d.wires.find((w) => w.from.node === 'house0-bat' && w.to.node === 'house0-fuse')!;
    expect(mainCable.amps).toBe(915.4);
    expect(mainCable.cable).toBe('3× 4/0');
    // every cable the generator draws carries its current (the inverter's AC output too), so the
    // check agrees: the errors are the generator's own
    expect(audit(d).filter((f) => f.severity === 'error')).toEqual([]);
    // at 24 V the same boat fits the lists
    expect(beyond(generateIdeal(p, V24))).toEqual([]);
  });

  it('heavy loads: a thruster fuse and contactor, on the house bank or its own bank', () => {
    const p = boat((q) => void add(q, 'bow-thruster', { watts: 8000 }, 'Bow thruster'));
    const d = generateIdeal(p);
    // 667 A: the 800 A Class T fuse is above the current, but without its 25% margin; the contactor is below it
    expect(about(d, 'Bow thruster').map((f) => [f.severity, f.message.split(',')[0]])).toEqual([
      ['warning', 'Bow thruster fuse should be at least 834 A for about 667 A'],
      ['error', 'Bow thruster contactor carries about 667 A'],
    ]);
    expect(about(d, 'Bow thruster')[0].fix).toBe('Use 24 V, which halves the current, or choose a smaller model.');

    // 583 A: an 800 A Class T, the same family and top size as the main fuse, so nothing to report
    const q = exampleProject();
    const thruster = add(q, 'bow-thruster', { watts: 7000 }, 'Bow thruster');
    const seven = generateIdeal(q);
    expect(about(seven, 'Bow thruster')).toEqual([]);
    expect(seven.nodes.find((n) => n.id === `prot-${thruster.id}`)?.sublabel).toBe('800 A Class T');

    add(p, 'battery-bank', { role: 'thruster', chemistry: 'agm', unitVolts: 12, unitAh: 100, units: 4 }, 'Thruster battery');
    const ded = generateIdeal(p);
    expect(about(ded, 'Thruster battery').map((f) => [f.severity, f.message.split(',')[0]])).toEqual([['warning', 'Thruster battery fuse should be at least 834 A for about 667 A']]);
    expect(rating(ded, 'th-fuse')).toBe(800);
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
        message: 'DC panel main breaker carries about 163 A, but the largest BoatWire can choose for it is 150 A. The 150 A shown is too small for that current.',
        fix: 'Split the loads between two panels, each with its own feeder and main breaker, or use 24 V, which halves the current.',
        nodes: ['dc-panel'],
      }),
    ]);
    expect(rating(d, 'dc-panel')).toBe(150);
    // its feeder is sized for the 163 A, not the 150 A breaker, so the check finds nothing else
    const feeder = d.wires.find((w) => w.from.node === 'dc-panel-feed' && w.to.node === 'dc-panel')!;
    expect(feeder.amps).toBe(162.6);
    expect(ampacity(feeder.gauge!)).toBeGreaterThanOrEqual(163);
    expect(audit(d).filter((f) => f.severity === 'error')).toEqual([]);

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
        message: 'Start battery fuse should be at least 400 A for about 200 A, but the largest BoatWire can choose for it is 300 A. The 300 A shown leaves too little margin.',
        fix: 'Fit a larger start fuse (Class T or ANL, about 400 A) or the size the engine maker recommends, and check the starter current entered.',
      }),
    ]);
    const big = generateIdeal(boat((p) => void (the(p, 'engine').props.starterAmps = 400)));
    expect(about(big, 'Start battery fuse').map((f) => f.severity)).toEqual(['error']);
    expect(beyond(generateIdeal(exampleProject()))).toEqual([]);

    const iso = generateIdeal(boat((p) => void Object.assign(the(p, 'engine').props, { alternatorAmps: 400, chargeSplit: 'isolator-fet' })));
    expect(about(iso, 'FET battery isolator').map((f) => [f.severity, f.message.split(',')[0]])).toEqual([['error', 'FET battery isolator carries about 400 A']]);
    expect(rating(iso, 'alt-isolator')).toBe(350);

    // the alternator fuse is a Class T above 300 A, so it goes to 800 A
    const alt = generateIdeal(boat((p) => void (the(p, 'engine').props.alternatorAmps = 700)));
    expect(about(alt, 'Alternator output fuse').map((f) => [f.severity, f.message.split(',')[0]])).toEqual([['warning', 'Alternator output fuse should be at least 875 A for about 700 A']]);
    const huge = generateIdeal(boat((p) => void (the(p, 'engine').props.alternatorAmps = 900)));
    expect(about(huge, 'Alternator output fuse').map((f) => [f.severity, f.message.split(',')[0]])).toEqual([['error', 'Alternator output fuse carries about 900 A']]);
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

    // a Vmp of 0 makes the array current infinite; its cables are counted from the breaker, as before
    const blank = boat((q) => void (the(q, 'solar').props.arrayVmp = 0));
    const pv = `pv-${the(blank, 'solar').id}`;
    expect(generateIdeal(blank).wires.filter((w) => w.from.node === pv).map((w) => w.cable)).toEqual(['2× 4/0', '2× 4/0']);
  });

  it('AC: the inverter DC fuse, a generator breaker, an appliance breaker and an inverter-only panel main', () => {
    const inv = generateIdeal(boat((p) => void (the(p, 'inverter-charger').props.watts = 8000)));
    expect(about(inv, 'Inverter/charger DC fuse')).toEqual([
      expect.objectContaining({ severity: 'error', fix: 'Use 24 V, which halves the current, or a smaller inverter.', nodes: ['ic-fuse'] }),
    ]);
    expect(about(inv, 'Inverter/charger DC fuse')[0].message).toBe(
      'Inverter/charger DC fuse carries about 847 A, but the largest BoatWire can choose for it is 800 A. The 800 A shown is too small for that current.',
    );
    // the same 800 A Class T top as the main fuse, so a 5000 W inverter/charger (529 A) fits
    const five = generateIdeal(boat((p) => void (the(p, 'inverter-charger').props.watts = 5000)));
    expect(five.nodes.find((n) => n.id === 'ic-fuse')?.sublabel).toBe('800 A Class T');
    expect(beyond(five)).toEqual([]);

    const p = boat((q) => {
      add(q, 'generator', { watts: 8000 }, 'Generator');
      add(q, 'air-conditioner', { watts: 7000 }, 'Air conditioner');
    });
    const gen = generateIdeal(p);
    expect(beyond(gen).map((f) => [f.severity, f.message.split(',')[0]])).toEqual([
      ['error', 'Generator main breaker carries about 67 A'],
      ['error', 'Air conditioner breaker carries about 58 A'],
    ]);
    // the cables are sized for the current, not the 50 A breakers, so the check finds nothing else
    const genCable = gen.wires.find((w) => w.from.node === 'genset' && w.kind === 'ac')!;
    expect(ampacity(genCable.gauge!, false, true)).toBeGreaterThanOrEqual(genCable.amps!);
    expect(audit(gen).filter((f) => f.severity === 'error')).toEqual([]);
    // the same equipment on 230 V draws less than half the current
    p.profile.acStandard = 'eu230';
    expect(beyond(generateIdeal(p))).toEqual([]);

    const invOnly = boat((q) => {
      q.equipment = q.equipment.filter((e) => e.kind !== 'shore-power' && e.kind !== 'inverter-charger');
      add(q, 'inverter', { watts: 8000 }, 'Inverter');
    });
    const only = generateIdeal(invOnly, V24);
    expect(about(only, 'AC panel main breaker').map((f) => [f.severity, f.message.split(',')[0], f.nodes])).toEqual([['error', 'AC panel main breaker carries about 67 A', ['ac-panel']]]);
    const acOut = only.wires.find((w) => w.from.node === 'inv' && w.kind === 'ac')!;
    expect(acOut.amps).toBe(66.7);
    expect(ampacity(acOut.gauge!, false, true)).toBeGreaterThanOrEqual(66.7);
  });
});
