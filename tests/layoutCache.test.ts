import { describe, expect, it } from 'vitest';
import { generateIdeal } from '../src/engine/generate';
import { autoLayout, cachedLayout, viewShift, type Layout } from '../src/layout/layout';
import { exampleProject } from '../src/model/examples';
import type { LayerSettings } from '../src/model/types';

const layers: LayerSettings = { dc: true, ac: true, negatives: 'full', signal: true, grounding: false, labels: { gauge: true, protection: true, current: false, length: false, vdrop: false, parts: false } };

describe('layout reuse', () => {
  it('reuses the last layout when an edit does not change the shape of the diagram', async () => {
    const p = exampleProject();
    const first = await autoLayout(generateIdeal(p, p.scenarios[0]), layers);

    // a different wattage changes labels and maybe wire sizes, but not what connects to what
    const lights = p.equipment.find((e) => e.kind === 'cabin-lights')!;
    lights.props.watts = Number(lights.props.watts) + 5;
    lights.name = 'Saloon lights';
    const edited = generateIdeal(p, p.scenarios[0]);
    const hit = cachedLayout(edited, layers);
    expect(hit).not.toBeNull();
    expect(hit!.nodes.map((n) => [n.id, n.x, n.y])).toEqual(first.nodes.map((n) => [n.id, n.x, n.y]));
    // …and it carries the edited data, not the old
    expect(hit!.nodes.find((n) => n.node.equipmentId === lights.id)!.node.label).toBe('Saloon lights');
  });

  it('does not reuse it when the shape changes', async () => {
    const p = exampleProject();
    await autoLayout(generateIdeal(p, p.scenarios[0]), layers);
    p.equipment = p.equipment.filter((e) => e.kind !== 'fridge');
    expect(cachedLayout(generateIdeal(p, p.scenarios[0]), layers)).toBeNull();
    // a Show option changes the shape too
    const q = exampleProject();
    expect(cachedLayout(generateIdeal(q, q.scenarios[0]), { ...layers, negatives: 'hidden' })).toBeNull();
  });
});

describe('viewShift', () => {
  const node = (id: string, x: number, y: number) => ({ id, x, y, w: 100, h: 50 }) as Layout['nodes'][number];
  const lay = (...nodes: Layout['nodes']): Layout => ({ nodes, edges: [] });

  it('follows the component nearest the middle of the view', () => {
    const before = lay(node('a', 0, 0), node('b', 500, 300));
    const after = lay(node('a', 0, 0), node('b', 540, 380));
    expect(viewShift(before, after, { x: 560, y: 320 })).toEqual({ x: 40, y: 80 });
    expect(viewShift(before, after, { x: 40, y: 20 })).toEqual({ x: 0, y: 0 });
  });

  it('ignores components that were removed, and does nothing when none are shared', () => {
    const before = lay(node('a', 0, 0), node('gone', 500, 300));
    expect(viewShift(before, lay(node('a', 10, 20)), { x: 550, y: 325 })).toEqual({ x: 10, y: 20 });
    expect(viewShift(before, lay(node('new', 1, 1)), { x: 0, y: 0 })).toEqual({ x: 0, y: 0 });
  });
});
