import { describe, expect, it } from 'vitest';
import { exampleProject, newEquipment } from '../src/model/examples';
import { generateIdeal } from '../src/engine/generate';
import { autoLayout, visibleSubset } from '../src/layout/layout';
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
  it('lays out dedicated fridge and windlass banks with their relay control wiring', async () => {
    const p = exampleProject();
    p.equipment.push(newEquipment('battery-bank', { name: 'Fridge battery', zone: 'galley', props: { role: 'fridge', units: 1 } }));
    p.equipment.push(newEquipment('battery-bank', { name: 'Bow battery', zone: 'bow', props: { role: 'windlass', units: 1 } }));
    const d = generateIdeal(p);
    for (const lv of [layers, { ...layers, panelLoads: 'collapse' as const }, { ...layers, signal: false }]) {
      const l = await autoLayout(d, lv);
      expect(l.nodes.some((n) => n.node.id === 'fr-bat')).toBe(true);
      expect(l.edges.every((e) => e.points && e.points.length >= 2)).toBe(true);
    }
  });
  it('routes the diode isolator compensation wire for both methods', async () => {
    for (const how of ['excite', 'sense']) {
      const p = exampleProject();
      Object.assign(p.equipment.find((e) => e.kind === 'engine')!.props, { chargeSplit: 'isolator-diode', isolatorSense: how });
      const d = generateIdeal(p);
      const l = await autoLayout(d, layers);
      const comp = d.wires.find((w) => w.notes?.includes('isolator-compensation'))!;
      const e = l.edges.find((x) => x.wire.id === comp.id);
      expect(e?.points?.length ?? 0).toBeGreaterThanOrEqual(2);
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
  it('hides fuses by drawing wires straight through them', async () => {
    const p = exampleProject();
    for (const sc of p.scenarios) {
      const d = generateIdeal(p, sc);
      const fuses = d.nodes.filter((n) => n.type === 'fuse');
      expect(fuses.length).toBeGreaterThan(3);
      const v = visibleSubset(d, { ...layers, fuses: false });
      const shown = new Set(v.nodes.map((n) => n.id));
      // every visible wire connects two visible nodes, ids stay unique and real
      expect(v.wires.every((w) => shown.has(w.from.node) && shown.has(w.to.node))).toBe(true);
      expect(new Set(v.wires.map((w) => w.id)).size).toBe(v.wires.length);
      const realIds = new Set(d.wires.map((w) => w.id));
      expect(v.wires.every((w) => realIds.has(w.id))).toBe(true);
      // most fuses fold away, and each folded fuse is recorded on its wire
      const remaining = v.nodes.filter((n) => n.type === 'fuse').length;
      expect(remaining).toBeLessThan(fuses.length / 4);
      const via = v.wires.filter((w) => w.viaFuse).map((w) => w.viaFuse);
      expect(via.length).toBe(fuses.length - remaining);
      const l = await autoLayout(d, { ...layers, fuses: false });
      expect(l.edges.every((e) => e.points && e.points.length >= 2)).toBe(true);
    }
  });
});
