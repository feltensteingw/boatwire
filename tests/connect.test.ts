import { describe, expect, it } from 'vitest';
import { audit } from '../src/engine/audit';
import { joinTerminals } from '../src/engine/connect';
import { paletteNode } from '../src/engine/existing';
import { generateIdeal } from '../src/engine/generate';
import { exampleProject } from '../src/model/examples';
import type { Design, Polarity, Wire } from '../src/model/types';

const ALL: Polarity[] = ['pos', 'neg', 'ac', 'gnd', 'sig'];

describe('which terminals a wire may join', () => {
  it('like joins like', () => {
    for (const p of ALL) expect(joinTerminals(p, p)).toEqual({ ok: true, kind: p });
  });

  it('a control wire may land on a DC terminal (sense and trigger leads)', () => {
    expect(joinTerminals('sig', 'pos')).toEqual({ ok: true, kind: 'sig' });
    expect(joinTerminals('neg', 'sig')).toEqual({ ok: true, kind: 'sig' });
  });

  it('safety ground bonds to DC negative, whichever end it is drawn from', () => {
    expect(joinTerminals('gnd', 'neg')).toEqual({ ok: true, kind: 'gnd' });
    expect(joinTerminals('neg', 'gnd')).toEqual({ ok: true, kind: 'gnd' });
  });

  it('refuses everything else, with a reason, in both directions', () => {
    const bad: [Polarity, Polarity, RegExp][] = [
      ['pos', 'neg', /dead short/],
      ['ac', 'pos', /AC \(mains\) terminal to a DC/],
      ['ac', 'neg', /AC \(mains\) terminal to a DC/],
      ['ac', 'gnd', /live AC conductor to the safety ground/],
      ['gnd', 'pos', /never to positive/],
      ['sig', 'ac', /control wire cannot connect to an AC/],
      ['sig', 'gnd', /control wire cannot connect to the safety ground/],
    ];
    for (const [a, b, why] of bad) {
      for (const j of [joinTerminals(a, b), joinTerminals(b, a)]) {
        expect(j.ok, `${a}-${b}`).toBe(false);
        if (!j.ok) {
          expect(j.why).toMatch(why);
          expect(j.what.length).toBeGreaterThan(5);
        }
      }
    }
  });

  it('covers every pair one way or the other', () => {
    for (const a of ALL) for (const b of ALL) expect(typeof joinTerminals(a, b).ok).toBe('boolean');
  });

  it('keeps working for a terminal it does not know', () => {
    expect(joinTerminals(undefined, 'neg')).toEqual({ ok: true, kind: 'neg' });
    expect(joinTerminals(undefined, undefined)).toEqual({ ok: true, kind: 'pos' });
  });
});

describe('design check: wires that join the wrong terminals', () => {
  const wire = (id: string, a: [string, string], b: [string, string], kind: Wire['kind'] = 'pos'): Wire => ({ id, kind, domain: 'dc', from: { node: a[0], term: a[1] }, to: { node: b[0], term: b[1] }, lengthFt: 2, gauge: '10' });

  it('flags a positive-to-negative wire in a drawing that already contains one', () => {
    const bat = paletteNode('battery', 'battery');
    const load = paletteNode('load', 'saloon');
    const d: Design = { id: 'existing', name: 'Existing', systemVoltage: 12, nodes: [bat, load], findings: [], wires: [wire('w1', [bat.id, 'pos'], [load.id, 'neg'])] };
    const f = audit(d).filter((x) => x.rule === 'wire-mismatch');
    expect(f).toHaveLength(1);
    expect(f[0].severity).toBe('error');
    expect(f[0].message).toMatch(/this wire joins DC positive to DC negative \(a dead short\)\./);
    expect(f[0].wires).toEqual(['w1']);
  });

  it('flags AC joined to DC', () => {
    const inlet = paletteNode('shore-inlet', 'cockpit');
    const bat = paletteNode('battery', 'battery');
    const d: Design = { id: 'existing', name: 'Existing', systemVoltage: 12, nodes: [inlet, bat], findings: [], wires: [wire('w1', [inlet.id, 'l'], [bat.id, 'pos'], 'ac')] };
    expect(audit(d).some((x) => x.rule === 'wire-mismatch' && /AC \(mains\) to DC positive/.test(x.message))).toBe(true);
  });

  it('never fires on a generated design', () => {
    const p = exampleProject();
    for (const e of p.equipment) if (e.kind === 'engine') e.props.regulator = 'external'; // adds a sense lead onto the positive bus
    for (const s of p.scenarios) expect(audit(generateIdeal(p, s)).filter((x) => x.rule === 'wire-mismatch'), s.name).toHaveLength(0);
  });
});
