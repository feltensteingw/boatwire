import { create } from 'zustand';
import { createJSONStorage, persist, type StateStorage } from 'zustand/middleware';
import { exampleProject, blankProject, newEquipment, uid } from '../model/examples';
import { joinTerminals } from '../engine/connect';
import { growTerminal, terminal } from '../model/nodeDefs';
import type { Design, DNode, Equipment, EquipmentKind, LayerSettings, Project, Scenario, Wire, WireEnd } from '../model/types';
import { draftRunLength } from '../engine/existing';
import type { ThemeId } from '../ui/themes';
import { parseProject } from '../model/validate';
import { stashUnreadable, useRecovery } from './recovery';

export type View = 'ideal' | 'existing' | 'compare' | 'reports';
const VIEW_IDS: View[] = ['ideal', 'existing', 'compare', 'reports'];
export type ReportTab = 'findings' | 'changes' | 'wires' | 'bom' | 'energy';
export type Selection = { kind: 'node' | 'wire'; id: string; design: 'ideal' | 'existing' } | null;

export const DEFAULT_LAYERS: LayerSettings = {
  dc: true,
  ac: true,
  negatives: 'full',
  panelLoads: 'show',
  fuses: true,
  signal: true,
  grounding: false,
  labels: { gauge: true, protection: false, current: false, length: false, vdrop: false, parts: false },
};

interface State {
  project: Project;
  view: View;
  reportTab: ReportTab;
  reportDesign: 'ideal' | 'existing';
  layers: LayerSettings;
  /** Colour scheme; 'auto' follows the operating system light/dark setting. */
  theme: ThemeId;
  setTheme(t: ThemeId): void;
  selection: Selection;
  /** Bumped to ask the diagram to re-run auto layout. */
  layoutNonce: number;
  /** Firestore document id of the boat being edited (undefined = local only). */
  cloudId?: string;
  setCloudId(id: string | undefined): void;

  setView(v: View): void;
  setReportTab(t: ReportTab): void;
  setReportDesign(d: 'ideal' | 'existing'): void;
  setLayers(fn: (l: LayerSettings) => LayerSettings): void;
  select(s: Selection): void;
  relayout(): void;

  loadProject(p: Project, cloudId?: string): void;
  newProject(): void;
  loadExample(): void;

  updateProfile(fn: (p: Project['profile']) => void): void;
  addEquipment(kind: EquipmentKind): string;
  updateEquipment(id: string, fn: (e: Equipment) => void): void;
  removeEquipment(id: string): void;
  duplicateEquipment(id: string): void;

  setScenario(id: string): void;
  addScenario(): void;
  updateScenario(id: string, patch: Partial<Scenario>): void;
  removeScenario(id: string): void;

  setExisting(d: Design | undefined): void;
  updateExisting(fn: (d: Design) => void): void;
  addExistingNode(n: DNode): void;
  connectExisting(a: WireEnd, b: WireEnd): void;
  deleteSelection(): void;
}

/**
 * Browser storage that survives its own contents. If what is stored is not even valid JSON, it is
 * set aside for the user to download and the app starts fresh instead of failing to start.
 */
const checkedStorage: StateStorage = {
  getItem: (name) => {
    let raw: string | null = null;
    try {
      raw = localStorage.getItem(name);
      if (raw !== null) JSON.parse(raw);
      return raw;
    } catch (e) {
      if (raw !== null) stashUnreadable(raw, `The saved data is damaged (${(e as Error).message}).`);
      return null;
    }
  },
  setItem: (name, value) => {
    try {
      localStorage.setItem(name, value);
      if (useRecovery.getState().notSaving) useRecovery.setState({ notSaving: undefined });
    } catch (e) {
      // Usually the browser's storage limit. Say so, instead of losing changes without a word.
      useRecovery.setState({ notSaving: (e as Error).name === 'QuotaExceededError' ? 'This browser has run out of storage space for BoatWire.' : `This browser would not store the boat (${(e as Error).message}).` });
    }
  },
  removeItem: (name) => {
    try {
      localStorage.removeItem(name);
    } catch {
      // nothing to remove from
    }
  },
};

const mutate = (p: Project, fn: (p: Project) => void): Project => {
  const copy: Project = structuredClone(p);
  // structuredClone makes a fresh copy of the trace-over image (hundreds of KB of text). Point the
  // copy back at the original string, so edits and the undo history all share one copy of it.
  if (p.existing?.underlay && copy.existing?.underlay) copy.existing.underlay.src = p.existing.underlay.src;
  fn(copy);
  return copy;
};

export const useStore = create<State>()(
  persist(
    (set, get) => ({
      project: exampleProject(),
      view: 'ideal',
      reportTab: 'findings',
      reportDesign: 'ideal',
      layers: DEFAULT_LAYERS,
      theme: 'auto',
      setTheme: (theme) => set({ theme }),
      selection: null,
      layoutNonce: 0,
      cloudId: undefined,
      setCloudId: (cloudId) => set({ cloudId }),

      setView: (view) => set({ view, selection: null }),
      setReportTab: (reportTab) => set({ reportTab }),
      setReportDesign: (reportDesign) => set({ reportDesign }),
      setLayers: (fn) => set({ layers: fn(get().layers) }),
      select: (selection) => set({ selection }),
      relayout: () => set({ layoutNonce: get().layoutNonce + 1 }),

      loadProject: (project, cloudId) => set({ project, cloudId, selection: null }),
      newProject: () => set({ project: blankProject(), cloudId: undefined, selection: null, view: 'ideal' }),
      loadExample: () => set({ project: exampleProject(), cloudId: undefined, selection: null, view: 'ideal' }),

      updateProfile: (fn) => set({ project: mutate(get().project, (p) => fn(p.profile)) }),
      addEquipment: (kind) => {
        const e = newEquipment(kind);
        set({ project: mutate(get().project, (p) => void p.equipment.push(e)) });
        return e.id;
      },
      updateEquipment: (id, fn) =>
        set({
          project: mutate(get().project, (p) => {
            const e = p.equipment.find((x) => x.id === id);
            if (e) fn(e);
          }),
        }),
      removeEquipment: (id) =>
        set({
          project: mutate(get().project, (p) => {
            p.equipment = p.equipment.filter((e) => e.id !== id);
          }),
          selection: null,
        }),
      duplicateEquipment: (id) =>
        set({
          project: mutate(get().project, (p) => {
            const i = p.equipment.findIndex((e) => e.id === id);
            if (i < 0) return;
            const c = structuredClone(p.equipment[i]);
            c.id = uid();
            c.name = `${c.name} (copy)`;
            p.equipment.splice(i + 1, 0, c);
          }),
        }),

      setScenario: (id) => set({ project: { ...get().project, activeScenario: id }, selection: null }),
      addScenario: () => {
        const id = uid('s');
        set({
          project: mutate(get().project, (p) => {
            const cur = p.scenarios.find((s) => s.id === p.activeScenario);
            p.scenarios.push({ ...(cur ?? {}), id, name: `Scenario ${p.scenarios.length + 1}` });
            p.activeScenario = id;
          }),
        });
      },
      updateScenario: (id, patch) =>
        set({
          project: mutate(get().project, (p) => {
            const s = p.scenarios.find((x) => x.id === id);
            if (!s) return;
            Object.assign(s, patch);
            for (const k of Object.keys(s) as (keyof Scenario)[]) if (s[k] === undefined) delete s[k];
          }),
        }),
      removeScenario: (id) =>
        set({
          project: mutate(get().project, (p) => {
            if (p.scenarios.length <= 1) return;
            p.scenarios = p.scenarios.filter((s) => s.id !== id);
            if (p.activeScenario === id) p.activeScenario = p.scenarios[0].id;
          }),
        }),

      setExisting: (d) => set({ project: { ...get().project, existing: d }, selection: null }),
      updateExisting: (fn) =>
        set({
          project: mutate(get().project, (p) => {
            if (p.existing) fn(p.existing);
          }),
        }),
      addExistingNode: (n) =>
        set({
          project: mutate(get().project, (p) => {
            p.existing ??= { id: 'existing', name: 'Existing', systemVoltage: p.profile.systemVoltage, nodes: [], wires: [], findings: [] };
            p.existing.nodes.push(n);
          }),
          selection: { kind: 'node', id: n.id, design: 'existing' },
        }),
      connectExisting: (a, b) => {
        const before = get().project.existing?.wires.length ?? 0;
        set({
          project: mutate(get().project, (p) => {
            const d = p.existing;
            if (!d) return;
            const na = d.nodes.find((n) => n.id === a.node);
            const nb = d.nodes.find((n) => n.id === b.node);
            if (!na || !nb) return;
            const ta = terminal(na, a.term);
            const tb = terminal(nb, b.term);
            const joined = joinTerminals(ta?.pol, tb?.pol);
            if (!joined.ok) return; // refused; the diagram tells the user why
            const pol = joined.kind;
            const w: Wire = {
              id: uid('w'),
              kind: pol,
              domain: pol === 'ac' || pol === 'gnd' ? 'ac' : 'dc',
              from: a,
              to: b,
              lengthFt: draftRunLength(p.profile, na, a.term, nb, b.term),
              lengthEstimated: true,
            };
            d.wires.push(w);
            // keep a free stud available on growable nodes
            for (const [n, t] of [[na, a.term], [nb, b.term]] as const) {
              if (!/^[sb]\d+$/.test(t)) continue;
              const free = n.terminals.filter((x) => /^[sb]\d+$/.test(x.id) && !d.wires.some((w2) => (w2.from.node === n.id && w2.from.term === x.id) || (w2.to.node === n.id && w2.to.term === x.id)));
              if (free.length === 0) {
                const side = terminal(n, t)?.side ?? 'E';
                const last = n.terminals.find((x) => x.id === t);
                growTerminal(n, { side, rating: last?.rating, label: last?.rating ? `${last.rating} A` : undefined });
              }
            }
          }),
        });
        // Open the new wire in the inspector straight away, so its size and length get entered while the user is looking at it.
        const wires = get().project.existing?.wires ?? [];
        if (wires.length > before) set({ selection: { kind: 'wire', id: wires[wires.length - 1].id, design: 'existing' } });
      },
      deleteSelection: () => {
        const s = get().selection;
        if (!s || s.design !== 'existing') return;
        set({
          project: mutate(get().project, (p) => {
            const d = p.existing;
            if (!d) return;
            if (s.kind === 'wire') d.wires = d.wires.filter((w) => w.id !== s.id);
            else {
              d.nodes = d.nodes.filter((n) => n.id !== s.id);
              d.wires = d.wires.filter((w) => w.from.node !== s.id && w.to.node !== s.id);
            }
          }),
          selection: null,
        });
      },
    }),
    {
      name: 'boatwire:v1',
      // Version of what is kept in browser storage (not of the project format, which has its own).
      // Raise it and extend `migrate` when the stored fields change.
      version: 1,
      migrate: (stored) => stored as never,
      storage: createJSONStorage(() => checkedStorage),
      partialize: (s) => ({ project: s.project, layers: s.layers, view: s.view, cloudId: s.cloudId, theme: s.theme }),
      // Never trust what comes back from storage: check and repair the project, and fall back to
      // a safe value for anything else that is not what it should be.
      merge: (stored, current) => {
        if (typeof stored !== 'object' || stored === null) return current;
        const s = stored as Partial<State>;
        const next = { ...current };
        try {
          const { project, notes } = parseProject(s.project);
          next.project = project;
          if (notes.length) useRecovery.setState({ notes });
        } catch (e) {
          stashUnreadable(JSON.stringify(s.project ?? null), (e as Error).message);
        }
        if (typeof s.layers === 'object' && s.layers !== null) next.layers = { ...DEFAULT_LAYERS, ...s.layers, labels: { ...DEFAULT_LAYERS.labels, ...(s.layers.labels ?? {}) } };
        if (s.view && VIEW_IDS.includes(s.view)) next.view = s.view;
        if (typeof s.cloudId === 'string') next.cloudId = s.cloudId;
        if (typeof s.theme === 'string') next.theme = s.theme;
        return next;
      },
    },
  ),
);
