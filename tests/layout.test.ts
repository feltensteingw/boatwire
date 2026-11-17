import { describe, expect, it } from 'vitest';
import { exampleProject } from '../src/model/examples';
import { generateIdeal } from '../src/engine/generate';
import { autoLayout } from '../src/layout/layout';
import type { LayerSettings } from '../src/model/types';

const layers: LayerSettings = { dc: true, ac: true, negatives: 'full', signal: true, grounding: false, labels: { gauge: true, protection: true, current: false, length: false, vdrop: false, parts: false } };

describe('layout', () => {
  it('lays out every scenario of the example with routed edges', async () => {
    const p = exampleProject();
    for (const s of p.scenarios) {
      const d = generateIdeal(p, s);
      const l = await autoLayout(d, layers);
      expect(l.nodes.length).toBeGreaterThan(20);
      expect(l.edges.every((e) => e.points && e.points.length >= 2)).toBe(true);
      const xs = l.nodes.map((n) => n.x + n.w);
      const ys = l.nodes.map((n) => n.y + n.h);
      console.log(s.name, 'size', Math.max(...xs), 'x', Math.max(...ys));
    }
  });
  it('DC-only and AC-only views', async () => {
    const p = exampleProject();
    const d = generateIdeal(p);
    const dc = await autoLayout(d, { ...layers, ac: false });
    const ac = await autoLayout(d, { ...layers, dc: false });
    expect(dc.nodes.some((n) => n.node.domain === 'ac')).toBe(false);
    expect(ac.nodes.some((n) => n.node.type === 'load')).toBe(false);
    expect(ac.nodes.some((n) => n.node.type === 'inverter-charger')).toBe(true);
  });
  it('collapses DC panel loads into a summary, keeping unswitched and heavy loads', async () => {
    const p = exampleProject();
    const d = generateIdeal(p);
    const full = await autoLayout(d, layers);
    const col = await autoLayout(d, { ...layers, panelLoads: 'collapse' });
    const kinds = (l: typeof col) => l.nodes.filter((n) => n.node.type === 'load').map((n) => String(n.node.data.kind));
    expect(kinds(col)).not.toContain('cabin-lights');
    expect(kinds(col)).not.toContain('fridge');
    expect(kinds(col)).toContain('bilge-pump');
    expect(kinds(col)).toContain('windlass');
    expect(col.nodes.length).toBeLessThan(full.nodes.length - 10);
    const panel = col.nodes.find((n) => n.id === 'dc-panel')!;
    expect(panel.hiddenCircuits).toBe(full.nodes.filter((n) => n.node.type === 'load').length - kinds(col).length);
    expect(col.nodes.some((n) => n.id === 'dc-panel-neg')).toBe(false);
  });
});
