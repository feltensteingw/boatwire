import { describe, expect, it } from 'vitest';
import { audit } from '../src/engine/audit';
import { paletteNode } from '../src/engine/existing';
import { generateIdeal } from '../src/engine/generate';
import { billOfMaterials, changeList, designMetrics, wireSchedule } from '../src/engine/reports';
import { ruleInfo } from '../src/engine/rules';
import { exampleProject } from '../src/model/examples';
import { GAUGES } from '../src/model/standards';
import { buildBoat, CUSTOM_ANSWERS } from '../src/model/templates';
import type { Design } from '../src/model/types';
import { awgForMetric, cableLabel, cableText, fmtLen, fmtShort, fmtSize, fromLen, METRIC_SIZES, metricSize, toLen } from '../src/model/units';
import { parseProject } from '../src/model/validate';

describe('wire sizes in mm²', () => {
  it('shows the next standard metric size with at least as much copper', () => {
    const shown = Object.fromEntries(GAUGES.map((g) => [g.awg, metricSize(g.awg)]));
    expect(shown).toEqual({ '18': 1, '16': 1.5, '14': 2.5, '12': 4, '10': 6, '8': 10, '6': 16, '4': 25, '2': 35, '1': 50, '1/0': 70, '2/0': 70, '3/0': 95, '4/0': 120 });
    for (const g of GAUGES) expect(metricSize(g.awg)! + 0.05, g.awg).toBeGreaterThanOrEqual(g.mm2);
  });

  it('checks an installed metric cable as the AWG size with no more copper than it has', () => {
    const checked = Object.fromEntries(METRIC_SIZES.map((s) => [s, awgForMetric(s)]));
    expect(checked).toEqual({ 1: '18', 1.5: '16', 2.5: '14', 4: '12', 6: '10', 10: '8', 16: '6', 25: '4', 35: '2', 50: '1', 70: '2/0', 95: '3/0', 120: '4/0' });
    for (const s of METRIC_SIZES) expect(GAUGES.find((g) => g.awg === awgForMetric(s))!.mm2, String(s)).toBeLessThanOrEqual(s + 0.05);
  });

  it('a size picked in mm² shows as the same size again', () => {
    for (const s of METRIC_SIZES) expect(metricSize(awgForMetric(s)), String(s)).toBe(s);
  });

  it('formats sizes and cables both ways', () => {
    expect(fmtSize('10', 'imperial')).toBe('10 AWG');
    expect(fmtSize('10', 'metric')).toBe('6 mm²');
    expect(fmtSize(undefined, 'metric')).toBe('—');
    expect(cableLabel({ gauge: '10', kind: 'pos' }, 'imperial')).toBe('10');
    expect(cableLabel({ gauge: '10', kind: 'pos' }, 'metric')).toBe('6 mm²');
    expect(cableLabel({ gauge: '10', kind: 'ac', cable: '10/3' }, 'imperial')).toBe('10/3');
    expect(cableLabel({ gauge: '10', kind: 'ac', cable: '10/3' }, 'metric')).toBe('3G6');
    expect(cableLabel({ gauge: '4/0', kind: 'pos', cable: '2× 4/0' }, 'imperial')).toBe('2× 4/0');
    expect(cableLabel({ gauge: '4/0', kind: 'pos', cable: '2× 4/0' }, 'metric')).toBe('2× 120 mm²');
    expect(cableText({ gauge: '10', kind: 'ac', cable: '10/3' }, 'metric')).toBe('3G6 mm²');
    expect(cableText({ gauge: '2', kind: 'pos' }, 'imperial')).toBe('2 AWG');
    expect(cableLabel({ kind: 'pos' }, 'metric')).toBeUndefined();
  });
});

describe('lengths in metres', () => {
  it('converts for display and back for input', () => {
    expect(fmtLen(10, 'imperial')).toBe('10 ft');
    expect(fmtLen(10, 'metric')).toBe('3 m');
    expect(toLen(12.5, 'metric')).toBe(3.8);
    expect(fromLen(3.8, 'metric')).toBeCloseTo(12.47, 2);
    expect(fromLen(7, 'imperial')).toBe(7);
    expect(fmtShort(7, 'imperial')).toBe('7 in');
    expect(fmtShort(7, 'metric')).toBe('18 cm');
    // what the user types comes back as what they typed
    for (const m of [0.2, 1, 2.5, 7.3, 12, 15.2]) expect(toLen(fromLen(m, 'metric'), 'metric'), String(m)).toBe(m);
  });
});

describe('a metric boat is the same design, shown in metric', () => {
  const imperial = exampleProject();
  const metric = exampleProject();
  metric.profile.units = 'metric';
  // same equipment ids so the two designs can be compared wire for wire
  metric.equipment = imperial.equipment;

  it('sizes, lengths and currents are identical; only the words change', () => {
    const a = generateIdeal(imperial);
    const b = generateIdeal(metric);
    expect(b.wires.map((w) => [w.gauge, w.lengthFt, w.amps, w.vdropPct])).toEqual(a.wires.map((w) => [w.gauge, w.lengthFt, w.amps, w.vdropPct]));
    expect(b.nodes.map((n) => [n.id, n.data.rating])).toEqual(a.nodes.map((n) => [n.id, n.data.rating]));
    expect(audit(b, { units: 'metric' }).map((f) => [f.rule, f.severity])).toEqual(audit(a).map((f) => [f.rule, f.severity]));
  });

  it('the wire schedule and bill of materials are in mm² and metres', () => {
    const d = generateIdeal(metric);
    const rows = wireSchedule(d, 'metric');
    const sized = rows.filter((r) => r.size !== '—');
    expect(sized.every((r) => /mm²$|^3G/.test(r.size))).toBe(true);
    const w = d.wires.find((x) => x.lengthFt > 10)!;
    expect(rows.find((r) => r.id === w.id)!.length).toBe(toLen(w.lengthFt, 'metric'));
    const bom = billOfMaterials(d, 'metric');
    const cable = bom.filter((r) => r.category === 'Cable');
    expect(cable.length).toBeGreaterThan(3);
    expect(cable.every((r) => r.unit === 'm' && Number.isInteger(r.qty) && !/AWG/.test(r.item))).toBe(true);
    expect(bom.some((r) => /AWG/.test(`${r.item} ${r.spec}`))).toBe(false);
    // metres of cable are fewer than feet of the same cable
    const feet = billOfMaterials(generateIdeal(imperial), 'imperial').filter((r) => r.category === 'Cable').reduce((s, r) => s + r.qty, 0);
    const metres = cable.reduce((s, r) => s + r.qty, 0);
    expect(metres).toBeGreaterThan(feet * 0.28);
    expect(metres).toBeLessThan(feet * 0.36);
  });

  it('Compare figures name sizes in mm²', () => {
    const m = designMetrics(generateIdeal(metric), 120, 'metric');
    expect(m.mainCable).toMatch(/mm²/);
    expect(m.largestCable).toMatch(/mm²$/);
    expect(designMetrics(generateIdeal(imperial), 120).largestCable).toMatch(/AWG$/);
  });

  it('check messages and rule explanations use cm, metres and mm²', () => {
    const bat = paletteNode('battery', 'battery');
    const fuse = paletteNode('fuse', 'battery');
    fuse.data.rating = 100;
    const load = paletteNode('load', 'saloon');
    load.data.amps = 40;
    const d: Design = {
      id: 'existing',
      name: 'Existing',
      systemVoltage: 12,
      nodes: [bat, fuse, load],
      findings: [],
      wires: [
        { id: 'w1', kind: 'pos', domain: 'dc', from: { node: bat.id, term: 'pos' }, to: { node: fuse.id, term: 'in' }, lengthFt: 3, gauge: '2' },
        { id: 'w2', kind: 'pos', domain: 'dc', from: { node: fuse.id, term: 'out' }, to: { node: load.id, term: 'pos' }, lengthFt: 20, gauge: '16' },
        { id: 'w3', kind: 'neg', domain: 'dc', from: { node: load.id, term: 'neg' }, to: { node: bat.id, term: 'neg' }, lengthFt: 20, gauge: '16' },
      ],
    };
    const text = (units: 'imperial' | 'metric') => audit(d, { units }).map((f) => `${f.message} ${f.fix ?? ''}`).join('\n');
    expect(text('imperial')).toMatch(/fuse is 36 in from the battery/);
    expect(text('imperial')).toMatch(/16 AWG carries/);
    expect(text('metric')).toMatch(/fuse is 91 cm from the battery/);
    expect(text('metric')).toMatch(/within 18 cm/);
    expect(text('metric')).toMatch(/1\.5 mm² carries/);
    expect(text('metric')).not.toMatch(/ AWG| in from| ft\b/);
    expect(ruleInfo('battery-fuse', 'metric').why).toMatch(/within 18 cm of the terminal/);
    expect(ruleInfo('battery-fuse').why).toMatch(/within 7 in of the terminal/);
    expect(ruleInfo('shore-main', 'metric').why).toMatch(/within 3 m of the inlet/);
    const plan = changeList(d, generateIdeal(metric), 230, 'metric').map((c) => `${c.title} ${c.detail ?? ''}`).join('\n');
    expect(plan).not.toMatch(/ AWG| in from/);
  });
});

describe('choosing the units', () => {
  it('boats saved before there was a choice stay in feet and AWG', () => {
    const old = JSON.parse(JSON.stringify(exampleProject()));
    delete old.profile.units;
    expect(parseProject(old).project.profile.units).toBe('imperial');
    old.profile.units = 'metric';
    expect(parseProject(old).project.profile.units).toBe('metric');
    old.profile.units = 'furlongs';
    expect(parseProject(old).project.profile.units).toBe('imperial');
  });

  it('a new 230 V boat starts in metric, a 120 V boat in feet, unless told otherwise', () => {
    expect(buildBoat({ ...CUSTOM_ANSWERS, acStandard: 'eu230', shoreAmps: 16 }).profile.units).toBe('metric');
    expect(buildBoat({ ...CUSTOM_ANSWERS, acStandard: 'us120' }).profile.units).toBe('imperial');
    expect(buildBoat({ ...CUSTOM_ANSWERS, acStandard: 'us120', units: 'metric' }).profile.units).toBe('metric');
  });
});
