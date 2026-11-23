// Focus: look at one part of the wiring job on its own. Sits in the corner of the diagram, so it
// costs no room in the option bars above it.

import { FOCUS_OPTIONS } from '../engine/focus';
import type { Focus } from '../model/types';
import { useStore } from '../state/store';

const PARTS = FOCUS_OPTIONS.filter((o) => o.id !== 'all')
  .map((o) => `${o.label}: ${o.tip}`)
  .join('\n');

export function FocusPicker({ manual }: { manual: boolean }) {
  const focus = useStore((s) => s.layers.focus ?? 'all');
  const setLayers = useStore((s) => s.setLayers);
  const extra = manual ? ' On your drawing the rest is faded, and "Size wires & fuses" works on this part only.' : '';
  return (
    <select
      aria-label="Focus on one part of the wiring"
      className={`focus-pick${focus !== 'all' ? ' focus-on' : ''}`}
      value={focus}
      onChange={(e) => setLayers((l) => ({ ...l, focus: e.target.value as Focus }))}
      data-tip={`Look at one part of the wiring job on its own.${extra}\n${PARTS}`}
    >
      {FOCUS_OPTIONS.map((o) => (
        <option key={o.id} value={o.id}>
          {o.id === 'all' ? 'Focus: whole boat' : `Focus: ${o.label}`}
        </option>
      ))}
    </select>
  );
}
