// The words on a "Size wires & fuses" mark: a short tag on the drawing and a longer tooltip.

import type { DNode, FixMark, Units, Wire } from '../model/types';
import { cableLabel } from '../model/units';

export function wireMarkText(m: FixMark, w: Pick<Wire, 'kind'>, units: Units): { tag: string; tip: string } {
  if (m.kind === 'added') return { tag: 'NEW', tip: 'Added by "Size wires & fuses": a new wire to fit.' };
  if (m.kind === 'set') return { tag: 'SIZE SET', tip: 'This wire had no size; "Size wires & fuses" set the size it needs. Check what is fitted.' };
  const parallel = m.wasGauge?.match(/^(\d+)× (.+)$/);
  const was = m.wasGauge ? cableLabel({ gauge: parallel ? parallel[2] : m.wasGauge, cable: parallel ? m.wasGauge : undefined, kind: w.kind }, units) : undefined;
  return { tag: was ? `was ${was}` : 'UPGRADE', tip: `Upgrade: this wire${was ? ` (${was} as drawn)` : ''} is too small. Replace it with the size shown.` };
}

export function nodeMarkText(m: FixMark, n: Pick<DNode, 'terminals'>): { tag: string; tip: string } {
  if (m.kind === 'added') return { tag: 'NEW', tip: 'Added by "Size wires & fuses": a new fuse to fit, with the rating shown.' };
  const positions = (m.positions ?? []).map((p) => {
    const t = n.terminals.find((x) => x.id === p.term);
    return `${t?.label ?? p.term}${p.was !== undefined ? ` (was ${p.was} A)` : ''}`;
  });
  if (m.kind === 'set') return { tag: 'RATING SET', tip: `This had no rating; "Size wires & fuses" set the rating it needs${positions.length ? `: ${positions.join(', ')}` : ''}. Check what is fitted.` };
  if (m.wasRating !== undefined) return { tag: `was ${m.wasRating} A`, tip: `Upgrade: ${m.wasRating} A would blow at this circuit's current. Fit the rating shown.` };
  return { tag: 'UPGRADE', tip: `Upgrade: raise ${positions.join(', ') || 'the rating'} to the rating shown.` };
}
