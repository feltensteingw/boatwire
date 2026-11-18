import { describe, expect, it } from 'vitest';
import { audit } from '../src/engine/audit';
import { energyBudget } from '../src/engine/energy';
import { generateIdeal } from '../src/engine/generate';
import { DEFAULT_ZONES } from '../src/model/catalog';
import { buildBoat, CUSTOM_ANSWERS, LOAD_GROUPS, TEMPLATES, zonesFor, type BoatAnswers } from '../src/model/templates';
import { parseProject } from '../src/model/validate';

const problems = (a: BoatAnswers) => {
  const p = buildBoat(a);
  const d = generateIdeal(p);
  return [...d.findings, ...audit(d, { acVolts: a.acStandard === 'eu230' ? 230 : 120 })];
};

describe('boat templates', () => {
  for (const t of TEMPLATES) {
    it(`${t.name}: a complete design with no errors`, () => {
      const p = buildBoat(t.answers);
      const d = generateIdeal(p);
      expect(d.nodes.length).toBeGreaterThan(10);
      const found = problems(t.answers);
      expect(found.filter((f) => f.severity === 'error').map((f) => f.message)).toEqual([]);
      // nothing left out, nothing pointing at a missing zone
      expect(found.filter((f) => f.rule === 'not-drawn' || f.rule === 'missing-zone')).toEqual([]);
      // and it is a valid project as it stands
      expect(parseProject(JSON.parse(JSON.stringify(p))).notes).toEqual([]);
    });

    it(`${t.name}: the house bank is big enough for what is aboard`, () => {
      const b = energyBudget(buildBoat(t.answers));
      expect(b.houseAh, `${Math.round(b.totalAhPerDay)} Ah/day suggests ${b.recommendedAh} Ah`).toBeGreaterThanOrEqual(b.recommendedAh * 0.9);
    });
  }

  it('the questions-only starting point is sound too', () => {
    expect(problems(CUSTOM_ANSWERS).filter((f) => f.severity === 'error')).toEqual([]);
  });

  it('every appliance offered exists in the catalog, once', () => {
    const kinds = LOAD_GROUPS.flatMap((g) => g.kinds);
    expect(new Set(kinds).size).toBe(kinds.length);
    const p = buildBoat({ ...CUSTOM_ANSWERS, loads: kinds });
    expect(p.equipment.filter((e) => kinds.includes(e.kind))).toHaveLength(kinds.length);
  });
});

describe('answers to a boat', () => {
  it('sizes the house bank in whole batteries, in series pairs on 24 V', () => {
    const bank = (a: Partial<BoatAnswers>) => buildBoat({ ...CUSTOM_ANSWERS, ...a }).equipment.find((e) => e.props.role === 'house')!.props.units;
    expect(bank({ systemVoltage: 12, houseAh: 300 })).toBe(3);
    expect(bank({ systemVoltage: 12, houseAh: 250 })).toBe(3);
    expect(bank({ systemVoltage: 24, houseAh: 200 })).toBe(4);
    expect(energyBudget(buildBoat({ ...CUSTOM_ANSWERS, systemVoltage: 24, houseAh: 200 })).houseAh).toBe(200);
  });

  it('adds a start battery only with an engine, and a charger only when shore power has nothing else to charge with', () => {
    const kinds = (a: Partial<BoatAnswers>) => buildBoat({ ...CUSTOM_ANSWERS, ...a }).equipment.map((e) => (e.kind === 'battery-bank' ? `bank:${e.props.role}` : e.kind));
    expect(kinds({ engine: false, startBattery: true })).not.toContain('bank:start');
    expect(kinds({ engine: true, startBattery: true })).toContain('bank:start');
    expect(kinds({ shoreAmps: 30, inverter: 'none' })).toContain('battery-charger');
    expect(kinds({ shoreAmps: 30, inverter: 'inverter-charger', inverterWatts: 2000 })).not.toContain('battery-charger');
    expect(kinds({ shoreAmps: 0, inverter: 'none' })).not.toContain('battery-charger');
    expect(kinds({ shoreAmps: 0, inverter: 'none' })).not.toContain('shore-power');
  });

  it('a 230 V boat with 16 A shore power generates cleanly', () => {
    expect(problems({ ...CUSTOM_ANSWERS, acStandard: 'eu230', shoreAmps: 16 }).filter((f) => f.severity === 'error')).toEqual([]);
  });
});

describe('zones scale with the boat', () => {
  it('a 40 ft boat gets the standard zones', () => {
    expect(zonesFor(40)).toEqual(DEFAULT_ZONES);
  });

  it('a shorter boat is shorter, with a shorter mast, but the same places', () => {
    const z = zonesFor(25);
    const std = Object.fromEntries(DEFAULT_ZONES.map((x) => [x.id, x]));
    expect(z.map((x) => x.id)).toEqual(DEFAULT_ZONES.map((x) => x.id));
    expect(Math.max(...z.map((x) => x.x))).toBeLessThan(25);
    expect(z.find((x) => x.id === 'masthead')!.rise).toBe(Math.round(std.masthead.rise * (25 / 40)));
    expect(z.find((x) => x.id === 'bilge')!.rise).toBe(std.bilge.rise);
  });

  it('cable lengths, and so cable sizes, follow the boat length', () => {
    const windlassCable = (lengthFt: number) => {
      const d = generateIdeal(buildBoat({ ...TEMPLATES[2].answers, lengthFt }));
      return d.wires.filter((w) => w.kind === 'pos' && w.notes?.includes('heavy-load')).reduce((s, w) => s + w.lengthFt, 0);
    };
    expect(windlassCable(55)).toBeGreaterThan(windlassCable(30) * 1.5);
  });
});
