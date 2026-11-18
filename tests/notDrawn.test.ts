import { describe, expect, it } from 'vitest';
import { generateIdeal } from '../src/engine/generate';
import { exampleProject, newEquipment } from '../src/model/examples';
import type { Design, EquipmentKind, Project } from '../src/model/types';

const notDrawn = (d: Design) => d.findings.filter((f) => f.rule === 'not-drawn');
const add = (p: Project, kind: EquipmentKind, name: string, props: Record<string, unknown> = {}) => {
  const e = newEquipment(kind, { name });
  Object.assign(e.props, props);
  p.equipment.push(e);
  return e;
};

describe('equipment the generator cannot draw is reported, not dropped silently', () => {
  it('says nothing for the example boat', () => {
    const p = exampleProject();
    for (const s of p.scenarios) expect(notDrawn(generateIdeal(p, s)), s.name).toHaveLength(0);
  });

  it('reports a second engine and names the one that was used', () => {
    const p = exampleProject();
    const first = p.equipment.find((e) => e.kind === 'engine')!;
    add(p, 'engine', 'Port engine');
    const d = generateIdeal(p);
    expect(d.nodes.filter((n) => n.type === 'engine')).toHaveLength(1);
    const f = notDrawn(d);
    expect(f).toHaveLength(1);
    expect(f[0].severity).toBe('warning');
    expect(f[0].message).toBe(`Port engine is not in this design. BoatWire draws one engine per boat and used ${first.name}.`);
  });

  it('reports each extra of every single-instance kind', () => {
    const p = exampleProject();
    add(p, 'engine', 'Port engine');
    add(p, 'shore-power', 'Second shore inlet');
    add(p, 'generator', 'Genset A');
    add(p, 'generator', 'Genset B');
    add(p, 'inverter-charger', 'Spare inverter/charger');
    add(p, 'battery-bank', 'Second start battery', { role: 'start' });
    const names = notDrawn(generateIdeal(p)).map((f) => f.message.split(' is not in this design')[0]);
    expect(names.sort()).toEqual(['Genset B', 'Port engine', 'Second shore inlet', 'Second start battery', 'Spare inverter/charger'].sort());
  });

  it('reports a plain inverter that is ignored because there is an inverter/charger', () => {
    const p = exampleProject();
    expect(p.equipment.some((e) => e.kind === 'inverter-charger')).toBe(true);
    add(p, 'inverter', 'Galley inverter');
    const d = generateIdeal(p);
    expect(d.nodes.some((n) => n.type === 'inverter')).toBe(false);
    expect(notDrawn(d).map((f) => f.message)).toEqual([expect.stringMatching(/^Galley inverter is not in this design\. BoatWire draws one inverter per boat and used /)]);
  });

  it('reports a second dedicated bank for the same job', () => {
    const p = exampleProject();
    add(p, 'battery-bank', 'Windlass battery', { role: 'windlass' });
    expect(notDrawn(generateIdeal(p))).toHaveLength(0);
    add(p, 'battery-bank', 'Second windlass battery', { role: 'windlass' });
    expect(notDrawn(generateIdeal(p)).map((f) => f.message)).toEqual(['Second windlass battery is not in this design. BoatWire draws one windlass battery per boat and used Windlass battery.']);
  });

  it('does not report equipment the generator draws many of', () => {
    const p = exampleProject();
    add(p, 'solar', 'Second solar array');
    add(p, 'battery-charger', 'Second charger');
    add(p, 'battery-bank', 'Second house bank', { role: 'house', chemistry: p.equipment.find((e) => e.kind === 'battery-bank' && e.props.role === 'house')!.props.chemistry });
    add(p, 'fridge', 'Second fridge');
    expect(notDrawn(generateIdeal(p))).toHaveLength(0);
  });
});
