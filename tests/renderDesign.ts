// One line of text per component, wire and finding of a design, for golden-file tests: a change in
// the generator's output shows up as the changed lines, readable in a diff.

import { createHash } from 'node:crypto';
import type { Design, DNode, Wire } from '../src/model/types';

const kv = (o: Record<string, unknown>) =>
  Object.entries(o)
    .filter(([, v]) => v !== undefined)
    .map(([k, v]) => `${k}=${typeof v === 'number' ? Math.round(v * 100) / 100 : v}`)
    .join(' ');

function node(n: DNode): string {
  const terms = n.terminals.map((t) => `${t.id}${t.rating ? `(${t.rating}A)` : ''}`).join(',');
  const { part, ...data } = n.data;
  return [`${n.id} <${n.type}> "${n.label}"`, n.sublabel ? `[${n.sublabel}]` : '', `@${n.zone || '-'}`, n.equipmentId ? `eq:${n.equipmentId}` : '', kv(data), part ? `part "${part}"` : '', n.notes?.length ? `notes ${n.notes.join(',')}` : '', `terms ${terms}`]
    .filter(Boolean)
    .join(' · ');
}

function wire(w: Wire): string {
  return [
    `${w.id} ${w.kind} ${w.from.node}.${w.from.term} → ${w.to.node}.${w.to.term}`,
    `${w.cable ?? w.gauge ?? '?'}`,
    `${w.lengthFt} ft`,
    w.amps !== undefined ? `${w.amps} A` : '',
    w.vdropPct !== undefined ? `drop ${w.vdropPct}% of ${w.vdropLimit}%` : '',
    w.protectedBy ? `by ${w.protectedBy}` : '',
    w.inEngineSpace ? 'engine space' : '',
    w.equipmentGround ? 'equipment ground' : '',
    w.notes?.length ? `notes ${w.notes.join(',')}` : '',
  ]
    .filter(Boolean)
    .join(' · ');
}

export function renderDesign(d: Design): string {
  return [
    `${d.name} (${d.id}), ${d.systemVoltage} V: ${d.nodes.length} components, ${d.wires.length} wires, ${d.findings.length} findings`,
    '',
    ...d.nodes.map(node),
    '',
    ...d.wires.map(wire),
    '',
    ...d.findings.map((f) => `${f.id} ${f.severity} ${f.rule}: ${f.message}${f.fix ? ` → ${f.fix}` : ''}${f.nodes?.length ? ` [${f.nodes.join(',')}]` : ''}`),
  ].join('\n');
}

/** Short fingerprint of every field of a design. Any change at all changes it. */
export const fingerprint = (d: Design) => createHash('sha256').update(JSON.stringify(d)).digest('hex').slice(0, 16);
