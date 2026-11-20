import { BaseEdge, EdgeLabelRenderer, getSmoothStepPath, type Edge, type EdgeProps } from '@xyflow/react';
import { memo } from 'react';
import { gaugeIndex, isUnsized } from '../engine/calc';
import type { LayerSettings, Units, Wire } from '../model/types';
import { cableLabel, fmtLen } from '../model/units';

export type WireData = {
  wire: Wire;
  /** Feet + AWG or metres + mm² for the label. */
  units?: Units;
  points?: { x: number; y: number }[];
  labels: LayerSettings['labels'];
  amps?: number;
  protection?: string;
  /** Existing boat: why this wire differs from the ideal design, when it does and the marking is on. */
  differs?: string;
};
export type WireFlowEdge = Edge<WireData, 'wire'>;

const STROKE: Record<Wire['kind'], string> = {
  pos: 'var(--w-pos)',
  neg: 'var(--w-neg)',
  ac: 'var(--w-ac)',
  gnd: 'var(--w-gnd)',
  sig: 'var(--w-sig)',
};

export function wireWidth(w: Wire): number {
  if (w.kind === 'sig') return 1.2;
  const i = w.gauge ? gaugeIndex(w.gauge) : 1;
  const runs = w.cable?.match(/^(\d+)×/) ? 1.4 : 1;
  return Math.min(7, (1.3 + Math.max(0, i) * 0.38) * runs);
}

export function wireLabel(d: WireData): string {
  const w = d.wire;
  const parts: string[] = [];
  const L = d.labels;
  const units = d.units ?? 'imperial';
  // A wire nobody has sized yet always says so: it is not being checked.
  if (isUnsized(w)) parts.push('size?');
  if (L.gauge && w.gauge && w.kind !== 'sig') parts.push(cableLabel(w, units)!);
  if (L.current && d.amps !== undefined && w.kind !== 'sig' && w.kind !== 'gnd') parts.push(`${d.amps >= 10 ? Math.round(d.amps) : d.amps.toFixed(1)} A`);
  if (L.length && w.kind !== 'sig') parts.push(fmtLen(w.lengthFt, units));
  if (L.vdrop && w.vdropPct !== undefined && w.kind !== 'neg') parts.push(`${w.vdropPct.toFixed(1)}%`);
  // A wire drawn through a hidden fuse always says so, even with fuse labels off.
  if (d.protection && (L.protection || w.viaFuse)) parts.push(d.protection);
  return parts.join(' · ');
}

function WireEdgeImpl(props: EdgeProps<WireFlowEdge>) {
  const { id, sourceX, sourceY, targetX, targetY, sourcePosition, targetPosition, data, selected } = props;
  if (!data) return null;
  const w = data.wire;
  let path: string;
  let lx: number;
  let ly: number;
  const pts = data.points;
  const close = (a: { x: number; y: number }, x: number, y: number) => Math.abs(a.x - x) < 10 && Math.abs(a.y - y) < 10;
  if (pts && pts.length >= 2 && close(pts[0], sourceX, sourceY) && close(pts[pts.length - 1], targetX, targetY)) {
    const p = pts.map((q) => ({ ...q }));
    // snap ends to handle centres and keep segments orthogonal
    const first = p[0];
    const last = p[p.length - 1];
    if (p.length > 2 && Math.abs(p[1].y - first.y) < 0.5) p[1].y = sourceY;
    if (p.length > 2 && Math.abs(p[p.length - 2].y - last.y) < 0.5) p[p.length - 2].y = targetY;
    p[0] = { x: sourceX, y: sourceY };
    p[p.length - 1] = { x: targetX, y: targetY };
    // Guarantee every segment is horizontal or vertical (insert elbows where needed).
    const orth: { x: number; y: number }[] = [p[0]];
    for (let i = 1; i < p.length; i++) {
      const a = orth[orth.length - 1];
      const b = p[i];
      if (Math.abs(a.x - b.x) > 0.5 && Math.abs(a.y - b.y) > 0.5) {
        // last segment must arrive horizontally at the target handle
        orth.push(i === p.length - 1 ? { x: a.x, y: b.y } : { x: b.x, y: a.y });
      }
      orth.push(b);
    }
    // Drop middle points of collinear runs (removes spikes where a route doubles back).
    for (let i = 1; i < orth.length - 1; ) {
      const a = orth[i - 1];
      const b = orth[i];
      const c = orth[i + 1];
      const collinear = (Math.abs(a.x - b.x) < 0.5 && Math.abs(b.x - c.x) < 0.5) || (Math.abs(a.y - b.y) < 0.5 && Math.abs(b.y - c.y) < 0.5);
      if (collinear) orth.splice(i, 1);
      else i++;
    }
    p.splice(0, p.length, ...orth);
    path = p.map((q, i) => `${i ? 'L' : 'M'}${q.x},${q.y}`).join(' ');
    // label on the longest horizontal segment
    let best = 0;
    lx = (sourceX + targetX) / 2;
    ly = (sourceY + targetY) / 2;
    for (let i = 0; i < p.length - 1; i++) {
      const a = p[i];
      const b = p[i + 1];
      const len = Math.abs(b.x - a.x);
      if (Math.abs(a.y - b.y) < 1 && len > best) {
        best = len;
        lx = (a.x + b.x) / 2;
        ly = a.y;
      }
    }
  } else {
    [path, lx, ly] = getSmoothStepPath({ sourceX, sourceY, targetX, targetY, sourcePosition, targetPosition, borderRadius: 4, offset: 14 });
  }
  const label = wireLabel(data);
  const width = wireWidth(w);
  return (
    // A wire marked as different from the ideal design says how on hover (the app-wide tooltip).
    <g data-tip={data.differs}>
      {data.differs && <path className="wire-differs" d={path} fill="none" stroke="var(--warn)" strokeWidth={width + 7} strokeOpacity={0.45} strokeDasharray="7 5" strokeLinejoin="round" />}
      {selected && <path d={path} fill="none" stroke="var(--accent)" strokeWidth={width + 6} strokeOpacity={0.35} />}
      <BaseEdge
        id={id}
        path={path}
        interactionWidth={14}
        style={{
          stroke: STROKE[w.kind],
          strokeWidth: width,
          strokeDasharray: isUnsized(w) ? '1.5 5' : w.kind === 'sig' ? '4 3' : w.kind === 'gnd' && w.equipmentGround ? '6 3' : undefined,
          strokeLinecap: isUnsized(w) ? 'round' : undefined,
          strokeLinejoin: 'round',
        }}
      />
      {label && (
        <EdgeLabelRenderer>
          <div className={`wlabel wl-${w.kind}${isUnsized(w) ? ' wl-unsized' : ''}`} style={{ transform: `translate(-50%, -115%) translate(${lx}px, ${ly}px)` }}>
            {label}
          </div>
        </EdgeLabelRenderer>
      )}
    </g>
  );
}

export const WireEdge = memo(WireEdgeImpl);
