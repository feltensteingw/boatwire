import { describe, expect, it } from 'vitest';
import { generateIdeal } from '../src/engine/generate';
import { fingerprint, renderDesign } from './renderDesign';
import { FINGERPRINT_BOATS, SAMPLE_BOATS } from './sampleBoats';

// The generator's output for a fixed set of boats, recorded in __snapshots__. These tests exist so
// that reorganising the generator cannot change a design by accident.
//
// If a test here fails after a change you intended, read the diff: each changed line is one
// component, wire or finding that now comes out differently. When the new output is what you
// meant, update the record with `npx vitest run -u tests/generatorGolden.test.ts` and commit it.

describe('generated designs are unchanged', () => {
  for (const b of SAMPLE_BOATS) {
    it(b.name, () => {
      const d = generateIdeal(b.project, b.scenario);
      expect(renderDesign(d)).toMatchSnapshot('design');
      // every field, including the few the readable record leaves out
      expect(fingerprint(d)).toMatchSnapshot('fingerprint');
    });
  }
});

describe('more generated designs are unchanged (fingerprint only)', () => {
  for (const b of FINGERPRINT_BOATS) {
    it(b.name, () => {
      const d = generateIdeal(b.project, b.scenario);
      expect(`${d.nodes.length} components, ${d.wires.length} wires, ${d.findings.length} findings, ${fingerprint(d)}`).toMatchSnapshot();
    });
  }
});

it('generating the same boat twice gives the same design', () => {
  for (const b of SAMPLE_BOATS) expect(fingerprint(generateIdeal(b.project, b.scenario))).toBe(fingerprint(generateIdeal(b.project, b.scenario)));
});
