// Undo / redo for the boat project.
//
// Every change to the project in the store is recorded as "the state before it" plus a label.
// Rapid edits to the same thing (typing a name, dragging a slider) collapse into one step.
// History lives for the browser session only; it is not saved.

import { create } from 'zustand';
import type { CloudBase } from '../cloud/sync';
import type { Project } from '../model/types';
import { describeChange, type Change } from './changes';
import { useStore } from './store';
import { toast, useToasts } from '../ui/toastStore';

/** What undo restores. The cloud link travels with the project, so undoing "New boat" re-links the saved boat. */
export interface Snapshot {
  project: Project;
  cloudId?: string;
  cloudBase?: CloudBase;
}

/**
 * Apply a change that did not come from the user (a newer version arriving from another device).
 * It is not an undo step, and the steps recorded so far are dropped: each holds a whole earlier
 * boat, so undoing one would silently wipe out the other device's work.
 */
export function applyOutsideChange(change: () => void) {
  restoring = true;
  try {
    change();
  } finally {
    restoring = false;
  }
  history.past = [];
  history.future = [];
  hush();
  publish();
}

interface Step {
  snapshot: Snapshot;
  label: string;
  mergeKey?: string;
}

export const HISTORY_LIMIT = 50;
/** Edits to the same thing closer together than this are one step. */
export const BURST_MS = 1000;

/** The undo and redo stacks. No store or DOM access, so it is unit-tested directly. */
export class History {
  past: Step[] = [];
  future: Step[] = [];
  private lastAt = -Infinity;

  /** Note that the project changed away from `before`. */
  record(before: Snapshot, change: Change, now: number) {
    const top = this.past[this.past.length - 1];
    const burst = !!change.mergeKey && top?.mergeKey === change.mergeKey && now - this.lastAt < BURST_MS;
    this.lastAt = now;
    this.future = [];
    if (burst) return; // still the same edit: keep the state from before it started
    this.past.push({ snapshot: before, label: change.label, mergeKey: change.mergeKey });
    if (this.past.length > HISTORY_LIMIT) this.past.shift();
  }

  /** The next change starts a step of its own, however soon it comes. */
  cut() {
    this.lastAt = -Infinity;
  }

  /** Step back. Returns the state to restore and what was undone, or null at the start of history. */
  undo(current: Snapshot): { snapshot: Snapshot; label: string } | null {
    const step = this.past.pop();
    if (!step) return null;
    this.future.push({ snapshot: current, label: step.label });
    this.lastAt = -Infinity; // the next edit always starts a new step
    return { snapshot: step.snapshot, label: step.label };
  }

  redo(current: Snapshot): { snapshot: Snapshot; label: string } | null {
    const step = this.future.pop();
    if (!step) return null;
    this.past.push({ snapshot: current, label: step.label });
    this.lastAt = -Infinity;
    return { snapshot: step.snapshot, label: step.label };
  }

  get undoLabel() {
    return this.past[this.past.length - 1]?.label;
  }
  get redoLabel() {
    return this.future[this.future.length - 1]?.label;
  }
}

// ---------------------------------------------------------------- wiring to the app store

const history = new History();
let restoring = false;

/** What the Undo / Redo buttons show. */
export const useHistory = create<{ undoLabel?: string; redoLabel?: string }>(() => ({}));
const publish = () => useHistory.setState({ undoLabel: history.undoLabel, redoLabel: history.redoLabel }, true);

// Only the latest history message stays up. An "Undo" button left over from an earlier change
// would otherwise undo something other than what it says.
let shown: number | undefined;
function say(message: string, opts?: Parameters<typeof toast>[1]) {
  if (shown !== undefined) useToasts.getState().dismiss(shown);
  shown = toast(message, opts);
}
function hush() {
  if (shown !== undefined) useToasts.getState().dismiss(shown);
  shown = undefined;
}

// The store has already loaded the saved project by the time this module runs, so loading is not recorded.
useStore.subscribe((s, prev) => {
  if (restoring || s.project === prev.project) return;
  let change: Change | null;
  try {
    change = describeChange(prev.project, s.project);
  } catch {
    // A project too damaged to describe must still be undoable, and must never break the edit itself.
    change = { label: 'Changed the boat' };
  }
  if (!change) return;
  history.record({ project: prev.project, cloudId: prev.cloudId, cloudBase: prev.cloudBase }, change, Date.now());
  publish();
  // Removing or replacing something is done at once and can be taken back, rather than asked about first.
  if (change.destructive) say(change.label, { action: { label: 'Undo', run: undo }, ms: 12000 });
  else hush();
});

function restore(step: { snapshot: Snapshot; label: string } | null, verb: string) {
  if (!step) return;
  restoring = true;
  try {
    const { cloudId, cloudBase } = useStore.getState();
    // Same cloud boat before and after: what we know about the cloud copy is still current, so keep it.
    // A different boat (undoing "New boat" or "Open"): go back to what was known about that one.
    const base = step.snapshot.cloudId === cloudId ? cloudBase : step.snapshot.cloudBase;
    useStore.setState({ project: step.snapshot.project, cloudId: step.snapshot.cloudId, cloudBase: base, selection: null });
  } finally {
    restoring = false;
  }
  publish();
  say(`${verb}: ${step.label}`);
}

const current = (): Snapshot => {
  const s = useStore.getState();
  return { project: s.project, cloudId: s.cloudId, cloudBase: s.cloudBase };
};

/** Make the next change its own undo step (a one-click action such as "Size wires & fuses"). */
export function startNewStep() {
  history.cut();
}

export function undo() {
  restore(history.undo(current()), 'Undid');
}

export function redo() {
  restore(history.redo(current()), 'Redid');
}
