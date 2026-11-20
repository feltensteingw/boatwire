import { produce } from 'immer';
import { create } from 'zustand';
import { createJSONStorage, persist, type StateStorage } from 'zustand/middleware';
import { exampleProject, blankProject, newEquipment, uid } from '../model/examples';
import { joinTerminals } from '../engine/connect';
import { growTerminal, terminal } from '../model/nodeDefs';
import type { Design, DNode, EnergyAssumptions, Equipment, EquipmentKind, LayerSettings, Project, Scenario, Wire, WireEnd } from '../model/types';
import { draftRunLength } from '../engine/existing';
import { DEFAULT_CURRENCY, priceDef, type PriceOverrides } from '../model/prices';
import { clampAssumption } from '../engine/energy';
import { ENERGY_ASSUMPTIONS } from '../model/standards';
import type { ThemeId } from '../ui/themes';
import { parseProject } from '../model/validate';
import { removeZone } from '../model/zones';
import { storable } from './imageStore';
import { nudge, paste, reconnect, removeItems, type Clip } from '../engine/drawing';
import { stashUnreadable, useRecovery } from './recovery';
import type { CloudBase } from '../cloud/sync';

export type View = 'ideal' | 'existing' | 'compare' | 'reports';
export type ReportTab = 'findings' | 'changes' | 'wires' | 'bom' | 'energy' | 'full';
export type Selection = { kind: 'node' | 'wire'; id: string; design: 'ideal' | 'existing' } | null;

export const DEFAULT_LAYERS: LayerSettings = {
  dc: true,
  ac: true,
  negatives: 'full',
  panelLoads: 'show',
  fuses: true,
  signal: true,
  grounding: false,
  idealDiff: true,
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
  /** What this browser last knew to be in the cloud for that boat. Used to notice changes from other devices. */
  cloudBase?: CloudBase;
  /** Link the open boat to a cloud boat (or unlink it with undefined). */
  setCloudId(id: string | undefined, base?: CloudBase): void;
  setCloudBase(base: CloudBase | undefined): void;

  setView(v: View): void;
  setReportTab(t: ReportTab): void;
  setReportDesign(d: 'ideal' | 'existing'): void;
  setLayers(fn: (l: LayerSettings) => LayerSettings): void;
  select(s: Selection): void;
  relayout(): void;

  loadProject(p: Project, cloudId?: string, cloudBase?: CloudBase): void;
  newProject(): void;
  loadExample(): void;

  updateProfile(fn: (p: Project['profile']) => void): void;
  /** Set the owner's price for a price-list entry; undefined goes back to the default. */
  setPrice(key: string, value: number | undefined): void;
  setCurrency(symbol: string): void;
  resetPrices(): void;
  /**
   * Change energy-budget assumptions: for the whole boat, or for one scenario only.
   * A value of undefined, or one equal to what it would be anyway, removes the owner's setting.
   */
  setEnergy(patch: Partial<Record<keyof EnergyAssumptions, number | undefined>>, scenarioId?: string): void;
  /** Back to the defaults (boat), or back to the boat's values (scenario). */
  resetEnergy(scenarioId?: string): void;
  /** Remove a zone, first moving whatever is located in it to `moveTo`. */
  removeZone(id: string, moveTo?: string): void;
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
  /** Remove several components and wires from the drawing at once. */
  removeFromExisting(nodeIds: string[], wireIds: string[]): void;
  nudgeExisting(nodeIds: string[], dx: number, dy: number): void;
  /** Add copies to the drawing; returns the new components' ids. */
  pasteExisting(clip: Clip, offset: { x: number; y: number }): string[];
  /** Move one end of a wire to another terminal, if the two may be joined. */
  reconnectExisting(wireId: string, end: 'from' | 'to', to: WireEnd): { ok: true } | { ok: false; why: string };
}

const VIEW_IDS: View[] = ['ideal', 'existing', 'compare', 'reports'];

/** Drop the parts of the owner's price list that say nothing, so an untouched list is simply absent. */
function tidyPrices(p: PriceOverrides): PriceOverrides | undefined {
  const out: PriceOverrides = {};
  if (p.currency && p.currency !== DEFAULT_CURRENCY) out.currency = p.currency;
  if (p.rates && Object.keys(p.rates).length) out.rates = p.rates;
  return out.currency || out.rates ? out : undefined;
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

/**
 * Make a changed copy of the project. Only the parts that are changed are copied (immer); the
 * rest, including the trace-over picture, is shared with the previous version. That keeps edits
 * and the undo history cheap, and lets screens that depend on one part ignore changes to another.
 */
const mutate = (p: Project, fn: (p: Project) => void): Project =>
  produce(p, (draft) => {
    fn(draft as Project);
  });

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
      cloudBase: undefined,
      setCloudId: (cloudId, cloudBase) => set({ cloudId, cloudBase }),
      setCloudBase: (cloudBase) => set({ cloudBase }),

      setView: (view) => set({ view, selection: null }),
      setReportTab: (reportTab) => set({ reportTab }),
      setReportDesign: (reportDesign) => set({ reportDesign }),
      setLayers: (fn) => set({ layers: fn(get().layers) }),
      select: (selection) => set({ selection }),
      relayout: () => set({ layoutNonce: get().layoutNonce + 1 }),

      loadProject: (project, cloudId, cloudBase) => set({ project, cloudId, cloudBase, selection: null }),
      newProject: () => set({ project: blankProject(), cloudId: undefined, cloudBase: undefined, selection: null, view: 'ideal' }),
      loadExample: () => set({ project: exampleProject(), cloudId: undefined, cloudBase: undefined, selection: null, view: 'ideal' }),

      updateProfile: (fn) => set({ project: mutate(get().project, (p) => fn(p.profile)) }),
      setPrice: (key, value) =>
        set({
          project: mutate(get().project, (p) => {
            const rates = { ...(p.prices?.rates ?? {}) };
            // a price equal to the default is not a change worth keeping
            if (value === undefined || !Number.isFinite(value) || value < 0 || value === priceDef(key)?.usd) delete rates[key];
            else rates[key] = value;
            p.prices = tidyPrices({ ...p.prices, rates });
          }),
        }),
      setCurrency: (symbol) =>
        set({
          project: mutate(get().project, (p) => {
            p.prices = tidyPrices({ ...p.prices, currency: symbol.trim().slice(0, 4) });
          }),
        }),
      setEnergy: (patch, scenarioId) =>
        set({
          project: mutate(get().project, (p) => {
            const scen = scenarioId ? p.scenarios.find((s) => s.id === scenarioId) : undefined;
            if (scenarioId && !scen) return;
            const next: Partial<EnergyAssumptions> = { ...((scen ? scen.energy : p.energy) ?? {}) };
            for (const [k, v] of Object.entries(patch) as [keyof EnergyAssumptions, number | undefined][]) {
              // what the value would be without this setting: the boat's value for a scenario, the default for the boat
              const inherited = scen ? clampAssumption(k, p.energy?.[k]) : ENERGY_ASSUMPTIONS[k];
              if (v === undefined || !Number.isFinite(v) || clampAssumption(k, v) === inherited) delete next[k];
              else next[k] = clampAssumption(k, v);
            }
            const kept = Object.keys(next).length ? next : undefined;
            if (scen) {
              if (kept) scen.energy = kept;
              else delete scen.energy;
            } else if (kept) p.energy = kept;
            else delete p.energy;
          }),
        }),
      resetEnergy: (scenarioId) =>
        set({
          project: mutate(get().project, (p) => {
            if (!scenarioId) delete p.energy;
            else delete p.scenarios.find((s) => s.id === scenarioId)?.energy;
          }),
        }),
      resetPrices: () =>
        set({
          project: mutate(get().project, (p) => {
            delete p.prices;
          }),
        }),
      removeZone: (id, moveTo) => set({ project: mutate(get().project, (p) => removeZone(p, id, moveTo)) }),
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
      removeFromExisting: (nodeIds, wireIds) =>
        set({
          project: mutate(get().project, (p) => {
            if (p.existing) removeItems(p.existing, nodeIds, wireIds);
          }),
          selection: null,
        }),
      nudgeExisting: (nodeIds, dx, dy) =>
        set({
          project: mutate(get().project, (p) => {
            if (p.existing) nudge(p.existing, nodeIds, dx, dy);
          }),
        }),
      pasteExisting: (clip, offset) => {
        let made: string[] = [];
        set({
          project: mutate(get().project, (p) => {
            if (p.existing) made = paste(p.existing, clip, offset);
          }),
          selection: null,
        });
        return made;
      },
      reconnectExisting: (wireId, end, to) => {
        let result: { ok: true } | { ok: false; why: string } = { ok: false, why: 'There is no drawing.' };
        const project = mutate(get().project, (p) => {
          if (p.existing) result = reconnect(p.existing, wireId, end, to);
        });
        // only an accepted move changes the boat (and becomes an undo step)
        if (result.ok) set({ project });
        return result;
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
      // The trace-over picture is kept in IndexedDB; the stored project holds a reference to it (see imageStore.ts).
      partialize: (s) => ({ project: storable(s.project), layers: s.layers, view: s.view, cloudId: s.cloudId, cloudBase: s.cloudBase, theme: s.theme }),
      // Never trust what comes back from storage: check and repair the project, and fall back to
      // a safe value for anything else that is not what it should be.
      merge: (stored, current) => {
        if (typeof stored !== 'object' || stored === null) return current;
        const s = stored as Partial<State>;
        const next = { ...current };
        try {
          const { project, notes } = parseProject(s.project, { storedImages: true });
          next.project = project;
          if (notes.length) useRecovery.setState({ notes });
        } catch (e) {
          stashUnreadable(JSON.stringify(s.project ?? null), (e as Error).message);
        }
        if (typeof s.layers === 'object' && s.layers !== null) next.layers = { ...DEFAULT_LAYERS, ...s.layers, labels: { ...DEFAULT_LAYERS.labels, ...(s.layers.labels ?? {}) } };
        if (s.view && VIEW_IDS.includes(s.view)) next.view = s.view;
        if (typeof s.cloudId === 'string') {
          next.cloudId = s.cloudId;
          const b = s.cloudBase;
          if (b && typeof b.rev === 'number' && typeof b.sig === 'string') next.cloudBase = { rev: b.rev, sig: b.sig };
        }
        if (typeof s.theme === 'string') next.theme = s.theme;
        return next;
      },
    },
  ),
);
