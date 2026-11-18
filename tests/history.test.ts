import { describe, expect, it } from 'vitest';
import { paletteNode } from '../src/engine/existing';
import { blankProject, exampleProject, newEquipment } from '../src/model/examples';
import type { Design, Project } from '../src/model/types';
import { describeChange } from '../src/state/changes';
import { BURST_MS, History, HISTORY_LIMIT, type Snapshot } from '../src/state/history';

const clone = <T,>(x: T): T => structuredClone(x);
const edit = (p: Project, fn: (p: Project) => void): Project => {
  const c = clone(p);
  fn(c);
  return c;
};
const drawing = (): Design => ({ id: 'existing', name: 'Existing', systemVoltage: 12, nodes: [], wires: [], findings: [] });

describe('describeChange', () => {
  const p = exampleProject();
  const fridge = p.equipment.find((e) => e.kind === 'fridge')!;

  it('names equipment that was removed, added or edited', () => {
    expect(describeChange(p, edit(p, (x) => void (x.equipment = x.equipment.filter((e) => e.id !== fridge.id))))).toEqual({ label: `Removed ${fridge.name}`, destructive: true });
    const added = edit(p, (x) => void x.equipment.push(newEquipment('fans', { name: 'Galley fan' })));
    expect(describeChange(p, added)).toEqual({ label: 'Added Galley fan' });
    const edited = edit(p, (x) => void (x.equipment.find((e) => e.id === fridge.id)!.props.watts = 75));
    expect(describeChange(p, edited)).toEqual({ label: `Edited ${fridge.name}`, mergeKey: `eq:${fridge.id}` });
  });

  it('treats a different boat as one replaceable step', () => {
    expect(describeChange(p, blankProject())).toMatchObject({ label: 'Started a new boat', destructive: true });
    const other = exampleProject();
    other.profile.name = 'Wanderer';
    expect(describeChange(blankProject(), other)).toMatchObject({ label: 'Opened Wanderer', destructive: true });
  });

  it('describes boat settings, zones and scenarios', () => {
    expect(describeChange(p, edit(p, (x) => void (x.profile.name = 'Sea Otter')))).toEqual({ label: 'Changed boat settings', mergeKey: 'profile' });
    const zone = p.profile.zones[0];
    expect(describeChange(p, edit(p, (x) => void x.profile.zones.shift()))).toEqual({ label: `Removed the zone ${zone.name}`, destructive: true });
    expect(describeChange(p, edit(p, (x) => void x.scenarios.push({ id: 'new', name: 'Scenario 4' })))).toEqual({ label: 'Added a scenario' });
  });

  it('ignores a change of which scenario is on screen', () => {
    expect(describeChange(p, { ...p, activeScenario: p.scenarios[1].id })).toBeNull();
    expect(describeChange(p, p)).toBeNull();
  });

  it('describes the existing-boat drawing', () => {
    const withDrawing = edit(p, (x) => void (x.existing = drawing()));
    expect(describeChange(p, withDrawing)).toEqual({ label: 'Started the existing-boat drawing' });
    expect(describeChange(withDrawing, p)).toEqual({ label: 'Discarded the existing-boat drawing', destructive: true });

    const fuse = paletteNode('fuse', 'battery');
    const bat = paletteNode('battery', 'battery');
    const two = edit(withDrawing, (x) => void x.existing!.nodes.push(bat, fuse));
    const one = edit(two, (x) => void x.existing!.nodes.pop());
    expect(describeChange(one, two)).toEqual({ label: 'Added Fuse' });
    expect(describeChange(two, one)).toEqual({ label: 'Deleted Fuse', destructive: true });

    const wired = edit(two, (x) => void x.existing!.wires.push({ id: 'w1', kind: 'pos', domain: 'dc', from: { node: bat.id, term: 'pos' }, to: { node: fuse.id, term: 'in' }, lengthFt: 0.5 }));
    expect(describeChange(two, wired)).toEqual({ label: 'Drew a wire' });
    expect(describeChange(wired, two)).toEqual({ label: 'Deleted a wire', destructive: true });
    expect(describeChange(wired, edit(wired, (x) => void (x.existing!.wires[0].gauge = '2')))).toEqual({ label: 'Edited a wire', mergeKey: 'wire:w1' });

    const moved = edit(two, (x) => void (x.existing!.nodes[1].pos = { x: 300, y: 40 }));
    expect(describeChange(two, moved)).toEqual({ label: 'Moved Fuse', mergeKey: `move:${fuse.id}` });
    const rated = edit(two, (x) => void (x.existing!.nodes[1].data.rating = 250));
    expect(describeChange(two, rated)).toEqual({ label: 'Edited Fuse', mergeKey: `node:${fuse.id}` });
  });

  it('names an edited item as it was before the edit, so a rename in progress reads sensibly', () => {
    const renamed = edit(p, (x) => void (x.equipment.find((e) => e.id === fridge.id)!.name = 'F'));
    expect(describeChange(p, renamed)?.label).toBe(`Edited ${fridge.name}`);
  });

  it('describes the trace-over diagram without comparing the image by value when it is shared', () => {
    const u = { src: 'data:image/webp;base64,AAAA', name: 'a.png', x: 0, y: 0, width: 100, height: 50, opacity: 0.5, visible: true, locked: false };
    const base = edit(p, (x) => void (x.existing = { ...drawing(), underlay: u }));
    expect(describeChange(edit(p, (x) => void (x.existing = drawing())), base)).toEqual({ label: 'Added a trace-over diagram' });
    expect(describeChange(base, edit(base, (x) => void (x.existing!.underlay!.opacity = 0.8)))).toEqual({ label: 'Adjusted the trace-over diagram', mergeKey: 'underlay' });
    expect(describeChange(base, edit(base, (x) => void delete x.existing!.underlay))).toEqual({ label: 'Removed the trace-over diagram', destructive: true });
  });
});

describe('History', () => {
  const snap = (n: number): Snapshot => ({ project: { n } as unknown as Project });
  const n = (s: Snapshot | undefined) => (s?.project as unknown as { n: number } | undefined)?.n;

  it('undoes and redoes in order', () => {
    const h = new History();
    h.record(snap(0), { label: 'A' }, 0);
    h.record(snap(1), { label: 'B' }, 5000);
    expect(h.undoLabel).toBe('B');
    const u1 = h.undo(snap(2))!;
    expect([n(u1.snapshot), u1.label]).toEqual([1, 'B']);
    expect(h.redoLabel).toBe('B');
    const u2 = h.undo(snap(1))!;
    expect([n(u2.snapshot), u2.label]).toEqual([0, 'A']);
    expect(h.undo(snap(0))).toBeNull();
    const r1 = h.redo(snap(0))!;
    expect([n(r1.snapshot), r1.label]).toEqual([1, 'A']);
    const r2 = h.redo(snap(1))!;
    expect([n(r2.snapshot), r2.label]).toEqual([2, 'B']);
    expect(h.redo(snap(2))).toBeNull();
  });

  it('a new change clears redo', () => {
    const h = new History();
    h.record(snap(0), { label: 'A' }, 0);
    h.undo(snap(1));
    expect(h.redoLabel).toBe('A');
    h.record(snap(0), { label: 'C' }, 9000);
    expect(h.redoLabel).toBeUndefined();
  });

  it('collapses a burst of edits to the same thing into one step', () => {
    const h = new History();
    for (let i = 0; i < 5; i++) h.record(snap(i), { label: 'Edited Fridge', mergeKey: 'eq:1' }, i * 200);
    expect(h.past).toHaveLength(1);
    expect(n(h.undo(snap(5))!.snapshot)).toBe(0);
  });

  it('starts a new step after a pause, for a different thing, or for a discrete action', () => {
    const h = new History();
    h.record(snap(0), { label: 'Edited Fridge', mergeKey: 'eq:1' }, 0);
    h.record(snap(1), { label: 'Edited Fridge', mergeKey: 'eq:1' }, BURST_MS + 1);
    h.record(snap(2), { label: 'Edited Fans', mergeKey: 'eq:2' }, BURST_MS + 2);
    h.record(snap(3), { label: 'Removed Fans', destructive: true }, BURST_MS + 3);
    h.record(snap(4), { label: 'Removed Fridge', destructive: true }, BURST_MS + 4);
    expect(h.past.map((s) => s.label)).toEqual(['Edited Fridge', 'Edited Fridge', 'Edited Fans', 'Removed Fans', 'Removed Fridge']);
  });

  it('does not merge an edit made straight after an undo into the step before it', () => {
    const h = new History();
    h.record(snap(0), { label: 'Edited Fridge', mergeKey: 'eq:1' }, 0);
    h.record(snap(1), { label: 'Removed Fans' }, 10);
    h.undo(snap(2));
    h.record(snap(1), { label: 'Edited Fridge', mergeKey: 'eq:1' }, 20);
    expect(h.past).toHaveLength(2);
  });

  it('keeps a bounded number of steps', () => {
    const h = new History();
    for (let i = 0; i < HISTORY_LIMIT + 20; i++) h.record(snap(i), { label: `step ${i}` }, i * 5000);
    expect(h.past).toHaveLength(HISTORY_LIMIT);
    expect(h.past[0].label).toBe('step 20');
  });
});
