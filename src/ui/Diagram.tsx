import {
  Background,
  BackgroundVariant,
  ConnectionMode,
  Controls,
  MiniMap,
  ReactFlow,
  ReactFlowProvider,
  getNodesBounds,
  useEdgesState,
  useNodesInitialized,
  useNodesState,
  useReactFlow,
  useStoreApi,
  type Connection,
  type Node,
} from '@xyflow/react';
import { toPng, toSvg } from 'html-to-image';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { joinTerminals } from '../engine/connect';
import { estimateCurrents } from '../engine/audit';
import { autoLayout, cachedLayout, manualLayout, sameFootprint, viewShift, type Layout } from '../layout/layout';
import type { Design, Finding } from '../model/types';
import { severityByNode, useUnits } from '../state/derived';
import { useStore } from '../state/store';
import { SymbolNode, type SymbolFlowNode } from './symbols';
import { UnderlayControls, UnderlayImage } from './Underlay';
import { WireEdge, type WireFlowEdge } from './WireEdge';
import { Panel, useUpdateNodeInternals, type Edge } from '@xyflow/react';
import { copyOf, GRID, snapToGrid, type Clip } from '../engine/drawing';
import { paletteNode } from '../engine/existing';
import type { NodeType } from '../model/types';
import { registerViewCentre } from './viewCentre';

/** What was last copied from the drawing (Ctrl+C), and how many times it has been pasted since. */
let clipboard: { clip: Clip; pastes: number } | null = null;
/** dataTransfer type used when a part is dragged from the quick-add strip onto the canvas. */
export const PART_MIME = 'application/x-boatwire-part';

/** How long to give the canvas to measure rebuilt components before doing it for it. */
const REMEASURE_AFTER_MS = 150;

const nodeTypes = { sym: SymbolNode };
const edgeTypes = { wire: WireEdge };

/** Pause after the last edit before the diagram is re-arranged, so typing a value does not redraw per key. */
const RELAYOUT_DELAY_MS = 300;

interface Props {
  design: Design;
  findings: Finding[];
  mode: 'auto' | 'manual';
  /** Static picture mode (printable report): no selection, dragging, wiring or controls. */
  readOnly?: boolean;
  /** With readOnly: called with a PNG of the whole diagram once it has been laid out. */
  onSnapshot?: (pngDataUrl: string) => void;
}

export function Diagram(props: Props) {
  return (
    <ReactFlowProvider>
      <DiagramInner {...props} />
    </ReactFlowProvider>
  );
}

function DiagramInner({ design, findings, mode, readOnly, onSnapshot }: Props) {
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
  const containerRef = useRef<HTMLDivElement>(null);
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
    // Keep what was selected. Newly pasted or duplicated components are selected instead, once the
    // layout that contains them has arrived.
    const want = selectNext.current;
    const fresh = want && layout.nodes.some((ln) => want.has(ln.id)) ? want : null;
    if (fresh) selectNext.current = null;
    setNodes((prev) => {
      const picked = fresh ?? new Set(prev.filter((n) => n.selected).map((n) => n.id));
      const before = new Map(prev.map((n) => [n.id, n]));
      return layout.nodes.map((ln) => {
        // A component whose box and terminals have not moved keeps what the canvas measured for it.
        // Without `measured` the canvas forgets where the terminals are and has to find them again
        // before it can draw any wire to the component, on every edit (see the safety net below).
        const was = before.get(ln.id);
        const measured = was?.measured && sameFootprint(was.data.laid, ln) ? was.measured : undefined;
        return {
          id: ln.id,
          type: 'sym' as const,
          position: { x: ln.x, y: ln.y },
          data: { laid: ln, severity: severities.get(ln.id), showParts: layers.labels.parts, manual: mode === 'manual' },
          selected: selection ? selection.kind === 'node' && selection.id === ln.id : picked.has(ln.id),
          width: ln.w,
          height: ln.h,
          ...(measured ? { measured } : {}),
        };
      });
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [layout, severities, layers.labels.parts, mode]);

  /**
   * How a wire is drawn when it is (or is not) selected. On the existing-boat drawing the one wire
   * selected in the app can have either end dragged to another terminal: it gets a grip on the
   * wire beside each end (beside, so the terminal dot itself still starts a new wire).
   */
  const wireState = (id: string, signal: boolean, selected: boolean) => {
    const movable = selected && mode === 'manual' && !readOnly && selection?.kind === 'wire' && selection.id === id && design.wires.some((w) => w.id === id);
    return { selected, reconnectable: movable, zIndex: signal ? 0 : 1 };
  };

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
          ...wireState(le.id, w.kind === 'sig', selection?.kind === 'wire' && selection.id === le.id),
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
    setEdges((es) => es.map((e) => ({ ...e, ...wireState(e.id, e.data?.wire.kind === 'sig', selection ? selection.kind === 'wire' && selection.id === e.id : !!e.selected) })));
    if (selection?.kind === 'node') {
      const n = nodes.find((x) => x.id === selection.id);
      if (n && !n.selected) fitView({ nodes: [{ id: n.id }], duration: 400, maxZoom: 1.2, padding: 0.6 });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selection]);

  const initialized = useNodesInitialized();

  // Safety net. When a component is rebuilt without its measurements, the canvas measures it again
  // only if it notices the change. Two rebuilds close together (an edit made just as the diagram
  // first appears, for instance) can slip past that, and the component is then left with no known
  // terminals: every wire to it disappears and stays gone. So if the diagram has not settled
  // shortly after a rebuild, measure whatever is still unmeasured ourselves.
  const updateNodeInternals = useUpdateNodeInternals();
  useEffect(() => {
    if (initialized || !nodes.length) return;
    const t = setTimeout(() => {
      const stuck = [...flow.getState().nodeLookup.values()].filter((n) => !n.internals.handleBounds).map((n) => n.id);
      if (stuck.length) updateNodeInternals(stuck);
    }, REMEASURE_AFTER_MS);
    return () => clearTimeout(t);
  }, [initialized, nodes, flow, updateNodeInternals]);
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
  const [refusal, setRefusal] = useState<{ why: string; moved?: boolean } | null>(null);
  useEffect(() => {
    if (!refusal) return;
    const t = setTimeout(() => setRefusal(null), 8000);
    return () => clearTimeout(t);
  }, [refusal]);

  // ------------------------------------------------------------ drawing tools (Existing boat)
  /** The existing-boat drawing, shown for editing (not the read-only picture in the printable report). */
  const editing = mode === 'manual' && !readOnly;
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
    if (!editing) return;
    registerViewCentre(() => {
      const { width, height } = flow.getState();
      const vp = flowApi.getViewport();
      return { x: (width / 2 - vp.x) / vp.zoom - 70, y: (height / 2 - vp.y) / vp.zoom - 30 };
    });
    return () => registerViewCentre(null);
  }, [editing, flow, flowApi]);

  /** Save where dragged components ended up: all of them in one step, so one undo puts them back. */
  const saveMoved = useCallback(
    (moved: Node[]) => {
      if (!editing || !moved.length) return;
      updateExisting((d) => {
        for (const m of moved) {
          const n = d.nodes.find((x) => x.id === m.id);
          if (n) n.pos = { x: Math.round(m.position.x), y: Math.round(m.position.y) };
        }
      });
    },
    [editing, updateExisting],
  );

  // Wires attached to a selected component go with it, so only the others are worth counting.
  const pickedSummary = useMemo(() => {
    const on = new Set(pickedNodes);
    const loose = pickedWires.filter((id) => {
      const w = design.wires.find((x) => x.id === id);
      return w && !on.has(w.from.node) && !on.has(w.to.node);
    }).length;
    const many = (n: number, one: string) => `${n} ${one}${n === 1 ? '' : 's'}`;
    return `${[pickedNodes.length ? many(pickedNodes.length, 'component') : '', loose ? many(loose, 'wire') : ''].filter(Boolean).join(' and ')} selected`;
  }, [design, pickedNodes, pickedWires]);

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
        offset = { x: snapToGrid(mid.x - (Math.min(...xs) + Math.max(...xs)) / 2 - 60), y: snapToGrid(mid.y - (Math.min(...ys) + Math.max(...ys)) / 2 - 30) };
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
    if (!editing) return;
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
      } else if (cmd && k === 'c' && pickedNodes.length) {
        // not prevented: any selected text is still copied by the browser as usual
        clipboard = { clip: copyOf(design, pickedNodes), pastes: 0 };
      } else if (cmd && k === 'v' && clipboard) {
        done();
        // each paste of the same copy lands a little further along, so they do not stack
        addCopies(clipboard.clip, ++clipboard.pastes);
      }
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [editing, design, pickedNodes, pickedWires, removePicked, duplicatePicked, addCopies, nudgeExisting, select, setNodes, setEdges]);

  /**
   * True while a wire end is being dragged, and for the click the browser reports on the canvas
   * when the drag is let go. That click must not clear the selection: the wire stays selected so
   * its other end can be moved next.
   */
  const movingWireEnd = useRef(false);

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
      setRefusal(result.ok ? null : { why: result.why, moved: true });
    },
    [design, reconnectExisting],
  );

  // A part dragged from the quick-add strip and dropped on the canvas.
  const onDropPart = useCallback(
    (e: React.DragEvent) => {
      const type = e.dataTransfer.getData(PART_MIME) as NodeType;
      if (!type || !editing) return;
      e.preventDefault();
      const at = flowApi.screenToFlowPosition({ x: e.clientX, y: e.clientY });
      const n = paletteNode(type, useStore.getState().project.profile.batteryZone);
      // it goes exactly where it was dropped (the pointer ends up over the middle of a typical part)
      n.pos = { x: snapToGrid(at.x - 60), y: snapToGrid(at.y - 25) };
      addExistingNode(n);
    },
    [editing, flowApi, addExistingNode],
  );

  const onConnect = useCallback(
    (c: Connection) => {
      if (!c.source || !c.target || !c.sourceHandle || !c.targetHandle) return;
      if (c.source === c.target) return;
      const pol = (node: string, term: string) => design.nodes.find((n) => n.id === node)?.terminals.find((t) => t.id === term)?.pol;
      const joined = joinTerminals(pol(c.source, c.sourceHandle), pol(c.target, c.targetHandle));
      if (!joined.ok) {
        setRefusal({ why: joined.why });
        return;
      }
      setRefusal(null);
      connectExisting({ node: c.source, term: c.sourceHandle }, { node: c.target, term: c.targetHandle });
    },
    [connectExisting, design],
  );

  // Read-only picture: once nodes are measured and edges drawn, render the whole diagram to a PNG.
  const { getNodes } = useReactFlow();
  useEffect(() => {
    if (!readOnly || !onSnapshot || !initialized || !nodes.length || !layout) return;
    let cancelled = false;
    const t = setTimeout(async () => {
      const el = containerRef.current?.querySelector('.react-flow__viewport') as HTMLElement | null;
      if (!el || cancelled) return;
      try {
        const url = await renderDiagram(el, getNodes(), 'png');
        if (!cancelled && url) onSnapshot(url);
      } catch (e) {
        console.error('diagram snapshot failed', e);
      }
    }, 250);
    return () => {
      cancelled = true;
      clearTimeout(t);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [readOnly, initialized, nodes, edges, layout]);

  const interactive = !readOnly;
  return (
    <div className="diagram" ref={containerRef}>
      {busy && <div className="busy">Laying out…</div>}
      <ReactFlow
        nodes={nodes}
        edges={edges}
        nodeTypes={nodeTypes}
        edgeTypes={edgeTypes}
        onNodesChange={onNodesChange}
        onEdgesChange={onEdgesChange}
        onNodeClick={
          interactive
            ? (e, n) => {
                // Shift / Ctrl / Cmd-click adds to what is selected; the canvas keeps track of the group.
                if (editing && (e.shiftKey || e.metaKey || e.ctrlKey)) select(null);
                else select({ kind: 'node', id: n.id, design: which });
              }
            : undefined
        }
        onEdgeClick={interactive ? (_, e) => select({ kind: 'wire', id: e.id, design: which }) : undefined}
        onPaneClick={interactive ? () => !movingWireEnd.current && select(null) : undefined}
        onNodeDragStop={(_, _n, moved) => saveMoved(moved)}
        onSelectionDragStop={(_, moved) => saveMoved(moved)}
        onSelectionChange={({ nodes: ns, edges: es }) => {
          // several things selected: the details panel shows one item at a time, so it steps aside
          if (editing && ns.length + es.length > 1 && useStore.getState().selection) select(null);
        }}
        multiSelectionKeyCode={['Meta', 'Control', 'Shift']}
        selectionOnDrag={editing && boxMode}
        panOnDrag={!(editing && boxMode)}
        onConnect={onConnect}
        connectionMode={ConnectionMode.Loose}
        nodesConnectable={mode === 'manual' && interactive}
        nodesDraggable={interactive}
        elementsSelectable={interactive}
        deleteKeyCode={null}
        minZoom={0.1}
        maxZoom={2.5}
        snapToGrid={mode === 'manual'}
        snapGrid={[10, 10]}
        proOptions={{ hideAttribution: true }}
        onReconnect={editing ? onReconnect : undefined}
        onReconnectStart={() => (movingWireEnd.current = true)}
        onReconnectEnd={() => setTimeout(() => (movingWireEnd.current = false), 0)}
        edgesReconnectable={false}
        reconnectRadius={14}
        onDrop={onDropPart}
        onDragOver={(e) => {
          if (e.dataTransfer.types.includes(PART_MIME)) e.preventDefault();
        }}
        connectionLineStyle={{ stroke: 'var(--accent)', strokeWidth: 2 }}
      >
        <Background variant={BackgroundVariant.Dots} gap={20} size={1} color="var(--grid)" />
        {interactive && <Controls showInteractive={false} />}
        {interactive && <MiniMap pannable zoomable nodeColor={(n) => ((n as SymbolFlowNode).data.laid.node.domain === 'ac' ? 'var(--w-ac)' : 'var(--mini)')} />}
        {underlay && <UnderlayImage u={underlay} />}
        {editing && <UnderlayControls u={underlay} />}
        {editing && (
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
                <b>{pickedSummary}</b>
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
        {interactive && <ExportBridge />}
      </ReactFlow>
      {refusal && (
        <div className="refusal" role="alert">
          <b>{refusal.moved ? 'Wire not moved.' : 'Wire not added.'}</b> {refusal.why}
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
      const el = document.querySelector('.react-flow__viewport') as HTMLElement;
      const url = await renderDiagram(el, getNodes(), fmt);
      if (!url) return;
      const a = document.createElement('a');
      a.href = url;
      a.download = `wiring-diagram.${fmt}`;
      a.click();
    };
  }, [getNodes]);
  return null;
}

/** Render a React Flow viewport, framed around all its nodes, to a PNG or SVG data URL. */
async function renderDiagram(el: HTMLElement, nodes: Node[], fmt: 'png' | 'svg'): Promise<string | undefined> {
  if (!nodes.length) return undefined;
  const bounds = getNodesBounds(nodes);
  const pad = 40;
  const width = Math.ceil(bounds.width + pad * 2);
  const height = Math.ceil(bounds.height + pad * 2);
  // The frame is the diagram plus a fixed margin, so draw it 1:1, shifted into the frame.
  // (getViewportForBounds takes padding as a fraction, so passing pixels shrank the drawing to a speck.)
  const vp = { x: pad - bounds.x, y: pad - bounds.y, zoom: 1 };
  const bg = getComputedStyle(document.body).getPropertyValue('--canvas').trim() || '#fff';
  const opts = {
    backgroundColor: bg,
    width,
    height,
    pixelRatio: 2,
    style: { width: `${width}px`, height: `${height}px`, transform: `translate(${vp.x}px, ${vp.y}px) scale(${vp.zoom})` },
  };
  return fmt === 'png' ? toPng(el, opts) : toSvg(el, opts);
}
