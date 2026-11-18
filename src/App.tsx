import { lazy, Suspense, useEffect, useRef, useState } from 'react';
import { arrangePositions, autoLayout } from './layout/layout';
import { existingFromEquipment, existingFromIdeal, equipmentNode, paletteNode } from './engine/existing';
import { activeScenario } from './engine/scenario';
import { generateIdeal } from './engine/generate';
import { billOfMaterials, wireSchedule } from './engine/reports';
import { NODE_DEFS } from './model/nodeDefs';
import type { NodeType } from './model/types';
import { useExisting, useFindings, useIdeal } from './state/derived';
import { DEFAULT_LAYERS, useStore, type View } from './state/store';
import { Diagram } from './ui/Diagram';
import { Inspector } from './ui/Inspector';
import { downloadText, toCsv } from './ui/download';
import { Sidebar } from './ui/Sidebar';
import { Toggle } from './ui/fields';
import { CloudControls, CloudNotice, CloudSync } from './cloud/CloudControls';
import { THEMES, useApplyTheme, type ThemeId } from './ui/themes';
import { TipLayer } from './ui/Tips';
import { ToastLayer } from './ui/Toasts';
import { isNarrow, usePane } from './ui/panes';
import { DialogLayer, showMessage } from './ui/dialogs';
import { useMenu } from './ui/useMenu';
import { NewBoatWizard, useNewBoat } from './ui/NewBoat';
import { isUntouched } from './model/examples';
import { redo, undo, useHistory } from './state/history';
import { ErrorBoundary, RecoveryBanner } from './ui/ErrorBoundary';
import { parseProject } from './model/validate';
import { toast } from './ui/toastStore';
import { HelpButton, HelpGuide, HelpLink } from './ui/Help';
import { UNDERLAY_ACCEPT, underlayFromFile } from './ui/underlayFile';

// Compare and Reports load on first use to keep the initial download small.
const Compare = lazy(() => import('./ui/Compare').then((m) => ({ default: m.Compare })));
const Reports = lazy(() => import('./ui/Reports').then((m) => ({ default: m.Reports })));

const VIEWS: { id: View; label: string; tip: string }[] = [
  { id: 'ideal', label: 'Ideal design', tip: 'The best-practice wiring for your equipment list, drawn automatically. Change equipment on the left and it redraws instantly.' },
  { id: 'existing', label: 'Existing boat', tip: 'Draw how your boat is wired today. BoatWire checks it against the rules and builds an upgrade plan toward the ideal design.' },
  { id: 'compare', label: 'Compare', tip: 'What-if scenarios side by side: 12 V vs 24 V, lead-acid vs lithium, bigger banks. See how cable sizes, fuses, weight and cost change.' },
  { id: 'reports', label: 'Reports', tip: 'Design check, upgrade plan, wire schedule, bill of materials and energy budget. Printable and downloadable as CSV.' },
];

export default function App() {
  const view = useStore((s) => s.view);
  const pane = usePane((s) => s.pane);
  const setPane = usePane((s) => s.setPane);
  const selection = useStore((s) => s.selection);
  useApplyTheme(useStore((s) => s.theme));
  useUndoKeys();
  // Narrow screens: tapping a component or wire brings up its details; changing view goes back to the main panel.
  useEffect(() => {
    if (selection && isNarrow()) setPane('right');
  }, [selection, setPane]);
  useEffect(() => setPane('main'), [view, setPane]);
  return (
    <ErrorBoundary scope="app">
      <div className={`app view-${view} pane-${pane}`}>
        <CloudSync />
        <TipLayer />
        <ToastLayer />
        <NewBoatWizard />
        <DialogLayer />
        <HelpGuide />
        <Header />
        <RecoveryBanner />
        <CloudNotice />
        {/* A crash in the working area leaves the header, File menu and undo usable. `key` clears it when the view changes. */}
        <ErrorBoundary scope="view" key={view}>
          <div className="main">
            <Sidebar />
            {/* Tablet: tap outside the equipment panel to close it. Hidden by CSS everywhere else. */}
            {pane === 'left' && <div className="pane-backdrop" onClick={() => setPane('main')} />}
            <div className="center">
              {view === 'ideal' && <IdealView />}
              {view === 'existing' && <ExistingView />}
              <Suspense fallback={<div className="hint view-loading">Loading…</div>}>
                {view === 'compare' && <Compare />}
                {view === 'reports' && <Reports />}
              </Suspense>
            </div>
          </div>
        </ErrorBoundary>
        <PaneBar />
      </div>
    </ErrorBoundary>
  );
}

/** Narrow screens only: switch between the equipment list, the main view and the details panel. */
function PaneBar() {
  const view = useStore((s) => s.view);
  const hasSelection = useStore((s) => !!s.selection);
  const { pane, setPane } = usePane();
  const hasDetails = view === 'ideal' || view === 'existing';
  const main = { ideal: 'Diagram', existing: 'Drawing', compare: 'Compare', reports: 'Reports' }[view];
  return (
    <nav className="panebar" aria-label="Panels">
      <button className={pane === 'left' ? 'on' : ''} aria-pressed={pane === 'left'} onClick={() => setPane(pane === 'left' ? 'main' : 'left')}>
        Equipment
      </button>
      <button className={pane === 'main' ? 'on' : ''} aria-pressed={pane === 'main'} onClick={() => setPane('main')}>
        {main}
      </button>
      <button className={pane === 'right' ? 'on' : ''} aria-pressed={pane === 'right'} disabled={!hasDetails} onClick={() => setPane(pane === 'right' ? 'main' : 'right')}>
        {hasSelection ? 'Details' : 'Design check'}
      </button>
    </nav>
  );
}

function Header() {
  const project = useStore((s) => s.project);
  const view = useStore((s) => s.view);
  const setView = useStore((s) => s.setView);
  const setScenario = useStore((s) => s.setScenario);
  const loadProject = useStore((s) => s.loadProject);
  const startNewBoat = useNewBoat((s) => s.start);
  const loadExample = useStore((s) => s.loadExample);
  const fileRef = useRef<HTMLInputElement>(null);
  const ideal = useIdeal();
  const existing = useExisting();
  const fileMenu = useMenu();
  const { open: menu, setOpen: setMenu } = fileMenu;
  const diagramDesign = view === 'existing' && existing ? existing : ideal;
  const slug = project.profile.name.replace(/[^a-z0-9]+/gi, '-').toLowerCase();
  return (
    <header className="header">
      <div className="brand">
        <svg width="26" height="26" viewBox="0 0 32 32" aria-hidden>
          <path d="M16 3v20M16 5l9 16H16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinejoin="round" />
          <path d="M4 24h24l-3 5H7z" fill="currentColor" />
          <path d="M13 9l-4 7h4l-2 5" fill="none" stroke="var(--w-ac)" strokeWidth="2" strokeLinejoin="round" />
        </svg>
        <span>BoatWire</span>
        <VersionStamp />
      </div>
      <nav className="views">
        {VIEWS.map((v) => (
          <button key={v.id} className={view === v.id ? 'on' : ''} onClick={() => setView(v.id)} data-tip={v.tip}>
            {v.label}
          </button>
        ))}
      </nav>
      <UndoRedo />
      <div className="scen">
        <span className="hint">Scenario</span>
        <select aria-label="Scenario" data-tip="Which what-if version of the boat to draw. Scenarios can change system voltage, house battery chemistry and capacity without touching your equipment list. Manage them under Compare." value={project.activeScenario} onChange={(e) => setScenario(e.target.value)}>
          {project.scenarios.map((s) => (
            <option key={s.id} value={s.id}>
              {s.name}
            </option>
          ))}
        </select>
        <span className="pill" data-tip="DC system voltage of the scenario being shown.">{ideal.systemVoltage} V</span>
      </div>
      <ThemePicker />
      <HelpButton />
      <OfflineChip />
      <CloudControls />
      <div className="file">
        <button {...fileMenu.trigger} data-tip="New boat, example boat, open / save a project file, and export the diagram or reports.">
          File ▾
        </button>
        {menu && (
          <div className="menu" aria-label="File" {...fileMenu.panel}>
            <div className="menu-theme">
              <ThemePicker />
            </div>
            <button
              onClick={() => {
                startNewBoat();
                setMenu(false);
              }}
            >
              New boat…
            </button>
            <button
              onClick={() => {
                loadExample();
                setMenu(false);
              }}
            >
              Load example boat
            </button>
            <button onClick={() => fileRef.current?.click()}>Open project…</button>
            <button
              onClick={() => {
                downloadText(`${slug}.boatwire.json`, JSON.stringify(project, null, 2), 'application/json');
                setMenu(false);
              }}
            >
              Save project file
            </button>
            <hr />
            <button onClick={() => exportDiagram('png')}>Export diagram (PNG)</button>
            <button onClick={() => exportDiagram('svg')}>Export diagram (SVG)</button>
            <button
              onClick={() =>
                downloadText(
                  `${slug}-wires.csv`,
                  toCsv([
                    ['Circuit', 'From', 'To', 'Colour', 'Size', 'Length ft', 'Amps', 'Protection', 'Vdrop %'],
                    ...wireSchedule(diagramDesign).map((r) => [r.circuit, r.from, r.to, r.color, r.gauge, r.lengthFt, r.amps?.toFixed(1), r.protection, r.vdrop?.toFixed(2)]),
                  ]),
                )
              }
            >
              Wire schedule (CSV)
            </button>
            <button onClick={() => downloadText(`${slug}-bom.csv`, toCsv([['Category', 'Item', 'Spec', 'Qty', 'Unit'], ...billOfMaterials(diagramDesign).map((r) => [r.category, r.item, r.spec, r.qty, r.unit])]))}>
              Bill of materials (CSV)
            </button>
            <button onClick={() => window.print()}>Print current view</button>
          </div>
        )}
        <input
          ref={fileRef}
          type="file"
          accept=".json,application/json"
          hidden
          onChange={async (e) => {
            const f = e.target.files?.[0];
            if (!f) return;
            try {
              let raw: unknown;
              try {
                raw = JSON.parse(await f.text());
              } catch {
                throw new Error('It is not a BoatWire project file (.boatwire.json).');
              }
              const { project, notes } = parseProject(raw);
              loadProject(project);
              if (notes.length) toast(`Opened with repairs: ${notes.join(' ')}`, { ms: 15000 });
            } catch (err) {
              void showMessage(`Could not open “${f.name}”`, (err as Error).message);
            }
            e.target.value = '';
            setMenu(false);
          }}
        />
      </div>
    </header>
  );
}

/** Shown only while the browser has no connection: the app keeps working from its offline copy. */
function OfflineChip() {
  const [online, setOnline] = useState(() => navigator.onLine);
  useEffect(() => {
    const on = () => setOnline(true);
    const off = () => setOnline(false);
    window.addEventListener('online', on);
    window.addEventListener('offline', off);
    return () => {
      window.removeEventListener('online', on);
      window.removeEventListener('offline', off);
    };
  }, []);
  if (online) return null;
  return (
    <span className="offline-chip" role="status" data-tip="No connection. BoatWire keeps working, and your changes are saved on this device. Signing in and cloud saving resume when the connection returns.">
      <span aria-hidden>●</span>
      <span className="offline-text"> Offline</span>
    </span>
  );
}

/** Undo / Redo buttons. The tooltip says what each would do. */
function UndoRedo() {
  const { undoLabel, redoLabel } = useHistory();
  const mod = /Mac|iPhone|iPad/.test(navigator.platform) ? '⌘' : 'Ctrl+';
  return (
    <div className="undo">
      <button className="icon" disabled={!undoLabel} onClick={undo} aria-label="Undo" data-tip={undoLabel ? `Undo: ${undoLabel} (${mod}Z)` : `Nothing to undo (${mod}Z)`}>
        <TurnArrow />
      </button>
      <button className="icon" disabled={!redoLabel} onClick={redo} aria-label="Redo" data-tip={redoLabel ? `Redo: ${redoLabel} (${mod}Shift+Z)` : `Nothing to redo (${mod}Shift+Z)`}>
        <TurnArrow flip />
      </button>
    </div>
  );
}

/** Curved "go back" arrow; flipped it is "go forward". */
function TurnArrow({ flip }: { flip?: boolean }) {
  return (
    <svg width="17" height="17" viewBox="0 0 20 20" aria-hidden style={flip ? { transform: 'scaleX(-1)' } : undefined}>
      <path d="M7.5 4 3.5 8l4 4" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
      <path d="M4 8h7.5a5 5 0 0 1 0 10H8" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
    </svg>
  );
}

/** Ctrl/Cmd+Z undoes, Ctrl/Cmd+Shift+Z or Ctrl+Y redoes, anywhere except inside a dialog (the guide's search box keeps its own undo). */
function useUndoKeys() {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!(e.metaKey || e.ctrlKey) || e.altKey) return;
      const k = e.key.toLowerCase();
      if (k !== 'z' && k !== 'y') return;
      if ((e.target as HTMLElement | null)?.closest?.('.modal')) return;
      e.preventDefault();
      if (k === 'y' || e.shiftKey) redo();
      else undo();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);
}

const BUILD_TIME = new Date(__APP_BUILD_TIME__);

/** Version + commit + build time, so you can see when a new deploy has landed. */
function VersionStamp() {
  const when = BUILD_TIME.toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
  return (
    <span className="version" data-tip={`Version ${__APP_VERSION__}\nCommit ${__APP_COMMIT__}\nBuilt ${BUILD_TIME.toLocaleString()}`}>
      v{__APP_VERSION__} · {__APP_COMMIT__}
      <span className="v-time"> · {when}</span>
    </span>
  );
}

function ThemePicker() {
  const theme = useStore((s) => s.theme);
  const setTheme = useStore((s) => s.setTheme);
  const cur = THEMES.find((t) => t.id === theme) ?? THEMES[0];
  return (
    <select className="theme-pick" value={theme} onChange={(e) => setTheme(e.target.value as ThemeId)} data-tip={`Colour scheme: ${cur.label}. ${cur.hint}.`} aria-label="Colour scheme">
      {THEMES.map((t) => (
        <option key={t.id} value={t.id} title={t.hint}>
          🎨 {t.label}
        </option>
      ))}
    </select>
  );
}

function exportDiagram(fmt: 'png' | 'svg') {
  const fn = (window as unknown as { boatwireExport?: (f: 'png' | 'svg') => Promise<void> }).boatwireExport;
  if (fn && document.querySelector('.react-flow__viewport')) fn(fmt);
  else toast('Open a diagram first (Ideal design or Existing boat), then export it.');
}

function LayerBar({ manual }: { manual?: boolean }) {
  const layers = useStore((s) => s.layers);
  const setLayers = useStore((s) => s.setLayers);
  const relayout = useStore((s) => s.relayout);
  const L = layers.labels;
  const lab = (k: keyof typeof L, label: string, tip: string) => (
    <Toggle checked={L[k]} label={label} tip={tip} onChange={(v) => setLayers((l) => ({ ...l, labels: { ...l.labels, [k]: v } }))} />
  );
  return (
    <div className="layerbar">
      <div className="lgroup">
        <span className="lg-title">Show</span>
        <Toggle checked={layers.dc} label="DC" tip="Show the 12 / 24 V battery system: batteries, buses, panels, chargers and DC loads." onChange={(v) => setLayers((l) => ({ ...l, dc: v, ac: !v && !l.ac ? true : l.ac }))} />
        <Toggle checked={layers.ac} label="AC" tip="Show the 120 / 230 V mains system: shore power, generator, inverter, AC panel and outlets." onChange={(v) => setLayers((l) => ({ ...l, ac: v, dc: !v && !l.dc ? true : l.dc }))} />
        <select aria-label="Negative wires" value={layers.negatives} onChange={(e) => setLayers((l) => ({ ...l, negatives: e.target.value as typeof l.negatives }))} data-tip={'How to draw the negative (return) wires.\nAll: every negative wire.\nBuses only: hide the many short load returns, keep the main ones.\nHide: positives only, the cleanest view.'}>
          <option value="full">All negatives</option>
          <option value="buses">Negatives: buses only</option>
          <option value="hidden">Hide negatives</option>
        </select>
        <Toggle
          checked={layers.panelLoads !== 'collapse'}
          label="Panel loads"
          tip="Show the branch circuits fed from the DC panel (lights, fans, fridge…). Off collapses them into a count on the panel for a simpler view."
          onChange={(v) => setLayers((l) => ({ ...l, panelLoads: v ? 'show' : 'collapse' }))}
        />
        <Toggle
          checked={layers.fuses !== false}
          label="Fuses"
          tip="Show inline fuses. Off draws each wire straight through its fuse; the fuse rating stays on the wire label."
          onChange={(v) => setLayers((l) => ({ ...l, fuses: v }))}
        />
        <Toggle checked={layers.signal} label="Control" tip="Show low-current control and sensing wires (dashed blue): BMS signals, regulator sense leads, relay triggers, helm switches." onChange={(v) => setLayers((l) => ({ ...l, signal: v }))} />
        <Toggle checked={layers.grounding} label="Equip. grounds" tip="Show the green AC safety-ground wires to each AC appliance and the bond to DC negative." onChange={(v) => setLayers((l) => ({ ...l, grounding: v }))} />
      </div>
      <div className="lgroup">
        <span className="lg-title">Labels</span>
        {lab('gauge', 'Wire size', 'Label each wire with its conductor size in AWG (e.g. 10, 2/0). AC cables show as e.g. 10/3.')}
        {lab('current', 'Amps', 'Label each wire with the current it is designed to carry.')}
        {lab('length', 'Length', 'Label each wire with its estimated one-way run length in feet (from the zones on the Boat & zones tab).')}
        {lab('vdrop', 'V-drop', 'Label each wire with its voltage drop at full current. Critical circuits must stay under 3%, others under 10%.')}
        {lab('protection', 'Fuse rating', 'Label each wire with the rating of the fuse or breaker protecting it.')}
        {lab('parts', 'Parts', 'Show a suggested part type under each component.')}
      </div>
      <div className="lgroup end">
        {!manual && (
          <button onClick={relayout} data-tip="Re-run the automatic layout, e.g. after dragging things around.">
            Re-arrange
          </button>
        )}
        <button className="link" onClick={() => setLayers(() => DEFAULT_LAYERS)} data-tip="Put all Show and Labels options back to their defaults.">
          Reset
        </button>
      </div>
    </div>
  );
}

function IdealView() {
  const startNewBoat = useNewBoat((s) => s.start);
  const ideal = useIdeal();
  const findings = useFindings(ideal);
  const project = useStore((s) => s.project);
  const scen = activeScenario(project);
  return (
    <div className="workspace">
      <div className="canvas-col">
        <LayerBar />
        {isUntouched(project) && (
          <div className="example-note">
            <span>
              This is an <b>example boat</b> to look around in.
            </span>
            <button className="primary" onClick={() => startNewBoat()}>
              Start my own boat
            </button>
          </div>
        )}
        <div className="canvas-title">
          <b>Ideal design</b> · {project.profile.name} · {scen?.name} · {ideal.systemVoltage} V
          <span className="hint"> — generated from your equipment list. Edit equipment on the left; the design updates instantly.</span>
        </div>
        <Diagram design={ideal} findings={findings} mode="auto" />
      </div>
      <Inspector design={ideal} findings={findings} editable={false} />
    </div>
  );
}

function ExistingView() {
  const existing = useExisting();
  const findings = useFindings(existing);
  const project = useStore((s) => s.project);
  const setExisting = useStore((s) => s.setExisting);
  const addExistingNode = useStore((s) => s.addExistingNode);
  const updateExisting = useStore((s) => s.updateExisting);
  const setView = useStore((s) => s.setView);
  const setReportTab = useStore((s) => s.setReportTab);
  const [busy, setBusy] = useState(false);
  const traceRef = useRef<HTMLInputElement>(null);

  if (!existing) {
    return (
      <div className="empty big">
        <h2>Draw the system you have now</h2>
        <p>
          Map your boat's current wiring, then BoatWire checks it against the rules and builds an upgrade plan to reach the ideal design. <HelpLink topic="existing" />
        </p>
        <div className="starts">
          <button
            className="start"
            onClick={() => setExisting(existingFromEquipment(project))}
          >
            <b>Start from my equipment list</b>
            <span>Places your batteries, chargers and loads. You draw the wires, fuses and switches as they actually are.</span>
          </button>
          <button
            className="start"
            disabled={busy}
            onClick={async () => {
              setBusy(true);
              // copy the boat as specified (not a what-if scenario)
              const base = generateIdeal(project);
              const l = await autoLayout(base, { ...DEFAULT_LAYERS, grounding: true });
              setExisting(existingFromIdeal(base, Object.fromEntries(l.nodes.map((n) => [n.id, { x: n.x, y: n.y }]))));
              setBusy(false);
            }}
          >
            <b>Start from the ideal design</b>
            <span>Copy the ideal design, then delete or change what's different on your boat. Fastest when your boat is fairly standard.</span>
          </button>
          <button className="start" onClick={() => setExisting({ id: 'existing', name: 'Existing', systemVoltage: project.profile.systemVoltage, nodes: [], wires: [], findings: [] })}>
            <b>Blank canvas</b>
            <span>Add every component yourself from the palette.</span>
          </button>
          <button className="start" disabled={busy} onClick={() => traceRef.current?.click()}>
            <b>{busy ? 'Reading your diagram…' : 'Trace over my wiring diagram'}</b>
            <span>Upload a photo, scan or PDF of your boat's wiring diagram. It shows faded behind a blank canvas so you can place components and wires on top of it.</span>
          </button>
          <input
            ref={traceRef}
            type="file"
            accept={UNDERLAY_ACCEPT}
            hidden
            onChange={async (e) => {
              const f = e.target.files?.[0];
              e.target.value = '';
              if (!f) return;
              setBusy(true);
              try {
                const underlay = await underlayFromFile(f);
                setExisting({ id: 'existing', name: 'Existing', systemVoltage: project.profile.systemVoltage, nodes: [], wires: [], findings: [], underlay });
              } catch (err) {
                void showMessage('Could not use that file', (err as Error).message);
              } finally {
                setBusy(false);
              }
            }}
          />
        </div>
      </div>
    );
  }

  const onDrawing = new Set(existing.nodes.map((n) => n.equipmentId).filter(Boolean));
  const missingEq = project.equipment.filter((e) => !onDrawing.has(e.id));
  const groups = new Map<string, NodeType[]>();
  for (const [t, d] of Object.entries(NODE_DEFS)) {
    if (!d.palette) continue;
    if (!groups.has(d.palette)) groups.set(d.palette, []);
    groups.get(d.palette)!.push(t as NodeType);
  }
  const errs = findings.filter((f) => f.severity === 'error').length;
  const warns = findings.filter((f) => f.severity === 'warning').length;
  return (
    <div className="workspace">
      <div className="canvas-col">
        <div className="toolbar">
          <select
            value=""
            aria-label="Add a component to the drawing"
            data-tip="Add a generic component (fuse, switch, bus bar, panel…) to your drawing. Click it afterwards to set its rating."
            onChange={(e) => {
              if (!e.target.value) return;
              const n = paletteNode(e.target.value as NodeType, project.profile.batteryZone);
              n.pos = { x: 80 + Math.random() * 200, y: 80 + Math.random() * 200 };
              addExistingNode(n);
            }}
          >
            <option value="">+ Add component…</option>
            {[...groups].map(([g, types]) => (
              <optgroup key={g} label={g}>
                {types.map((t) => (
                  <option key={t} value={t}>
                    {NODE_DEFS[t].label}
                  </option>
                ))}
              </optgroup>
            ))}
          </select>
          <select
            value=""
            disabled={!missingEq.length}
            aria-label="Place equipment from your list on the drawing"
            data-tip="Place an item from your equipment list that is not on the drawing yet."
            onChange={(e) => {
              const eq = project.equipment.find((x) => x.id === e.target.value);
              if (!eq) return;
              const n = equipmentNode(eq, project);
              if (!n) return;
              n.pos = { x: n.col * 240, y: 40 + Math.random() * 300 };
              addExistingNode(n);
            }}
          >
            <option value="">{missingEq.length ? `+ Place equipment (${missingEq.length})…` : 'All equipment placed'}</option>
            {missingEq.map((e) => (
              <option key={e.id} value={e.id}>
                {e.name}
              </option>
            ))}
          </select>
          <button
            data-tip="Tidy the drawing automatically. Your wires are kept; only positions change."
            onClick={async () => {
              const pos = await arrangePositions(existing);
              updateExisting((d) => d.nodes.forEach((n) => (n.pos = pos[n.id] ?? n.pos)));
            }}
          >
            Auto-arrange
          </button>
          <span className="spacer" />
          <button
            className={`status ${errs ? 'bad' : warns ? 'meh' : 'good'}`}
            data-tip="Problems found in your current wiring. Click for the prioritized upgrade plan."
            onClick={() => {
              setReportTab('changes');
              setView('reports');
            }}
          >
            {errs} errors · {warns} warnings → Upgrade plan
          </button>
          <button
            className="link danger"
            data-tip="Delete this drawing and start over. Your equipment list is not affected. You can undo this."
            onClick={() => setExisting(undefined)}
          >
            Discard drawing
          </button>
        </div>
        <LayerBar manual />
        <div className="canvas-title">
          <b>Existing boat</b>
          <span className="hint"> — drag from one terminal dot to another to draw a wire, or tap one dot and then the other. Click a wire to set its size and length. Delete removes the selection.</span>
        </div>
        <Diagram design={existing} findings={findings} mode="manual" />
      </div>
      <Inspector design={existing} findings={findings} editable />
    </div>
  );
}
