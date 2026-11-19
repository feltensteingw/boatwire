import { describe, expect, it } from 'vitest';
import { audit } from '../src/engine/audit';
import { generateIdeal } from '../src/engine/generate';
import { acVoltsOf, FINGERPRINT_BOATS, SAMPLE_BOATS } from './sampleBoats';

// BoatWire draws the ideal design and checks hand-drawn ones. The two must agree: a design the
// generator is happy with must pass the same check a user's own drawing gets.

/**
 * Boats where they do not agree yet. Each is a real defect in the generator, tracked as a task on
 * the BoatWire board in Asana. The test below pins what the check reports today, so fixing one
 * fails the test until its entry is removed from this list.
 */
const KNOWN_GAPS: Record<string, { rules: string[]; task: string }> = {};

describe('every generated design passes the design check', () => {
  const boats = [...SAMPLE_BOATS, ...FINGERPRINT_BOATS];

  for (const b of boats) {
    const d = generateIdeal(b.project, b.scenario);
    const own = d.findings.filter((f) => f.severity === 'error');
    const errors = () => audit(d, { acVolts: acVoltsOf(b.project), units: b.project.profile.units }).filter((f) => f.severity === 'error');
    const gap = KNOWN_GAPS[b.name];

    if (own.length) {
      // The equipment list cannot be built as asked, and the generator says so. What it draws is
      // then a best effort, not a design to hold to the rules.
      it(`${b.name}: the generator reports the problem itself (${[...new Set(own.map((f) => f.rule))].join(', ')})`, () => {
        expect(own.every((f) => f.message.length > 20)).toBe(true);
      });
    } else if (gap) {
      it(`${b.name}: known gap, still open ("${gap.task}")`, () => {
        expect([...new Set(errors().map((f) => f.rule))].sort()).toEqual(gap.rules);
      });
    } else {
      it(b.name, () => {
        expect(errors().map((f) => `${f.rule}: ${f.message}`)).toEqual([]);
      });
    }
  }

  it('the list of known gaps names boats that exist', () => {
    expect(Object.keys(KNOWN_GAPS).filter((name) => !boats.some((b) => b.name === name))).toEqual([]);
  });

  it('no known gap belongs to a boat whose problem the generator now reports itself', () => {
    const reportsItself = (b: (typeof boats)[number]) => generateIdeal(b.project, b.scenario).findings.some((f) => f.severity === 'error');
    expect(boats.filter((b) => KNOWN_GAPS[b.name] && reportsItself(b)).map((b) => b.name)).toEqual([]);
  });
});
