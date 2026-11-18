// Describe the difference between two versions of a project in words a boat owner would use.
// Used to label undo steps and to decide which rapid edits belong together.

import { BLANK_NAME } from '../model/examples';
import type { Design, Project } from '../model/types';

export interface Change {
  /** Past-tense description, e.g. "Removed Fridge". */
  label: string;
  /** Edits with the same key made in quick succession are one undo step (typing, dragging a slider). */
  mergeKey?: string;
  /** Something was taken away or replaced. The user is offered an immediate Undo. */
  destructive?: boolean;
}

const same = (a: unknown, b: unknown) => a === b || JSON.stringify(a) === JSON.stringify(b);
const ids = <T extends { id: string }>(list: T[]) => new Set(list.map((x) => x.id));

/** What changed from `a` to `b`, or null when nothing worth an undo step did (e.g. only the scenario being viewed). */
export function describeChange(a: Project, b: Project): Change | null {
  if (a === b) return null;

  // A different boat altogether: New boat, example, opened file or cloud boat.
  const shared = a.equipment.some((e) => ids(b.equipment).has(e.id));
  if (!shared && (a.equipment.length > 0 || b.equipment.length > 0) && !same(a.profile, b.profile)) {
    const blank = b.equipment.length <= 1 && b.profile.name === BLANK_NAME;
    return { label: blank ? 'Started a new boat' : `Opened ${b.profile.name || 'another boat'}`, destructive: true };
  }

  // A zone removed (its equipment may have been moved elsewhere in the same step)
  const zonesLeft = ids(b.profile.zones);
  const zoneGone = a.profile.zones.find((z) => !zonesLeft.has(z.id));
  if (zoneGone) return { label: `Removed the zone ${zoneGone.name}`, destructive: true };

  // Equipment
  if (a.equipment !== b.equipment) {
    const before = ids(a.equipment);
    const after = ids(b.equipment);
    const added = b.equipment.filter((e) => !before.has(e.id));
    const removed = a.equipment.filter((e) => !after.has(e.id));
    if (removed.length) return { label: removed.length === 1 ? `Removed ${removed[0].name}` : `Removed ${removed.length} items`, destructive: true };
    if (added.length) return { label: added.length === 1 ? `Added ${added[0].name}` : `Added ${added.length} items` };
    // Named as it was before the edit: that is the name the user knows, even mid-rename.
    const edited = a.equipment.find((e) => !same(e, b.equipment.find((x) => x.id === e.id)));
    if (edited) return { label: `Edited ${edited.name}`, mergeKey: `eq:${edited.id}` };
  }

  // Boat settings and zones
  if (!same(a.profile, b.profile)) {
    const za = ids(a.profile.zones);
    const fresh = b.profile.zones.filter((z) => !za.has(z.id));
    if (fresh.length) return { label: 'Added a zone' };
    return { label: 'Changed boat settings', mergeKey: 'profile' };
  }

  // Scenarios
  if (!same(a.scenarios, b.scenarios)) {
    if (b.scenarios.length < a.scenarios.length) {
      const sb = ids(b.scenarios);
      return { label: `Removed the scenario ${a.scenarios.find((s) => !sb.has(s.id))?.name ?? ''}`.trim(), destructive: true };
    }
    if (b.scenarios.length > a.scenarios.length) return { label: 'Added a scenario' };
    const edited = b.scenarios.find((s) => !same(s, a.scenarios.find((x) => x.id === s.id)));
    return { label: `Changed the scenario ${edited?.name ?? ''}`.trim(), mergeKey: `scenario:${edited?.id}` };
  }

  // Existing-boat drawing
  if (a.existing !== b.existing) {
    const c = describeDrawing(a.existing, b.existing);
    if (c) return c;
  }

  // Only which scenario is on screen changed: that is navigation, not an edit.
  return null;
}

/** What to call a component in a sentence. A note's label is its whole text, so it is just "a note". */
const called = (n: { type: string; label: string }) => (n.type === 'note' ? 'a note' : n.label);

function describeDrawing(a: Design | undefined, b: Design | undefined): Change | null {
  if (!a && !b) return null;
  if (!a) return { label: 'Started the existing-boat drawing' };
  if (!b) return { label: 'Discarded the existing-boat drawing', destructive: true };

  const na = ids(a.nodes);
  const nb = ids(b.nodes);
  const removedNodes = a.nodes.filter((n) => !nb.has(n.id));
  if (removedNodes.length) return { label: removedNodes.length === 1 ? `Deleted ${called(removedNodes[0])}` : `Deleted ${removedNodes.length} components`, destructive: true };
  const addedNodes = b.nodes.filter((n) => !na.has(n.id));
  if (addedNodes.length) return { label: addedNodes.length === 1 ? `Added ${called(addedNodes[0])}` : `Added ${addedNodes.length} components` };

  const wa = ids(a.wires);
  const wb = ids(b.wires);
  const removedWires = a.wires.filter((w) => !wb.has(w.id)).length;
  if (removedWires) return { label: removedWires === 1 ? 'Deleted a wire' : `Deleted ${removedWires} wires`, destructive: true };
  if (b.wires.some((w) => !wa.has(w.id))) return { label: 'Drew a wire' };

  // The trace-over picture: compare by reference and by fields, never by serialising the image.
  const ua = a.underlay;
  const ub = b.underlay;
  if (ua && !ub) return { label: 'Removed the trace-over diagram', destructive: true };
  if (!ua && ub) return { label: 'Added a trace-over diagram' };
  if (ua && ub) {
    if (ua.src !== ub.src) return { label: 'Replaced the trace-over diagram', destructive: true };
    if (ua.x !== ub.x || ua.y !== ub.y || ua.width !== ub.width || ua.height !== ub.height || ua.opacity !== ub.opacity || ua.visible !== ub.visible || ua.locked !== ub.locked) {
      return { label: 'Adjusted the trace-over diagram', mergeKey: 'underlay' };
    }
  }

  const changedNodes = a.nodes.filter((n) => !same(n, b.nodes.find((x) => x.id === n.id)));
  if (changedNodes.length) {
    const onlyMoved = changedNodes.every((n) => {
      const o = b.nodes.find((x) => x.id === n.id)!;
      return same({ ...n, pos: undefined }, { ...o, pos: undefined });
    });
    if (onlyMoved) {
      return changedNodes.length === 1
        ? { label: `Moved ${called(changedNodes[0])}`, mergeKey: `move:${changedNodes[0].id}` }
        : { label: `Moved ${changedNodes.length} components`, mergeKey: `move:${changedNodes.map((n) => n.id).join(',')}` };
    }
    return changedNodes.length === 1 ? { label: `Edited ${called(changedNodes[0])}`, mergeKey: `node:${changedNodes[0].id}` } : { label: 'Edited the drawing' };
  }
  const changedWire = b.wires.find((w) => !same(w, a.wires.find((x) => x.id === w.id)));
  if (changedWire) {
    const was = a.wires.find((x) => x.id === changedWire.id)!;
    if (!same(was.from, changedWire.from) || !same(was.to, changedWire.to)) return { label: 'Moved a wire end' };
    return { label: 'Edited a wire', mergeKey: `wire:${changedWire.id}` };
  }
  return null;
}
