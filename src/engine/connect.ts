// Which terminals may be joined by a wire, and what kind of wire that makes.

import type { Polarity, WireKind } from '../model/types';

/** `why` is said to the user when a drawn wire is refused; `what` names the pair in the design check. */
export type Joined = { ok: true; kind: WireKind } | { ok: false; what: string; why: string };

const NAME: Record<Polarity, string> = { pos: 'DC positive', neg: 'DC negative', ac: 'AC', gnd: 'safety ground', sig: 'control' };

/**
 * Decide what a wire between two terminals is, or refuse it with a reason a boat owner can read.
 * The answer does not depend on which end the wire was drawn from.
 *
 * Allowed: like to like; a control wire to a DC terminal (sense and trigger leads); and safety
 * ground to DC negative (the AC-ground-to-DC-negative bond). Everything else would short or
 * cross-connect two systems.
 */
export function joinTerminals(a: Polarity | undefined, b: Polarity | undefined): Joined {
  // A terminal BoatWire does not know (older files): keep the old behaviour and take the known end.
  if (!a || !b) return { ok: true, kind: a ?? b ?? 'pos' };
  if (a === b) return { ok: true, kind: a };
  const has = (x: Polarity, y: Polarity) => (a === x && b === y) || (a === y && b === x);
  if (has('sig', 'pos') || has('sig', 'neg')) return { ok: true, kind: 'sig' };
  if (has('gnd', 'neg')) return { ok: true, kind: 'gnd' };
  const no = (what: string, why: string): Joined => ({ ok: false, what, why });
  if (has('pos', 'neg')) return no('DC positive to DC negative (a dead short)', 'That would join DC positive to DC negative, which is a dead short. Positive wires run between red dots and negative wires between black dots.');
  if (has('ac', 'pos') || has('ac', 'neg')) return no(`AC (mains) to ${NAME[a === 'ac' ? b : a]}`, 'That would join an AC (mains) terminal to a DC (battery) terminal. The two systems must never be connected.');
  if (has('ac', 'gnd')) return no('a live AC conductor to the safety ground', 'That would join a live AC conductor to the safety ground. Ground wires run between green dots.');
  if (has('gnd', 'pos')) return no('the safety ground to DC positive', 'That would join the safety ground to DC positive. The AC ground bonds to DC negative, never to positive.');
  const other = a === 'sig' ? b : a;
  return no(`a control terminal to ${NAME[other] === 'AC' ? 'AC (mains)' : `the ${NAME[other]}`}`, `A control wire cannot connect to ${other === 'ac' ? 'an AC (mains) terminal' : 'the safety ground'}. Control wires run between blue dots, or from a blue dot to a DC terminal.`);
}
