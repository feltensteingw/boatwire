import { useRef, useState } from 'react';
import { arrangePositions, autoLayout } from './layout/layout';
import { existingFromEquipment, existingFromIdeal, equipmentNode, paletteNode } from './engine/existing';
import { activeScenario } from './engine/scenario';
import { generateIdeal } from './engine/generate';
import { billOfMaterials, wireSchedule } from './engine/reports';
import { NODE_DEFS } from './model/nodeDefs';
import type { NodeType, Project } from './model/types';
import { useExisting, useFindings, useIdeal } from './state/derived';
import { DEFAULT_LAYERS, useStore, type View } from './state/store';
import { Compare } from './ui/Compare';
import { Diagram } from './ui/Diagram';
import { Inspector } from './ui/Inspector';
import { Reports, downloadText, toCsv } from './ui/Reports';
import { Sidebar } from './ui/Sidebar';
import { Toggle } from './ui/fields';
import { CloudControls, CloudSync } from './cloud/CloudControls';

const VIEWS: { id: View; label: string }[] = [
  { id: 'ideal', label: 'Ideal design' },
  { id: 'existing', label: 'Existing boat' },
  { id: 'compare', label: 'Compare' },
  { id: 'reports', label: 'Reports' },
];

export default function App() {
  const view = useStore((s) => s.view);
  return (
    <div className={`app view-${view}`}>
      <CloudSync />
      <Header />
      <div className="main">
        <Sidebar />
        <div className="center">
          {view === 'ideal' && <IdealView />}
          {view === 'existing' && <ExistingView />}
          {view === 'compare' && <Compare />}
          {view === 'reports' && <Reports />}
        </div>
      </div>
    </div>
  );
}

function Header() {
  const project = useStore((s) => s.project);
  const view = useStore((s) => s.view);
  const setView = useStore((s) => s.setView);
  const setScenario = useStore((s) => s.setScenario);
  const loadProject = useStore((s) => s.loadProject);
  const newProject = useStore((s) => s.newProject);
  const loadExample = useStore((s) => s.loadExample);
  const fileRef = useRef<HTMLInputElement>(null);
  const ideal = useIdeal();
  const existing = useExisting();
  const [menu, setMenu] = useState(false);
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
      </div>
      <nav className="views">
        {VIEWS.map((v) => (
          <button key={v.id} className={view === v.id ? 'on' : ''} onClick={() => setView(v.id)}>
            {v.label}
          </button>
        ))}
      </nav>
      <div className="scen">
        <span className="hint">Scenario</span>
        <select value={project.activeScenario} onChange={(e) => setScenario(e.target.value)}>
          {project.scenarios.map((s) => (
            <option key={s.id} value={s.id}>
              {s.name}
            </option>
          ))}
        </select>
        <span className="pill">{ideal.systemVoltage} V</span>
      </div>
      <CloudControls />
      <div className="file">
        <button onClick={() => setMenu(!menu)}>File ▾</button>
        {menu && (
          <div className="menu" onMouseLeave={() => setMenu(false)}>
            <button
              onClick={() => {
                if (confirmReplace()) newProject();
                setMenu(false);
              }}
            >
              New boat
            </button>
            <button
              onClick={() => {
                if (confirmReplace()) loadExample();
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
              const p = JSON.parse(await f.text()) as Project;
              if (p.version !== 1 || !p.profile || !Array.isArray(p.equipment)) throw new Error('Not a BoatWire project');
              loadProject(p);
            } catch (err) {
              alert(`Could not open file: ${(err as Error).message}`);
            }
            e.target.value = '';
            setMenu(false);
          }}
        />
      </div>
    </header>
  );
}

function confirmReplace() {
  return window.confirm('Replace the current boat? Save it first if you want to keep it (File → Save project file).');
}

function exportDiagram(fmt: 'png' | 'svg') {
  const fn = (window as unknown as { boatwireExport?: (f: 'png' | 'svg') => Promise<void> }).boatwireExport;
  if (fn && document.querySelector('.react-flow__viewport')) fn(fmt);
  else alert('Open a diagram (Ideal design or Existing boat) first.');
}

function LayerBar({ manual }: { manual?: boolean }) {
  const layers = useStore((s) => s.layers);
  const setLayers = useStore((s) => s.setLayers);
  const relayout = useStore((s) => s.relayout);
  const L = layers.labels;
  const lab = (k: keyof typeof L, label: string) => (
    <Toggle checked={L[k]} label={label} onChange={(v) => setLayers((l) => ({ ...l, labels: { ...l.labels, [k]: v } }))} />
  );
  return (
    <div className="layerbar">
      <div className="lgroup">
        <span className="lg-title">Show</span>
        <Toggle checked={layers.dc} label="DC" onChange={(v) => setLayers((l) => ({ ...l, dc: v, ac: !v && !l.ac ? true : l.ac }))} />
        <Toggle checked={layers.ac} label="AC" onChange={(v) => setLayers((l) => ({ ...l, ac: v, dc: !v && !l.dc ? true : l.dc }))} />
        <select value={layers.negatives} onChange={(e) => setLayers((l) => ({ ...l, negatives: e.target.value as typeof l.negatives }))} title="Negative conductors">
          <option value="full">All negatives</option>
          <option value="buses">Negatives: buses only</option>
          <option value="hidden">Hide negatives</option>
        </select>
        <span title="Show the branch circuits fed from the DC panel (lights, fans, fridge…). Off collapses them into a summary on the panel.">
          <Toggle checked={layers.panelLoads !== 'collapse'} label="Panel loads" onChange={(v) => setLayers((l) => ({ ...l, panelLoads: v ? 'show' : 'collapse' }))} />
        </span>
        <Toggle checked={layers.signal} label="Control" onChange={(v) => setLayers((l) => ({ ...l, signal: v }))} />
        <Toggle checked={layers.grounding} label="Equip. grounds" onChange={(v) => setLayers((l) => ({ ...l, grounding: v }))} />
      </div>
      <div className="lgroup">
        <span className="lg-title">Labels</span>
        {lab('gauge', 'Wire size')}
        {lab('current', 'Amps')}
        {lab('length', 'Length')}
        {lab('vdrop', 'V-drop')}
        {lab('protection', 'Fuse')}
        {lab('parts', 'Parts')}
      </div>
      <div className="lgroup end">
        {!manual && (
          <button onClick={relayout} title="Re-run automatic layout">
            Re-arrange
          </button>
        )}
        <button className="link" onClick={() => setLayers(() => DEFAULT_LAYERS)}>
          Reset
        </button>
      </div>
    </div>
  );
}

function IdealView() {
  const ideal = useIdeal();
  const findings = useFindings(ideal);
  const project = useStore((s) => s.project);
  const scen = activeScenario(project);
  return (
    <div className="workspace">
      <div className="canvas-col">
        <LayerBar />
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

  if (!existing) {
    return (
      <div className="empty big">
        <h2>Draw the system you have now</h2>
        <p>Map your boat's current wiring, then BoatWire checks it against the rules and builds an upgrade plan to reach the ideal design.</p>
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
            onClick={() => {
              setReportTab('changes');
              setView('reports');
            }}
          >
            {errs} errors · {warns} warnings → Upgrade plan
          </button>
          <button
            className="link danger"
            onClick={() => {
              if (window.confirm('Discard the existing-system drawing?')) setExisting(undefined);
            }}
          >
            Discard drawing
          </button>
        </div>
        <LayerBar manual />
        <div className="canvas-title">
          <b>Existing boat</b>
          <span className="hint"> — drag from one terminal dot to another to draw a wire. Click a wire to set its size and length. Delete removes the selection.</span>
        </div>
        <Diagram design={existing} findings={findings} mode="manual" />
      </div>
      <Inspector design={existing} findings={findings} editable />
    </div>
  );
}
