import {
  Background,
  BackgroundVariant,
  ConnectionMode,
  Controls,
  MiniMap,
  ReactFlow,
  ReactFlowProvider,
  getNodesBounds,
  getViewportForBounds,
  useEdgesState,
  useNodesInitialized,
  useNodesState,
  useReactFlow,
  useStoreApi,
  type Connection,
} from '@xyflow/react';
import { toPng, toSvg } from 'html-to-image';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { joinTerminals } from '../engine/connect';
import { estimateCurrents } from '../engine/audit';
import { autoLayout, cachedLayout, manualLayout, viewShift, type Layout } from '../layout/layout';
import type { Design, Finding } from '../model/types';
import { severityByNode, useUnits } from '../state/derived';
import { useStore } from '../state/store';
import { SymbolNode, type SymbolFlowNode } from './symbols';
import { UnderlayControls, UnderlayImage } from './Underlay';
import { WireEdge, type WireFlowEdge } from './WireEdge';
import { Panel, type Edge, type Node } from '@xyflow/react';
import { copyOf, freeSpot, GRID, type Clip } from '../engine/drawing';
import { paletteNode } from '../engine/existing';
import type { NodeType } from '../model/types';
import { registerViewCentre } from './viewCentre';

/** What was last copied from the drawing (Ctrl+C), and how many times it has been pasted since. */
let clipboard: { clip: Clip; pastes: number } | null = null;
/** dataTransfer type used when a part is dragged from the quick-add strip onto the canvas. */
export const PART_MIME = 'application/x-boatwire-part';

const nodeTypes = { sym: SymbolNode };
const edgeTypes = { wire: WireEdge };

/** Pause after the last edit before the diagram is re-arranged, so typing a value does not redraw per key. */
const RELAYOUT_DELAY_MS = 300;

interface Props {
  design: Design;
  findings: Finding[];
  mode: 'auto' | 'manual';
}

export function Diagram(props: Props) {
  return (
    <ReactFlowProvider>
      <DiagramInner {...props} />
    </ReactFlowProvider>
  );
}

function DiagramInner({ design, findings, mode }: Props) {
  const layers = useStore((s) => s.layers);
  const nonce = useStore((s) => s.layoutNonce);
  const selection = useStore((s) => s.selection);
  const select = useStore((s) => s.select);
  const updateExisting = useStore((s) => s.updateExisting);
  const connectExisting = useStore((s) => s.connectExisting);
  const { fitView, fitBounds, getViewport, setViewport } = useReactFlow();
  const [layout, setLayout] = useState<Layout | null>(null);
  const layoutRef = useRef<Layout | null>(null);
  const flow = useStoreApi();
  /** What the view was last fitted for. The view is only re-fitted when this changes. */
  const fittedFor = useRef('');
  const [busy, setBusy] = useState(false);
  const [nodes, setNodes, onNodesChange] = useNodesState<SymbolFlowNode>([]);
  const [edges, setEdges, onEdgesChange] = useEdgesState<WireFlowEdge>([]);
  const fitPending = useRef(true);
  const which = mode === 'auto' ? 'ideal' : 'existing';

  const structural = `${layers.panelLoads}|${layers.fuses}|${layers.dc}|${layers.ac}|${layers.negatives}|${layers.signal}|${layers.grounding}`;

  useEffect(() => {
    let cancelled = false;
    // Fit the whole diagram only when the user asked for a different picture: first draw, another
    // scenario, a Show option, or Re-arrange. An equipment edit keeps the zoom and position.
    const fitKey = `${design.id}|${structural}|${nonce}`;
    const apply = (l: Layout) => {
      if (fittedFor.current !== fitKey) {
        fittedFor.current = fitKey;
        fitPending.current = true;
      } else if (layoutRef.current) {
        holdView(layoutRef.current, l);
      }
      layoutRef.current = l;
      setLayout(l);
    };
    if (mode !== 'auto') {
      setLayout(manualLayout(design, layers));
      return;
    }
    // Same shape as the last layout (only labels or sizes of wire changed): redraw at once, nothing moves.
    const hit = cachedLayout(design, layers);
    if (hit) {
      setBusy(false);
      apply(hit);
      return;
    }
    // The shape changed. Wait for a pause in typing before re-arranging; the first draw is immediate.
    const timer = setTimeout(
      () => {
        setBusy(true);
        autoLayout(design, layers)
          .then((l) => !cancelled && apply(l))
          .catch((e) => console.error('layout failed', e))
          .finally(() => !cancelled && setBusy(false));
      },
      layoutRef.current ? RELAYOUT_DELAY_MS : 0,
    );
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [design, mode, structural, nonce]);

  /**
   * After a re-arrange caused by an edit, shift the view so the component nearest the middle of
   * the screen stays where it was, instead of the diagram jumping under the user.
   */
  function holdView(before: Layout, after: Layout) {
    const { width, height } = flow.getState();
    if (!width || !height) return;
    const vp = getViewport();
    const shift = viewShift(before, after, { x: (width / 2 - vp.x) / vp.zoom, y: (height / 2 - vp.y) / vp.zoom });
    if (shift.x || shift.y) setViewport({ x: vp.x - shift.x * vp.zoom, y: vp.y - shift.y * vp.zoom, zoom: vp.zoom });
  }

  const units = useUnits();
  const severities = useMemo(() => severityByNode(findings), [findings]);
  const currents = useMemo(() => estimateCurrents(design), [design]);

  useEffect(() => {
    if (!layout) return;
    setNodes((prev) => {
      // Keep what was selected. Newly pasted or duplicated components are selected instead.
      const picked = selectNext.current ?? new Set(prev.filter((n) => n.selected).map((n) => n.id));
      selectNext.current = null;
      return layout.nodes.map((ln) => ({
        id: ln.id,
        type: 'sym',
        position: { x: ln.x, y: ln.y },
        data: { laid: ln, severity: severities.get(ln.id), showParts: layers.labels.parts, manual: mode === 'manual' },
        selected: selection ? selection.kind === 'node' && selection.id === ln.id : picked.has(ln.id),
        width: ln.w,
        height: ln.h,
      }));
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [layout, severities, layers.labels.parts, mode]);

  useEffect(() => {
    if (!layout) return;
    const N = new Map(design.nodes.map((n) => [n.id, n]));
    setEdges(
      layout.edges.map((le) => {
        const w = le.wire;
        const prot = w.protectedBy ? N.get(w.protectedBy) : undefined;
        const panelT = [w.from, w.to].map((e) => N.get(e.node)?.terminals.find((t) => t.id === e.term && t.rating)).find(Boolean);
        const hidden = w.viaFuse ? N.get(w.viaFuse) : undefined;
        const protection = hidden
          ? `fuse ${hidden.data.rating ?? '?'} A${hidden.data.fuseClass ? ` ${hidden.data.fuseClass}` : ''}`
          : panelT?.rating
            ? `${panelT.rating} A`
            : prot?.data.rating
              ? `${prot.data.rating} A`
              : undefined;
        return {
          id: le.id,
          type: 'wire',
          source: le.source,
          target: le.target,
          sourceHandle: le.sourcePort,
          targetHandle: le.targetPort,
          data: { wire: w, points: le.points, labels: layers.labels, amps: w.amps ?? currents.get(w.id), protection, units },
          selected: selection?.kind === 'wire' && selection.id === le.id,
          zIndex: w.kind === 'sig' ? 0 : 1,
        };
      }),
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [layout, layers.labels, currents, units]);

  // reflect external selection (e.g. clicking a finding)
  useEffect(() => {
    // One thing selected in the app: show exactly that. Nothing selected in the app leaves the
    // canvas's own selection alone, because several things may be selected there (Shift-drag).
    if (selection) setNodes((ns) => ns.map((n) => ({ ...n, selected: selection.kind === 'node' && selection.id === n.id })));
    setEdges((es) =>
      es.map((e) => {
        const on = selection?.kind === 'wire' && selection.id === e.id;
        // A selected wire can have either end dragged to another terminal. It is lifted above the
        // components so its end grips sit on top of the terminal dots.
        const movable = on && mode === 'manual' && design.wires.some((w) => w.id === e.id);
        return { ...e, selected: selection ? on : e.selected, reconnectable: movable, zIndex: movable ? 2000 : e.data?.wire.kind === 'sig' ? 0 : 1 };
      }),
    );
    if (selection?.kind === 'node') {
      const n = nodes.find((x) => x.id === selection.id);
      if (n && !n.selected) fitView({ nodes: [{ id: n.id }], duration: 400, maxZoom: 1.2, padding: 0.6 });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selection]);

  const initialized = useNodesInitialized();
  useEffect(() => {
    if (fitPending.current && initialized && nodes.length) {
      fitPending.current = false;
      setTimeout(() => fitView({ padding: 0.06 }), 30);
    }
  }, [initialized, nodes, fitView]);

  // A drawing that is only an uploaded diagram so far (no components yet): frame the diagram.
  const underlay = mode === 'manual' ? design.underlay : undefined;
  useEffect(() => {
    if (underlay?.visible && !design.nodes.length) setTimeout(() => fitBounds(underlay, { padding: 0.08 }), 30);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [underlay?.src]);

  /** Why the last wire the user tried to draw was refused. Shown briefly over the canvas. */
  const [refusal, setRefusal] = useState<string | null>(null);
  useEffect(() => {
    if (!refusal) return;
    const t = setTimeout(() => setRefusal(null), 8000);
    return () => clearTimeout(t);
  }, [refusal]);

  // ------------------------------------------------------------ drawing tools (Existing boat)
  const flowApi = useReactFlow();
  const removeFromExisting = useStore((s) => s.removeFromExisting);
  const nudgeExisting = useStore((s) => s.nudgeExisting);
  const pasteExisting = useStore((s) => s.pasteExisting);
  const reconnectExisting = useStore((s) => s.reconnectExisting);
  const addExistingNode = useStore((s) => s.addExistingNode);
  /** Component ids to select once the diagram has been rebuilt (after a paste or duplicate). */
  const selectNext = useRef<Set<string> | null>(null);
  /** Dragging on the empty canvas draws a selection box instead of moving the view (for touch screens). */
  const [boxMode, setBoxMode] = useState(false);
  const pickedNodes = useMemo(() => nodes.filter((n) => n.selected).map((n) => n.id), [nodes]);
  const pickedWires = useMemo(() => edges.filter((e) => e.selected).map((e) => e.id), [edges]);

  // Tell the toolbar where the middle of this view is, so new components appear where the user is looking.
  useEffect(() => {
    if (mode !== 'manual') return;
    registerViewCentre(() => {
      const { width, height } = flow.getState();
      const vp = flowApi.getViewport();
      return { x: (width / 2 - vp.x) / vp.zoom - 70, y: (height / 2 - vp.y) / vp.zoom - 30 };
    });
    return () => registerViewCentre(null);
  }, [mode, flow, flowApi]);

  /** Save where dragged components ended up: all of them in one step, so one undo puts them back. */
  const saveMoved = useCallback(
    (moved: Node[]) => {
      if (mode !== 'manual' || !moved.length) return;
      updateExisting((d) => {
        for (const m of moved) {
          const n = d.nodes.find((x) => x.id === m.id);
          if (n) n.pos = { x: Math.round(m.position.x), y: Math.round(m.position.y) };
        }
      });
    },
    [mode, updateExisting],
  );

  const removePicked = useCallback(() => removeFromExisting(pickedNodes, pickedWires), [removeFromExisting, pickedNodes, pickedWires]);

  /** Add copies of a set of components. They land `steps` grid squares down and right, or in the middle of the view if that would be out of sight. */
  const addCopies = useCallback(
    (clip: Clip, steps: number) => {
      if (!clip.nodes.length) return;
      let offset = { x: 3 * GRID * steps, y: 3 * GRID * steps };
      const xs = clip.nodes.map((n) => n.pos?.x ?? 0);
      const ys = clip.nodes.map((n) => n.pos?.y ?? 0);
      const { width, height } = flow.getState();
      const vp = flowApi.getViewport();
      const sx = (Math.min(...xs) + offset.x) * vp.zoom + vp.x;
      const sy = (Math.min(...ys) + offset.y) * vp.zoom + vp.y;
      if (sx < 0 || sy < 0 || sx > width - 60 || sy > height - 60) {
        const mid = { x: (width / 2 - vp.x) / vp.zoom, y: (height / 2 - vp.y) / vp.zoom };
        const snap = (v: number) => Math.round(v / GRID) * GRID;
        offset = { x: snap(mid.x - (Math.min(...xs) + Math.max(...xs)) / 2 - 60), y: snap(mid.y - (Math.min(...ys) + Math.max(...ys)) / 2 - 30) };
      }
      selectNext.current = new Set(pasteExisting(clip, offset));
    },
    [flow, flowApi, pasteExisting],
  );
  const duplicatePicked = useCallback(() => addCopies(copyOf(design, pickedNodes), 1), [addCopies, design, pickedNodes]);

  // Keys that act on everything selected: delete, nudge, duplicate, copy, paste, select all, Escape.
  // Listening in the capture phase lets the arrow keys be handled here, once, before the canvas
  // library's own (unsaved) arrow-key move of a focused component.
  useEffect(() => {
    if (mode !== 'manual') return;
    const onKey = (e: KeyboardEvent) => {
      const el = e.target as HTMLElement | null;
      if (el && (['INPUT', 'SELECT', 'TEXTAREA'].includes(el.tagName) || el.isContentEditable || el.closest('.modal, [role="dialog"], [role="menu"]'))) return;
      const cmd = e.metaKey || e.ctrlKey;
      const k = e.key.toLowerCase();
      const done = () => {
        e.preventDefault();
        e.stopPropagation();
      };
      if ((e.key === 'Delete' || e.key === 'Backspace') && pickedNodes.length + pickedWires.length > 0) {
        done();
        removePicked();
      } else if (e.key.startsWith('Arrow') && pickedNodes.length && !cmd && !e.altKey) {
        done();
        const step = e.shiftKey ? 5 * GRID : GRID;
        nudgeExisting(pickedNodes, e.key === 'ArrowLeft' ? -step : e.key === 'ArrowRight' ? step : 0, e.key === 'ArrowUp' ? -step : e.key === 'ArrowDown' ? step : 0);
      } else if (e.key === 'Escape' && pickedNodes.length + pickedWires.length > 0) {
        select(null);
        setNodes((ns) => ns.map((n) => (n.selected ? { ...n, selected: false } : n)));
        setEdges((es) => es.map((x) => (x.selected ? { ...x, selected: false } : x)));
      } else if (cmd && k === 'a' && !e.shiftKey) {
        done();
        select(null);
        setNodes((ns) => ns.map((n) => ({ ...n, selected: true })));
      } else if (cmd && k === 'd' && pickedNodes.length) {
        done();
        duplicatePicked();
      } else if (cmd && k === 'c' && pickedNodes.length && !window.getSelection()?.toString()) {
        clipboard = { clip: copyOf(design, pickedNodes), pastes: 0 };
      } else if (cmd && k === 'v' && clipboard) {
        done();
        // each paste of the same copy lands a little further along, so they do not stack
        addCopies(clipboard.clip, ++clipboard.pastes);
      }
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [mode, design, pickedNodes, pickedWires, removePicked, duplicatePicked, addCopies, nudgeExisting, select, setNodes, setEdges]);

  // A wire end dragged to another terminal.
  const onReconnect = useCallback(
    (old: Edge, c: Connection) => {
      const w = design.wires.find((x) => x.id === old.id);
      if (!w || !c.source || !c.target || !c.sourceHandle || !c.targetHandle) return;
      const ends = [
        { node: c.source, term: c.sourceHandle },
        { node: c.target, term: c.targetHandle },
      ];
      const is = (x: { node: string; term: string }, y: { node: string; term: string }) => x.node === y.node && x.term === y.term;
      // One end of the new connection is the end of the wire that stayed put; the other is where the dragged end landed.
      const fromStays = ends.some((x) => is(x, w.from));
      const toStays = ends.some((x) => is(x, w.to));
      if (fromStays === toStays) return; // dropped back where it was
      const landed = ends.find((x) => !is(x, fromStays ? w.from : w.to))!;
      const result = reconnectExisting(w.id, fromStays ? 'to' : 'from', landed);
      setRefusal(result.ok ? null : result.why);
    },
    [design, reconnectExisting],
  );

  // A part dragged from the quick-add strip and dropped on the canvas.
  const onDropPart = useCallback(
    (e: React.DragEvent) => {
      const type = e.dataTransfer.getData(PART_MIME) as NodeType;
      if (!type || mode !== 'manual') return;
      e.preventDefault();
      const at = flowApi.screenToFlowPosition({ x: e.clientX, y: e.clientY });
      const n = paletteNode(type, useStore.getState().project.profile.batteryZone);
      n.pos = freeSpot(design, { x: at.x - 60, y: at.y - 25 });
      addExistingNode(n);
    },
    [mode, design, flowApi, addExistingNode],
  );

  const onConnect = useCallback(
    (c: Connection) => {
      if (!c.source || !c.target || !c.sourceHandle || !c.targetHandle) return;
      if (c.source === c.target) return;
      const pol = (node: string, term: string) => design.nodes.find((n) => n.id === node)?.terminals.find((t) => t.id === term)?.pol;
      const joined = joinTerminals(pol(c.source, c.sourceHandle), pol(c.target, c.targetHandle));
      if (!joined.ok) {
        setRefusal(joined.why);
        return;
      }
      setRefusal(null);
      connectExisting({ node: c.source, term: c.sourceHandle }, { node: c.target, term: c.targetHandle });
    },
    [connectExisting, design],
  );

  return (
    <div className="diagram">
      {busy && <div className="busy">Laying out…</div>}
      <ReactFlow
        nodes={nodes}
        edges={edges}
        nodeTypes={nodeTypes}
        edgeTypes={edgeTypes}
        onNodesChange={onNodesChange}
        onEdgesChange={onEdgesChange}
        onNodeClick={(e, n) => {
          // Shift / Ctrl / Cmd-click adds to what is selected; the canvas keeps track of the group.
          if (mode === 'manual' && (e.shiftKey || e.metaKey || e.ctrlKey)) select(null);
          else select({ kind: 'node', id: n.id, design: which });
        }}
        onEdgeClick={(_, e) => select({ kind: 'wire', id: e.id, design: which })}
        onPaneClick={() => select(null)}
        onNodeDragStop={(_, _n, moved) => saveMoved(moved)}
        onSelectionDragStop={(_, moved) => saveMoved(moved)}
        onSelectionChange={({ nodes: ns, edges: es }) => {
          // several things selected: the details panel shows one item at a time, so it steps aside
          if (ns.length + es.length > 1 && useStore.getState().selection) select(null);
        }}
        multiSelectionKeyCode={['Meta', 'Control', 'Shift']}
        selectionOnDrag={mode === 'manual' && boxMode}
        panOnDrag={!(mode === 'manual' && boxMode)}
        onConnect={onConnect}
        connectionMode={ConnectionMode.Loose}
        nodesConnectable={mode === 'manual'}
        deleteKeyCode={null}
        minZoom={0.1}
        maxZoom={2.5}
        snapToGrid={mode === 'manual'}
        snapGrid={[10, 10]}
        proOptions={{ hideAttribution: true }}
        onReconnect={mode === 'manual' ? onReconnect : undefined}
        edgesReconnectable={false}
        reconnectRadius={14}
        onDrop={onDropPart}
        onDragOver={(e) => {
          if (e.dataTransfer.types.includes(PART_MIME)) e.preventDefault();
        }}
        connectionLineStyle={{ stroke: 'var(--accent)', strokeWidth: 2 }}
      >
        <Background variant={BackgroundVariant.Dots} gap={20} size={1} color="var(--grid)" />
        <Controls showInteractive={false} />
        <MiniMap pannable zoomable nodeColor={(n) => ((n as SymbolFlowNode).data.laid.node.domain === 'ac' ? 'var(--w-ac)' : 'var(--mini)')} />
        {underlay && <UnderlayImage u={underlay} />}
        {mode === 'manual' && <UnderlayControls u={underlay} />}
        {mode === 'manual' && (
          <Panel position="top-left" className="draw-tools">
            <button
              className={boxMode ? 'on' : ''}
              aria-pressed={boxMode}
              data-tip="Select several components: drag a box around them on the empty canvas. With a keyboard you can also hold Shift and drag, or Shift-click components one by one."
              onClick={() => setBoxMode((v) => !v)}
            >
              Select area
            </button>
            {pickedNodes.length + pickedWires.length > 1 && (
              <span className="picked" role="status">
                <b>{pickedNodes.length + pickedWires.length} selected</b>
                {pickedNodes.length > 0 && (
                  <button data-tip="Make a copy of the selected components and the wires between them (Ctrl+D)." onClick={duplicatePicked}>
                    Duplicate
                  </button>
                )}
                <button className="danger" data-tip="Remove everything selected (Delete). You can undo this." onClick={removePicked}>
                  Delete
                </button>
              </span>
            )}
          </Panel>
        )}
        <ExportBridge />
      </ReactFlow>
      {refusal && (
        <div className="refusal" role="alert">
          <b>Wire not added.</b> {refusal}
          <button className="icon" aria-label="Dismiss" onClick={() => setRefusal(null)}>
            ×
          </button>
        </div>
      )}
    </div>
  );
}

/** Registers a global export function for the header's Export menu. */
function ExportBridge() {
  const { getNodes } = useReactFlow();
  useEffect(() => {
    (window as unknown as { boatwireExport?: (fmt: 'png' | 'svg') => Promise<void> }).boatwireExport = async (fmt) => {
      const nodes = getNodes();
      if (!nodes.length) return;
      const bounds = getNodesBounds(nodes);
      const pad = 40;
      const width = Math.ceil(bounds.width + pad * 2);
      const height = Math.ceil(bounds.height + pad * 2);
      const vp = getViewportForBounds(bounds, width, height, 0.1, 2, pad);
      const el = document.querySelector('.react-flow__viewport') as HTMLElement;
      const bg = getComputedStyle(document.body).getPropertyValue('--canvas').trim() || '#fff';
      const opts = {
        backgroundColor: bg,
        width,
        height,
        pixelRatio: 2,
        style: { width: `${width}px`, height: `${height}px`, transform: `translate(${vp.x}px, ${vp.y}px) scale(${vp.zoom})` },
      };
      const url = fmt === 'png' ? await toPng(el, opts) : await toSvg(el, opts);
      const a = document.createElement('a');
      a.href = url;
      a.download = `wiring-diagram.${fmt}`;
      a.click();
    };
  }, [getNodes]);
  return null;
}
