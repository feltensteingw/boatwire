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
import { severityByNode } from '../state/derived';
import { useStore } from '../state/store';
import { SymbolNode, type SymbolFlowNode } from './symbols';
import { UnderlayControls, UnderlayImage } from './Underlay';
import { WireEdge, type WireFlowEdge } from './WireEdge';

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
  const deleteSelection = useStore((s) => s.deleteSelection);
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

  const severities = useMemo(() => severityByNode(findings), [findings]);
  const currents = useMemo(() => estimateCurrents(design), [design]);

  useEffect(() => {
    if (!layout) return;
    setNodes(
      layout.nodes.map((ln) => ({
        id: ln.id,
        type: 'sym',
        position: { x: ln.x, y: ln.y },
        data: { laid: ln, severity: severities.get(ln.id), showParts: layers.labels.parts, manual: mode === 'manual' },
        selected: selection?.kind === 'node' && selection.id === ln.id,
        width: ln.w,
        height: ln.h,
      })),
    );
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
          data: { wire: w, points: le.points, labels: layers.labels, amps: w.amps ?? currents.get(w.id), protection },
          selected: selection?.kind === 'wire' && selection.id === le.id,
          zIndex: w.kind === 'sig' ? 0 : 1,
        };
      }),
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [layout, layers.labels, currents]);

  // reflect external selection (e.g. clicking a finding)
  useEffect(() => {
    setNodes((ns) => ns.map((n) => ({ ...n, selected: selection?.kind === 'node' && selection.id === n.id })));
    setEdges((es) => es.map((e) => ({ ...e, selected: selection?.kind === 'wire' && selection.id === e.id })));
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

  useEffect(() => {
    if (mode !== 'manual') return;
    const onKey = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement)?.tagName;
      if (tag === 'INPUT' || tag === 'SELECT' || tag === 'TEXTAREA') return;
      if (e.key === 'Delete' || e.key === 'Backspace') deleteSelection();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [mode, deleteSelection]);

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
        onNodeClick={(_, n) => select({ kind: 'node', id: n.id, design: which })}
        onEdgeClick={(_, e) => select({ kind: 'wire', id: e.id, design: which })}
        onPaneClick={() => select(null)}
        onNodeDragStop={(_, n) => {
          if (mode !== 'manual') return;
          updateExisting((d) => {
            const dn = d.nodes.find((x) => x.id === n.id);
            if (dn) dn.pos = { x: Math.round(n.position.x), y: Math.round(n.position.y) };
          });
        }}
        onConnect={onConnect}
        connectionMode={ConnectionMode.Loose}
        nodesConnectable={mode === 'manual'}
        deleteKeyCode={null}
        minZoom={0.1}
        maxZoom={2.5}
        snapToGrid={mode === 'manual'}
        snapGrid={[10, 10]}
        proOptions={{ hideAttribution: true }}
        connectionLineStyle={{ stroke: 'var(--accent)', strokeWidth: 2 }}
      >
        <Background variant={BackgroundVariant.Dots} gap={20} size={1} color="var(--grid)" />
        <Controls showInteractive={false} />
        <MiniMap pannable zoomable nodeColor={(n) => ((n as SymbolFlowNode).data.laid.node.domain === 'ac' ? 'var(--w-ac)' : 'var(--mini)')} />
        {underlay && <UnderlayImage u={underlay} />}
        {mode === 'manual' && <UnderlayControls u={underlay} />}
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
