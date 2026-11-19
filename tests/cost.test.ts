import { describe, expect, it } from 'vitest';
import { changeCost, designCost, planCosts, priceBom } from '../src/engine/cost';
import { existingFromIdeal } from '../src/engine/existing';
import { generateIdeal } from '../src/engine/generate';
import { billOfMaterials, changeList } from '../src/engine/reports';
import { effectiveEquipment } from '../src/engine/scenario';
import { exampleProject } from '../src/model/examples';
import { makeNode } from '../src/model/nodeDefs';
import { DEFAULT_CURRENCY, fmtMoney, PRICE_DEFS, priceFor } from '../src/model/prices';
import type { Design } from '../src/model/types';
import { parseProject } from '../src/model/validate';
import { FINGERPRINT_BOATS, SAMPLE_BOATS } from './sampleBoats';

const example = exampleProject();
const scenario = (id: string) => example.scenarios.find((s) => s.id === id)!;
const cost = (id: string, prices = example.prices) => designCost(generateIdeal(example, scenario(id)), prices);
const category = (c: ReturnType<typeof designCost>, name: string) => c.byCategory.find((x) => x.category === name)?.cost ?? 0;

describe('price list', () => {
  it('has one entry per key, each with a positive default', () => {
    expect(new Set(PRICE_DEFS.map((d) => d.key)).size).toBe(PRICE_DEFS.length);
    expect(PRICE_DEFS.filter((d) => !(d.usd > 0)).map((d) => d.key)).toEqual([]);
  });

  it("uses the owner's price when there is one, the default otherwise", () => {
    expect(priceFor('cable:10')).toBe(PRICE_DEFS.find((d) => d.key === 'cable:10')!.usd);
    expect(priceFor('cable:10', { rates: { 'cable:10': 2 } })).toBe(2);
    expect(priceFor('cable:10', { rates: { 'cable:10': 0 } }), 'free is a valid price').toBe(0);
    expect(priceFor('cable:10', { rates: { 'cable:10': -1 } }), 'a negative price is ignored').toBe(priceFor('cable:10'));
    expect(priceFor('no-such-thing')).toBeUndefined();
  });

  it('formats money: whole units from 100 up, cents below', () => {
    expect(fmtMoney(1234.4)).toBe('$1,234');
    expect(fmtMoney(38)).toBe('$38');
    expect(fmtMoney(0.45)).toBe('$0.45');
    expect(fmtMoney(15.5, '€')).toBe('€15.50');
  });
});

describe('cost of a design', () => {
  it('prices every line of every generated design', () => {
    for (const b of [...SAMPLE_BOATS, ...FINGERPRINT_BOATS]) {
      const c = designCost(generateIdeal(b.project, b.scenario));
      // (a bank that cannot be built at the system voltage is priced as the batteries listed)
      expect(c.rows.filter((r) => r.cost === undefined).map((r) => `${r.item} (${r.spec})`), b.name).toEqual([]);
      expect(c.total, b.name).toBeCloseTo(c.rows.reduce((s, r) => s + (r.cost ?? 0), 0), 6);
      expect(c.total).toBeCloseTo(c.byCategory.reduce((s, x) => s + x.cost, 0), 6);
    }
  });

  it('a line costs its quantity times its unit price', () => {
    const c = cost('base');
    for (const r of c.rows.filter((x) => x.cost !== undefined)) expect(r.unitPrice! * r.qty, r.item).toBeCloseTo(r.cost!, 6);
    const wire = c.rows.find((r) => r.category === 'Cable' && r.item.includes('4/0'))!;
    expect(wire.unitPrice).toBe(priceFor('cable:4/0'));
  });

  it('batteries are priced by the energy they hold, so a 24 V bank of the same energy costs the same', () => {
    const d = generateIdeal(example, scenario('base'));
    const bank = priceBom(billOfMaterials(d)).rows.find((r) => r.category === 'Batteries' && r.spec.includes('400 Ah'))!;
    // 400 Ah at 12 V = 4.8 kWh of AGM
    expect(bank.cost).toBeCloseTo(4.8 * priceFor('battery:agm')!, 6);
  });

  it('shows a difference between scenarios that follows the prices', () => {
    const agm = cost('base');
    const lithium = cost('lfp12');
    const v24 = cost('lfp24');
    expect(agm.total).toBeGreaterThan(1000);
    expect(lithium.total).not.toBeCloseTo(agm.total, 0);
    // less copper at 24 V
    expect(category(v24, 'Cable')).toBeLessThan(category(lithium, 'Cable'));

    // the owner says lithium is cheaper than the default: only the lithium scenarios move
    const cheap = { rates: { 'battery:lifepo4': 300 } };
    expect(cost('lfp12', cheap).total).toBeLessThan(lithium.total);
    expect(cost('base', cheap).total).toBeCloseTo(agm.total, 6);
    expect(category(lithium, 'Batteries') - category(cost('lfp12', cheap), 'Batteries')).toBeCloseTo(((priceFor('battery:lifepo4')! - 300) * 400 * 12) / 1000, 6);
  });

  it('a 24 V what-if is compared like for like: its start battery becomes two in series, and is priced', () => {
    const d = generateIdeal(example, scenario('lfp24'));
    expect(d.nodes.find((n) => n.id === 'start-bat')!.sublabel).toBe('2× 12 V 90 Ah AGM · 2S1P = 24 V 90 Ah');
    expect(cost('lfp24').unpriced).toBe(0);
    // the equipment list itself is not touched, and banks that already fit are left exactly as they are
    expect(example.equipment.find((e) => e.props.role === 'start')!.props.units).toBe(1);
    const at12 = effectiveEquipment(example, scenario('lfp12'));
    expect(at12.find((e) => e.props.role === 'start')).toBe(example.equipment.find((e) => e.props.role === 'start'));
  });

  it('comes to about the same in metric, where cable is bought by the metre', () => {
    const d = generateIdeal(example, scenario('base'));
    const ft = designCost(d, undefined, 'imperial');
    const m = designCost(d, undefined, 'metric');
    expect(Math.abs(m.total - ft.total) / ft.total).toBeLessThan(0.02);
    const wire = m.rows.find((r) => r.category === 'Cable' && r.unit === 'm')!;
    // per metre is dearer than per foot by the length of a metre
    expect(wire.unitPrice! / priceFor(wire.priceKey!)!).toBeCloseTo(1 / 0.3048, 6);
  });

  it("carries the owner's currency symbol", () => {
    expect(cost('base').currency).toBe(DEFAULT_CURRENCY);
    expect(cost('base', { currency: '€' }).currency).toBe('€');
  });

  it('leaves out, and counts, what it cannot price', () => {
    const d: Design = { id: 'existing', name: 'Existing', systemVoltage: 12, findings: [], wires: [], nodes: [makeNode('charger', 'c', 'Old charger'), makeNode('fuse', 'f', 'Fuse', { data: { rating: 100 } }), makeNode('note', 'n', 'A note')] };
    const c = designCost(d);
    // the charger's output is not recorded, so it has no price; the fuse is priced as the usual type for 100 A; the note is not a part
    expect(c.unpriced).toBe(1);
    expect(c.rows.map((r) => r.item)).toEqual(['Battery charger', 'Fuse']);
    expect(c.total).toBe(priceFor('fuse:MIDI'));
  });
});

describe('cost of the upgrade plan', () => {
  it('prices the parts of the changes it can, by priority group', () => {
    const ideal = generateIdeal(example);
    const existing = existingFromIdeal(ideal, {});
    // take out the house fuse and the galvanic isolator
    const gone = new Set(['house0-fuse', 'galv-iso']);
    existing.nodes = existing.nodes.filter((n) => !gone.has(n.id));
    existing.wires = existing.wires.filter((w) => !gone.has(w.from.node) && !gone.has(w.to.node));
    const changes = changeList(existing, ideal, 120);
    const costs = planCosts(changes);

    // (which of the ideal design's fuses counts as the missing one is not defined, so only: it is the price of a fuse)
    const addFuse = changes.find((c) => /Add 1 × Fuse/.test(c.title))!;
    expect(PRICE_DEFS.filter((d) => d.key.startsWith('fuse:')).map((d) => d.usd)).toContain(changeCost(addFuse));
    const addGi = changes.find((c) => /Galvanic isolator/.test(c.title) && c.parts)!;
    expect(changeCost(addGi)).toBe(priceFor('part:galvanic-isolator'));

    const total = (['safety', 'recommended', 'improvement'] as const).reduce((s, g) => s + costs[g].priced + costs[g].unpriced, 0);
    expect(total).toBe(changes.length);
    expect(costs.recommended.cost).toBeGreaterThanOrEqual(changeCost(addFuse)! + priceFor('part:galvanic-isolator')!);
    // a change with no known parts is counted, not priced
    expect(changeCost({ priority: 'recommended', title: 'Rewire something', rule: 'conductor-sizing' })).toBeUndefined();
  });

  it('counts a part once when the plan names it both as a problem and as a part to add', () => {
    const gi = priceFor('part:galvanic-isolator')!;
    const problem = { priority: 'recommended' as const, title: 'Shore-power ground has no galvanic isolator.', rule: 'galvanic-isolator' };
    const part = { priority: 'recommended' as const, title: 'Add 1 × Galvanic isolator', parts: [['part:galvanic-isolator', 1]] as [string, number][] };
    expect(planCosts([problem]).recommended.cost).toBe(gi);
    expect(planCosts([problem, part]).recommended).toEqual({ cost: gi, priced: 2, unpriced: 0 });
    // a missing fuse found by the check and a fuse the ideal design adds are one fuse, whatever their types
    const noFuse = { priority: 'safety' as const, title: 'No fuse at the battery', rule: 'battery-fuse' };
    const addFuse = { priority: 'recommended' as const, title: 'Add 1 × Fuse', parts: [['fuse:Class T', 1]] as [string, number][] };
    const both = planCosts([noFuse, addFuse]);
    expect(both.safety.cost + both.recommended.cost).toBe(priceFor('fuse:Class T'));
    // two problems, one part listed: the second problem still needs its own
    expect(planCosts([problem, problem, part]).recommended.cost).toBe(2 * gi);
  });

  it('prices an upsized wire by the cable the ideal design uses, there and back', () => {
    expect(changeCost({ priority: 'recommended', title: 'x', parts: [['cable:10', 30]] })).toBeCloseTo(30 * priceFor('cable:10')!, 6);
  });
});

describe('prices saved with the project', () => {
  it('keeps the owner\'s prices and currency through save and load', () => {
    const p = exampleProject();
    p.prices = { currency: '€', rates: { 'cable:10': 1.2, 'battery:lifepo4': 420 } };
    expect(parseProject(JSON.parse(JSON.stringify(p))).project.prices).toEqual(p.prices);
  });

  it('drops anything that is not a known entry with a sensible price', () => {
    const p = JSON.parse(JSON.stringify(exampleProject()));
    p.prices = { currency: '  £  ', rates: { 'cable:10': 1.2, 'made-up': 5, 'cable:8': -3, 'cable:6': 'lots', 'cable:4': null } };
    expect(parseProject(p).project.prices).toEqual({ currency: '£', rates: { 'cable:10': 1.2 } });
    p.prices = { currency: '$', rates: {} };
    expect(parseProject(p).project.prices).toBeUndefined();
    p.prices = 'nonsense';
    expect(parseProject(p).project.prices).toBeUndefined();
  });
});
