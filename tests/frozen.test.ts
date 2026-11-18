import { describe, expect, it } from 'vitest';
import { produce } from 'immer';
import { audit, estimateCurrents } from '../src/engine/audit';
import { energyBudget } from '../src/engine/energy';
import { existingFromIdeal } from '../src/engine/existing';
import { generateIdeal } from '../src/engine/generate';
import { billOfMaterials, changeList, designMetrics, wireSchedule } from '../src/engine/reports';
import { arrangePositions, autoLayout, foldFuses, manualLayout } from '../src/layout/layout';
import { exampleProject } from '../src/model/examples';
import type { LayerSettings, Project } from '../src/model/types';
import { parseProject } from '../src/model/validate';
import { removeZone } from '../src/model/zones';
import { describeChange } from '../src/state/changes';

const layers: LayerSettings = { dc: true, ac: true, negatives: 'full', panelLoads: 'collapse', fuses: false, signal: true, grounding: true, labels: { gauge: true, protection: true, current: true, length: true, vdrop: true, parts: true } };

/** The example boat with a drawing, exactly as the store holds it: deeply frozen by immer. */
function frozenProject(): Project {
  const p = exampleProject();
  p.existing = existingFromIdeal(generateIdeal(p), {});
  p.existing.underlay = { src: 'data:image/webp;base64,AAAA', name: 'a.png', x: 0, y: 0, width: 10, height: 10, opacity: 0.5, visible: true, locked: false };
  // produce() returns a frozen result; a no-op recipe on a fresh object freezes it deeply.
  return produce(p, (d) => void (d.profile.name = `${d.profile.name} `));
}

describe('nothing that reads the project changes it', () => {
  // The store hands out frozen objects. Any code that wrote to one would throw here, as it would in the app.
  const p = frozenProject();

  it('really is frozen', () => {
    expect(Object.isFrozen(p)).toBe(true);
    expect(Object.isFrozen(p.existing!.nodes[0])).toBe(true);
    expect(Object.isFrozen(p.existing!.wires[0].from)).toBe(true);
    expect(() => {
      (p.equipment[0] as { name: string }).name = 'x';
    }).toThrow();
  });

  it('generating, checking and reporting', () => {
    for (const s of p.scenarios) {
      const d = generateIdeal(p, s);
      audit(d);
      energyBudget(p, s);
      wireSchedule(d);
      billOfMaterials(d);
      designMetrics(d, 120);
    }
    const ex = p.existing!;
    audit(ex);
    estimateCurrents(ex);
    wireSchedule(ex);
    billOfMaterials(ex);
    changeList(ex, generateIdeal(p), 120);
  });

  it('laying out, with every Show option that rewrites the diagram', async () => {
    const ex = p.existing!;
    manualLayout(ex, layers);
    manualLayout(ex, { ...layers, negatives: 'hidden', panelLoads: 'show', fuses: true });
    foldFuses(ex);
    await autoLayout(ex, layers);
    await arrangePositions(ex);
  });

  it('describing changes, validating and editing a copy', () => {
    const q = produce(p, (d) => removeZone(d as Project, 'bilge', 'saloon'));
    expect(describeChange(p, q)?.label).toBe('Removed the zone Bilge');
    expect(parseProject(JSON.parse(JSON.stringify(p))).notes).toEqual([]);
    // the untouched parts are shared, not copied
    expect(q.scenarios).toBe(p.scenarios);
    expect(q.existing!.underlay).toBe(p.existing!.underlay);
    expect(q.equipment).not.toBe(p.equipment);
  });
});
