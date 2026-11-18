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
  type Connection,
  type Node,
} from '@xyflow/react';
import { toPng, toSvg } from 'html-to-image';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { estimateCurrents } from '../engine/audit';
import { autoLayout, manualLayout, type Layout } from '../layout/layout';
import type { Design, Finding } from '../model/types';
import { severityByNode } from '../state/derived';
import { useStore } from '../state/store';
import { SymbolNode, type SymbolFlowNode } from './symbols';
import { UnderlayControls, UnderlayImage } from './Underlay';
import { WireEdge, type WireFlowEdge } from './WireEdge';

const nodeTypes = { sym: SymbolNode };
const edgeTypes = { wire: WireEdge };

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
  const deleteSelection = useStore((s) => s.deleteSelection);
  const { fitView, fitBounds } = useReactFlow();
  const [layout, setLayout] = useState<Layout | null>(null);
  const [busy, setBusy] = useState(false);
  const [nodes, setNodes, onNodesChange] = useNodesState<SymbolFlowNode>([]);
  const [edges, setEdges, onEdgesChange] = useEdgesState<WireFlowEdge>([]);
  const fitPending = useRef(true);
  const containerRef = useRef<HTMLDivElement>(null);
  const which = mode === 'auto' ? 'ideal' : 'existing';

  const structural = `${layers.panelLoads}|${layers.fuses}|${layers.dc}|${layers.ac}|${layers.negatives}|${layers.signal}|${layers.grounding}`;

  useEffect(() => {
    let cancelled = false;
    if (mode === 'auto') {
      setBusy(true);
      autoLayout(design, layers)
        .then((l) => {
          if (!cancelled) {
            setLayout(l);
            fitPending.current = true;
          }
        })
        .catch((e) => console.error('layout failed', e))
        .finally(() => !cancelled && setBusy(false));
    } else {
      setLayout(manualLayout(design, layers));
    }
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [design, mode, structural, nonce]);

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

  const onConnect = useCallback(
    (c: Connection) => {
      if (!c.source || !c.target || !c.sourceHandle || !c.targetHandle) return;
      if (c.source === c.target) return;
      connectExisting({ node: c.source, term: c.sourceHandle }, { node: c.target, term: c.targetHandle });
    },
    [connectExisting],
  );

  useEffect(() => {
    if (mode !== 'manual' || readOnly) return;
    const onKey = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement)?.tagName;
      if (tag === 'INPUT' || tag === 'SELECT' || tag === 'TEXTAREA') return;
      if (e.key === 'Delete' || e.key === 'Backspace') deleteSelection();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [mode, readOnly, deleteSelection]);

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
        onNodeClick={interactive ? (_, n) => select({ kind: 'node', id: n.id, design: which }) : undefined}
        onEdgeClick={interactive ? (_, e) => select({ kind: 'wire', id: e.id, design: which }) : undefined}
        onPaneClick={interactive ? () => select(null) : undefined}
        onNodeDragStop={(_, n) => {
          if (mode !== 'manual' || readOnly) return;
          updateExisting((d) => {
            const dn = d.nodes.find((x) => x.id === n.id);
            if (dn) dn.pos = { x: Math.round(n.position.x), y: Math.round(n.position.y) };
          });
        }}
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
        connectionLineStyle={{ stroke: 'var(--accent)', strokeWidth: 2 }}
      >
        <Background variant={BackgroundVariant.Dots} gap={20} size={1} color="var(--grid)" />
        {interactive && <Controls showInteractive={false} />}
        {interactive && <MiniMap pannable zoomable nodeColor={(n) => ((n as SymbolFlowNode).data.laid.node.domain === 'ac' ? 'var(--w-ac)' : 'var(--mini)')} />}
        {underlay && <UnderlayImage u={underlay} />}
        {mode === 'manual' && interactive && <UnderlayControls u={underlay} />}
        {interactive && <ExportBridge />}
      </ReactFlow>
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
