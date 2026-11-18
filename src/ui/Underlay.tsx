// Trace-over underlay: the user's own wiring diagram (photo, scan or PDF) shown faded behind the Existing boat drawing.

import { Panel, ViewportPortal, getNodesBounds, useReactFlow, useStore as useFlowStore } from '@xyflow/react';
import { useEffect, useRef, useState, type PointerEvent as RPointerEvent } from 'react';
import type { Underlay } from '../model/types';
import { roundRect, scaleRect, type Rect } from '../model/underlay';
import { useStore } from '../state/store';
import { UNDERLAY_ACCEPT, underlayFromFile } from './underlayFile';

/** The image itself, rendered in diagram coordinates beneath wires and components. */
export function UnderlayImage({ u }: { u: Underlay }) {
  const { getViewport } = useReactFlow();
  const updateExisting = useStore((s) => s.updateExisting);
  const zoom = useFlowStore((s) => s.transform[2]);
  const [rect, setRect] = useState<Rect>(u);
  const drag = useRef<{ mode: 'move' | 'scale'; sx: number; sy: number; r: Rect } | null>(null);

  useEffect(() => setRect({ x: u.x, y: u.y, width: u.width, height: u.height }), [u.x, u.y, u.width, u.height]);

  if (!u.visible) return null;

  const start = (mode: 'move' | 'scale') => (e: RPointerEvent<HTMLDivElement>) => {
    if (u.locked || e.button !== 0) return;
    e.stopPropagation();
    e.preventDefault();
    e.currentTarget.setPointerCapture(e.pointerId);
    drag.current = { mode, sx: e.clientX, sy: e.clientY, r: rect };
  };
  const move = (e: RPointerEvent<HTMLDivElement>) => {
    const d = drag.current;
    if (!d) return;
    const z = getViewport().zoom || 1;
    const dx = (e.clientX - d.sx) / z;
    const dy = (e.clientY - d.sy) / z;
    setRect(d.mode === 'move' ? { ...d.r, x: d.r.x + dx, y: d.r.y + dy } : scaleRect(d.r, dx));
  };
  const end = () => {
    if (!drag.current) return;
    drag.current = null;
    const r = roundRect(rect);
    updateExisting((d) => {
      if (d.underlay) Object.assign(d.underlay, r);
    });
  };

  return (
    <ViewportPortal>
      <div
        className={`underlay nopan nodrag ${u.locked ? 'locked' : 'adjusting'}`}
        style={{ transform: `translate(${rect.x}px, ${rect.y}px)`, width: rect.width, height: rect.height, ['--inv-zoom' as string]: 1 / (zoom || 1) }}
        onPointerDown={start('move')}
        onPointerMove={move}
        onPointerUp={end}
        onPointerCancel={end}
      >
        <img src={u.src} alt="" draggable={false} style={{ opacity: u.opacity }} />
        {!u.locked && <div className="underlay-handle nopan nodrag" onPointerDown={start('scale')} title="Drag to resize" />}
      </div>
    </ViewportPortal>
  );
}

/** Upload / adjust controls, floating in the top-right corner of the Existing boat canvas. */
export function UnderlayControls({ u }: { u?: Underlay }) {
  const updateExisting = useStore((s) => s.updateExisting);
  const { getNodes, fitBounds } = useReactFlow();
  const fileRef = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);

  const patch = (p: Partial<Underlay>) =>
    updateExisting((d) => {
      if (d.underlay) Object.assign(d.underlay, p);
    });

  const onFile = async (file: File) => {
    setBusy(true);
    try {
      const nodes = getNodes();
      const next = await underlayFromFile(file, { previous: u, nodeBounds: nodes.length ? getNodesBounds(nodes) : null });
      updateExisting((d) => {
        d.underlay = next;
      });
      fitBounds(next, { padding: 0.08, duration: 400 });
    } catch (err) {
      alert(`Could not use that file: ${(err as Error).message}`);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Panel position="top-right" className="underlay-panel">
      <input
        ref={fileRef}
        type="file"
        accept={UNDERLAY_ACCEPT}
        hidden
        onChange={(e) => {
          const f = e.target.files?.[0];
          e.target.value = '';
          if (f) void onFile(f);
        }}
      />
      {!u ? (
        <button
          disabled={busy}
          onClick={() => fileRef.current?.click()}
          data-tip="Upload a photo, scan or PDF of your boat's wiring diagram. It appears faded behind the canvas so you can trace over it with BoatWire components. It stays in your browser and in your saved project."
        >
          {busy ? 'Reading…' : '⤒ Trace over my diagram…'}
        </button>
      ) : (
        <div className="underlay-bar">
          <label data-tip="Show or hide your uploaded diagram.">
            <input type="checkbox" checked={u.visible} onChange={(e) => patch({ visible: e.target.checked })} />
            <span className="underlay-name">{u.name}</span>
          </label>
          <input
            type="range"
            min={0.1}
            max={1}
            step={0.05}
            value={u.opacity}
            disabled={!u.visible}
            onChange={(e) => patch({ opacity: Number(e.target.value) })}
            data-tip="How strongly the uploaded diagram shows through."
            aria-label="Underlay opacity"
          />
          <button
            className={u.locked ? '' : 'on'}
            disabled={!u.visible}
            onClick={() => patch({ locked: !u.locked })}
            data-tip={u.locked ? 'Unlock to move the diagram (drag it) or resize it (drag the corner handle).' : 'Lock the diagram in place so clicks and panning go to your drawing.'}
          >
            {u.locked ? 'Adjust' : 'Lock'}
          </button>
          <button disabled={!u.visible} onClick={() => fitBounds(u, { padding: 0.08, duration: 400 })} data-tip="Zoom to show the whole uploaded diagram.">
            Fit
          </button>
          <button disabled={busy} onClick={() => fileRef.current?.click()} data-tip="Replace it with a different file, keeping the position and size.">
            {busy ? '…' : 'Replace'}
          </button>
          <button
            className="link danger"
            onClick={() => {
              if (window.confirm('Remove the uploaded diagram? Your drawing is not affected.'))
                updateExisting((d) => {
                  delete d.underlay;
                });
            }}
            data-tip="Remove the uploaded diagram. Your drawing is not affected."
          >
            ✕
          </button>
        </div>
      )}
    </Panel>
  );
}
