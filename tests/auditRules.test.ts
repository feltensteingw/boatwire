import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { audit } from '../src/engine/audit';
import { joinTerminals } from '../src/engine/connect';
import { growTerminal, makeNode, terminal } from '../src/model/nodeDefs';
import { BATTERY_FUSE_MAX_IN, BATTERY_FUSE_SHEATHED_MAX_IN, SHORE_MAIN_MAX_FT } from '../src/model/standards';
import type { Design, DNode, NodeType, Severity, Wire } from '../src/model/types';

// Every rule the design check can report, each with a small drawing that breaks it and one that
// does not. The last test reads audit.ts and fails if a rule is added there without a case here.

type End = [DNode, string];

/** Cable for the battery end of the test drawings: heavy enough that only the wire under test can be too small. */
const HEAVY = '1/0';

/** A hand-drawn boat, built up a component and a wire at a time. */
class Drawing {
  d: Design;
  private count = 0;
  constructor(volts: 12 | 24 = 12) {
    this.d = { id: 'existing', name: 'Existing', systemVoltage: volts, nodes: [], wires: [], findings: [] };
  }
  add(type: NodeType, label: string, data: Record<string, string | number | boolean> = {}): DNode {
    const n = makeNode(type, `${type}-${++this.count}`, label, { data });
    this.d.nodes.push(n);
    return n;
  }
  /** A new stud on a bus bar, or a new breaker position on a panel. */
  stud(n: DNode, rating?: number): End {
    return [n, growTerminal(n, { rating })];
  }
  /** A wire between two terminals. Its kind follows the terminals, as it does when drawn in the app. */
  wire(a: End, b: End, o: Partial<Wire> = {}): Wire {
    const pa = terminal(a[0], a[1])?.pol;
    const pb = terminal(b[0], b[1])?.pol;
    if (!pa || !pb) throw new Error(`no such terminal: ${a[0].label}.${a[1]} or ${b[0].label}.${b[1]}`);
    const joined = joinTerminals(pa, pb);
    const kind = joined.ok ? joined.kind : pa === 'neg' ? 'neg' : pa === 'ac' ? 'ac' : 'pos';
    const w: Wire = { id: `w${this.d.wires.length + 1}`, kind, domain: kind === 'ac' || kind === 'gnd' ? 'ac' : 'dc', from: { node: a[0].id, term: a[1] }, to: { node: b[0].id, term: b[1] }, lengthFt: 1, gauge: '10', ...o };
    this.d.wires.push(w);
    return w;
  }

  // ---- common starting points
  /** Battery → fuse close to the battery. Returns the fuse's output, the protected feed. */
  fusedBattery(label = 'House bank', data: Record<string, string | number | boolean> = { chemistry: 'agm' }, fuseData: Record<string, string | number | boolean> = { rating: 30, fuseClass: 'MRBF' }) {
    const bat = this.add('battery', label, data);
    const fuse = this.add('fuse', `${label} fuse`, fuseData);
    this.wire([bat, 'pos'], [fuse, 'in'], { lengthFt: 0.5, gauge: HEAVY });
    return { bat, fuse, feed: [fuse, 'out'] as End };
  }
  /** Fused battery → switch. Returns the switched, protected feed. */
  switchedBattery() {
    const b = this.fusedBattery();
    const sw = this.add('switch', 'Battery switch');
    this.wire(b.feed, [sw, 'in'], { gauge: HEAVY });
    return { ...b, sw, feed: [sw, 'out'] as End };
  }
  /** Shore inlet → ELCI main breaker, with galvanic isolator and the AC ground bonded to DC negative. */
  shorePower() {
    const inlet = this.add('shore-inlet', 'Shore power', { amps: 30 });
    const elci = this.add('elci', 'Shore main breaker', { rating: 30 });
    const gi = this.add('galvanic-isolator', 'Galvanic isolator');
    const gnd = this.add('ac-ground-bus', 'AC ground bus');
    const neg = this.add('bus-neg', 'Negative bus');
    this.wire([inlet, 'l'], [elci, 'in'], { lengthFt: 3 });
    this.wire([inlet, 'g'], [gi, 'a']);
    this.wire([gi, 'b'], this.stud(gnd));
    this.wire(this.stud(gnd), this.stud(neg));
    return { inlet, elci, gi, gnd, neg, feed: [elci, 'out'] as End };
  }
  /** An AC panel fed from `from`, with one 15 A breaker. Returns the breaker's output. */
  acPanel(from: End, label = 'AC panel') {
    const panel = this.add('ac-panel', label, { rating: 30 });
    this.wire(from, [panel, 'in']);
    return { panel, breaker: this.stud(panel, 15) };
  }
}

interface Case {
  rule: string;
  severity: Severity;
  /** What is wrong, in a few words. */
  when: string;
  /** Part of the message expected, to tell apart several findings under one rule. */
  says: RegExp;
  bad(d: Drawing): void;
  good(d: Drawing): void;
}

const ft = (inches: number) => inches / 12;

const CASES: Case[] = [
  // ------------------------------------------------------------------ batteries
  {
    rule: 'battery-fuse', severity: 'error', when: 'the battery cable has no fuse', says: /has no fuse at the battery/,
    bad: (d) => d.wire([d.add('battery', 'House bank'), 'pos'], [d.add('switch', 'Battery switch'), 'in']),
    good: (d) => d.fusedBattery(),
  },
  {
    rule: 'battery-fuse', severity: 'error', when: 'the fuse is further away than even a sheathed cable allows', says: /fuse is .* from the battery\.$/,
    bad: (d) => d.wire([d.add('battery', 'House bank'), 'pos'], [d.add('fuse', 'Main fuse'), 'in'], { lengthFt: ft(BATTERY_FUSE_SHEATHED_MAX_IN + 6) }),
    good: (d) => d.wire([d.add('battery', 'House bank'), 'pos'], [d.add('fuse', 'Main fuse'), 'in'], { lengthFt: ft(BATTERY_FUSE_MAX_IN) }),
  },
  {
    rule: 'battery-fuse', severity: 'warning', when: 'the fuse is beyond the limit for an unsheathed cable', says: /allowed only if the cable is sheathed/,
    bad: (d) => d.wire([d.add('battery', 'House bank'), 'pos'], [d.add('fuse', 'Main fuse'), 'in'], { lengthFt: ft(BATTERY_FUSE_MAX_IN + 6) }),
    good: (d) => d.wire([d.add('battery', 'House bank'), 'pos'], [d.add('fuse', 'Main fuse'), 'in'], { lengthFt: ft(BATTERY_FUSE_MAX_IN) }),
  },
  {
    rule: 'battery-fuse', severity: 'info', when: 'the length to the fuse was never entered', says: /cable length has not been entered/,
    bad: (d) => d.wire([d.add('battery', 'House bank'), 'pos'], [d.add('fuse', 'Main fuse'), 'in'], { lengthFt: 0.5, lengthEstimated: true }),
    good: (d) => d.wire([d.add('battery', 'House bank'), 'pos'], [d.add('fuse', 'Main fuse'), 'in'], { lengthFt: 0.5 }),
  },
  {
    rule: 'battery-switch', severity: 'warning', when: 'loads cannot be isolated from the battery', says: /without an isolation switch/,
    bad: (d) => d.wire(d.fusedBattery().feed, [d.add('load', 'Cabin lights', { amps: 5 }), 'pos']),
    good: (d) => d.wire(d.switchedBattery().feed, [d.add('load', 'Cabin lights', { amps: 5 }), 'pos']),
  },
  {
    rule: 'class-t', severity: 'error', when: 'a lithium battery has a fuse that cannot interrupt its short-circuit current', says: /can only interrupt about/,
    bad: (d) => d.fusedBattery('Lithium bank', { chemistry: 'lifepo4' }, { rating: 200, fuseClass: 'ANL' }),
    good: (d) => d.fusedBattery('Lithium bank', { chemistry: 'lifepo4' }, { rating: 200, fuseClass: 'Class T' }),
  },
  {
    rule: 'class-t', severity: 'warning', when: "a lithium battery's fuse type is not recorded", says: /fuse type is not set/,
    bad: (d) => d.fusedBattery('Lithium bank', { chemistry: 'lifepo4' }, { rating: 200 }),
    good: (d) => d.fusedBattery('Lead bank', { chemistry: 'agm' }, { rating: 200 }),
  },
  {
    rule: 'no-mixed-chemistry', severity: 'error', when: 'lithium and lead-acid batteries share a positive bus', says: /Lithium and lead-acid batteries are directly connected/,
    bad: (d) => {
      const bus = d.add('bus-pos', 'Positive bus');
      d.wire(d.fusedBattery('Lithium bank', { chemistry: 'lifepo4' }, { rating: 200, fuseClass: 'Class T' }).feed, d.stud(bus));
      d.wire(d.fusedBattery('Start battery', { chemistry: 'agm' }).feed, d.stud(bus));
    },
    good: (d) => {
      // joined only through a DC-DC charger, which does not connect the two positives
      const dcdc = d.add('dcdc', 'DC-DC charger', { rating: 30 });
      d.wire(d.fusedBattery('Start battery', { chemistry: 'agm' }).feed, [dcdc, 'in']);
      d.wire([dcdc, 'out'], d.fusedBattery('Lithium bank', { chemistry: 'lifepo4' }, { rating: 200, fuseClass: 'Class T' }).feed);
    },
  },
  {
    rule: 'shunt', severity: 'warning', when: 'something other than the battery is on the battery side of the shunt', says: /is connected on the battery side of the shunt/,
    bad: (d) => d.wire([d.add('load', 'Bilge alarm', { amps: 1 }), 'neg'], [d.add('shunt', 'Battery monitor'), 'bat']),
    good: (d) => {
      const shunt = d.add('shunt', 'Battery monitor');
      d.wire([d.add('battery', 'House bank'), 'neg'], [shunt, 'bat']);
      d.wire([d.add('load', 'Bilge alarm', { amps: 1 }), 'neg'], [shunt, 'sys']);
    },
  },
  {
    rule: 'shunt', severity: 'warning', when: 'a negative goes straight to the battery, around the shunt', says: /bypassing the battery monitor shunt/,
    bad: (d) => {
      const bat = d.add('battery', 'House bank');
      d.wire([bat, 'neg'], [d.add('shunt', 'Battery monitor'), 'bat']);
      d.wire([bat, 'neg'], [d.add('load', 'Stereo', { amps: 3 }), 'neg']);
    },
    good: (d) => {
      const shunt = d.add('shunt', 'Battery monitor');
      d.wire([d.add('battery', 'House bank'), 'neg'], [shunt, 'bat']);
      d.wire([shunt, 'sys'], [d.add('load', 'Stereo', { amps: 3 }), 'neg']);
    },
  },

  // ------------------------------------------------------------------ loads
  {
    rule: 'neg-return', severity: 'info', when: 'a load is on the drawing but not wired', says: /is not connected/,
    bad: (d) => void d.add('load', 'Cabin lights', { amps: 5 }),
    good: (d) => {
      const load = d.add('load', 'Cabin lights', { amps: 5 });
      d.wire(d.switchedBattery().feed, [load, 'pos']);
      d.wire([load, 'neg'], d.stud(d.add('bus-neg', 'Negative bus')));
    },
  },
  {
    rule: 'neg-return', severity: 'warning', when: 'a load has a positive feed and no negative', says: /has no negative return conductor/,
    bad: (d) => d.wire(d.switchedBattery().feed, [d.add('load', 'Cabin lights', { amps: 5 }), 'pos']),
    good: (d) => {
      const load = d.add('load', 'Cabin lights', { amps: 5 });
      d.wire(d.switchedBattery().feed, [load, 'pos']);
      d.wire([load, 'neg'], d.stud(d.add('bus-neg', 'Negative bus')));
    },
  },
  {
    rule: 'branch-protection', severity: 'error', when: 'a load reaches the battery with no fuse or breaker on the way', says: /has no fuse or breaker between it and the battery/,
    bad: (d) => {
      const sw = d.add('switch', 'Battery switch');
      d.wire([d.add('battery', 'House bank'), 'pos'], [sw, 'in']);
      d.wire([sw, 'out'], [d.add('load', 'Cabin lights', { amps: 5 }), 'pos']);
    },
    good: (d) => d.wire(d.switchedBattery().feed, [d.add('load', 'Cabin lights', { amps: 5 }), 'pos']),
  },
  {
    rule: 'branch-protection', severity: 'error', when: 'a fuse is rated above what its wire can carry', says: /protected by 100 A but .* is only rated/,
    bad: (d) => d.wire([d.add('fuse', 'Feeder fuse', { rating: 100 }), 'out'], [d.add('load', 'Cabin lights', { amps: 5 }), 'pos'], { gauge: '16' }),
    good: (d) => d.wire([d.add('fuse', 'Feeder fuse', { rating: 10 }), 'out'], [d.add('load', 'Cabin lights', { amps: 5 }), 'pos'], { gauge: '16' }),
  },
  {
    rule: 'branch-protection', severity: 'error', when: 'a wire after a switch is smaller than the fuse in front of the switch', says: /protected by 50 A but .* is only rated 35 A/,
    bad: (d) => {
      const { feed } = d.fusedBattery('House bank', { chemistry: 'agm' }, { rating: 50, fuseClass: 'MRBF' });
      const sw = d.add('switch', 'Battery switch');
      d.wire(feed, [sw, 'in'], { gauge: HEAVY });
      d.wire([sw, 'out'], [d.add('load', 'Cabin lights', { amps: 5 }), 'pos'], { gauge: '14' });
    },
    good: (d) => {
      const { feed } = d.fusedBattery('House bank', { chemistry: 'agm' }, { rating: 30, fuseClass: 'MRBF' });
      const sw = d.add('switch', 'Battery switch');
      d.wire(feed, [sw, 'in'], { gauge: HEAVY });
      d.wire([sw, 'out'], [d.add('load', 'Cabin lights', { amps: 5 }), 'pos'], { gauge: '14' });
    },
  },
  {
    rule: 'branch-protection', severity: 'error', when: 'an AC appliance has no breaker', says: /has no AC breaker/,
    bad: (d) => d.wire([d.add('inverter', 'Inverter', { watts: 1500 }), 'acout'], [d.add('ac-load', 'Water heater', { watts: 1200 }), 'l'], { gauge: '12' }),
    good: (d) => {
      const { breaker } = d.acPanel(d.shorePower().feed);
      d.wire(breaker, [d.add('ac-load', 'Water heater', { watts: 1200 }), 'l'], { gauge: '12' });
    },
  },
  {
    rule: 'unswitched', severity: 'warning', when: 'a bilge pump is fed through the battery switch', says: /goes through the battery switch/,
    bad: (d) => d.wire(d.switchedBattery().feed, [d.add('load', 'Bilge pump', { amps: 5, kind: 'bilge-pump' }), 'pos']),
    good: (d) => d.wire(d.fusedBattery().feed, [d.add('load', 'Bilge pump', { amps: 5, kind: 'bilge-pump' }), 'pos']),
  },
  {
    rule: 'v12-on-24', severity: 'error', when: 'a 12 V-only appliance is on a 24 V system', says: /is 12 V-only but is fed from the 24 V system/,
    bad: (d) => d.wire(d.switchedBattery().feed, [d.add('load', 'VHF radio', { amps: 5, v24ok: false }), 'pos']),
    good: (d) => {
      const conv = d.add('converter', '24→12 V converter', { rating: 20 });
      d.wire(d.switchedBattery().feed, [conv, 'in']);
      d.wire([conv, 'out'], [d.add('load', 'VHF radio', { amps: 5, v24ok: false }), 'pos']);
    },
  },

  // ------------------------------------------------------------------ wires
  {
    rule: 'unsized-wire', severity: 'warning', when: 'a power wire has no size', says: /1 wire has no size set/,
    bad: (d) => d.wire(d.switchedBattery().feed, [d.add('load', 'Cabin lights', { amps: 5 }), 'pos'], { gauge: undefined }),
    good: (d) => d.wire(d.switchedBattery().feed, [d.add('load', 'Cabin lights', { amps: 5 }), 'pos']),
  },
  {
    rule: 'conductor-sizing', severity: 'error', when: 'a wire carries more than its ampacity', says: /above its \d+ A ampacity/,
    bad: (d) => d.wire(d.switchedBattery().feed, [d.add('load', 'Windlass', { amps: 100 }), 'pos'], { gauge: '16' }),
    good: (d) => d.wire(d.switchedBattery().feed, [d.add('load', 'Windlass', { amps: 100 }), 'pos'], { gauge: '2' }),
  },
  {
    rule: 'conductor-sizing', severity: 'error', when: 'a wire in a bundle carries more than its bundled ampacity', says: /\(bundled with \d+ other wires?\) carries ~\d+ A, above its \d+ A ampacity/,
    bad: (d) => d.wire(d.switchedBattery().feed, [d.add('load', 'Water heater', { amps: 28 }), 'pos'], { gauge: '12', bundledWith: 3 }),
    good: (d) => d.wire(d.switchedBattery().feed, [d.add('load', 'Water heater', { amps: 28 }), 'pos'], { gauge: '12', bundledWith: 1 }),
  },
  {
    rule: 'conductor-sizing', severity: 'warning', when: 'a long thin run loses too much voltage', says: /% voltage drop \(limit/,
    bad: (d) => d.wire(d.switchedBattery().feed, [d.add('load', 'Cabin lights', { amps: 10 }), 'pos'], { gauge: '14', lengthFt: 40 }),
    good: (d) => d.wire(d.switchedBattery().feed, [d.add('load', 'Cabin lights', { amps: 10 }), 'pos'], { gauge: '14', lengthFt: 5 }),
  },
  {
    rule: 'wire-mismatch', severity: 'error', when: 'a wire joins positive to negative', says: /this wire joins/,
    bad: (d) => d.wire([d.add('battery', 'House bank'), 'pos'], [d.add('load', 'Cabin lights', { amps: 5 }), 'neg']),
    good: (d) => d.wire([d.add('battery', 'House bank'), 'neg'], [d.add('load', 'Cabin lights', { amps: 5 }), 'neg']),
  },

  // ------------------------------------------------------------------ charging
  {
    rule: 'charging-source-fuse', severity: 'error', when: 'a charging source reaches a battery with no fuse', says: /connects to a battery without a fuse/,
    bad: (d) => d.wire([d.add('alternator', 'Alternator', { amps: 60 }), 'b'], [d.add('battery', 'House bank'), 'pos']),
    good: (d) => d.wire([d.add('alternator', 'Alternator', { amps: 60 }), 'b'], d.fusedBattery('House bank', { chemistry: 'agm' }, { rating: 80, fuseClass: 'MRBF' }).feed, { gauge: '4' }),
  },
  {
    rule: 'alternator-lfp', severity: 'error', when: 'the alternator charges lithium with no external regulator or protection device', says: /charges a lithium bank directly/,
    bad: (d) => d.wire([d.add('alternator', 'Alternator', { amps: 60 }), 'b'], d.fusedBattery('Lithium bank', { chemistry: 'lifepo4' }, { rating: 80, fuseClass: 'Class T' }).feed, { gauge: '4' }),
    good: (d) => {
      const alt = d.add('alternator', 'Alternator', { amps: 60 });
      d.wire([alt, 'b'], d.fusedBattery('Lithium bank', { chemistry: 'lifepo4' }, { rating: 80, fuseClass: 'Class T' }).feed, { gauge: '4' });
      d.wire([alt, 'b'], [d.add('apd', 'Alternator protection device'), 'b']);
      d.wire([d.add('regulator', 'External regulator'), 'field'], [alt, 'field']);
    },
  },
  {
    rule: 'isolator', severity: 'warning', when: 'a battery isolator feeds a lithium bank', says: /feeds a lithium bank/,
    bad: (d) => d.wire([d.add('isolator', 'Battery isolator', { isolatorType: 'fet' }), 'out1'], d.fusedBattery('Lithium bank', { chemistry: 'lifepo4' }, { rating: 80, fuseClass: 'Class T' }).feed),
    good: (d) => d.wire([d.add('isolator', 'Battery isolator', { isolatorType: 'fet' }), 'out1'], d.fusedBattery('House bank', { chemistry: 'agm' }).feed),
  },
  {
    rule: 'isolator', severity: 'warning', when: 'a diode isolator has nothing to make up for its voltage drop', says: /is a diode isolator/,
    bad: (d) => void d.add('isolator', 'Battery isolator', { isolatorType: 'diode' }),
    good: (d) => void d.add('isolator', 'Battery isolator', { isolatorType: 'diode', compensation: 'excite' }),
  },
  {
    // Two engines: only a regulator on the alternator that feeds the isolator makes up for its drop.
    rule: 'isolator', severity: 'warning', when: "the other engine's external regulator does not compensate a diode isolator", says: /is a diode isolator/,
    bad: (d) => {
      const [alt1, alt2] = [d.add('alternator', 'Alternator 1', { amps: 60 }), d.add('alternator', 'Alternator 2', { amps: 60 })];
      d.wire([d.add('regulator', 'External regulator'), 'field'], [alt1, 'field']);
      d.wire([alt2, 'b'], [d.add('isolator', 'Battery isolator', { isolatorType: 'diode' }), 'in'], { gauge: '4' });
    },
    good: (d) => {
      const [, alt2] = [d.add('alternator', 'Alternator 1', { amps: 60 }), d.add('alternator', 'Alternator 2', { amps: 60 })];
      d.wire([d.add('regulator', 'External regulator'), 'field'], [alt2, 'field']);
      d.wire([alt2, 'b'], [d.add('isolator', 'Battery isolator', { isolatorType: 'diode' }), 'in'], { gauge: '4' });
    },
  },

  // ------------------------------------------------------------------ AC
  {
    rule: 'shore-main', severity: 'error', when: 'there is no main breaker close to the shore inlet', says: /No main breaker within/,
    bad: (d) => d.wire([d.add('shore-inlet', 'Shore power'), 'l'], [d.add('elci', 'Shore main breaker', { rating: 30 }), 'in'], { lengthFt: SHORE_MAIN_MAX_FT + 5 }),
    good: (d) => void d.shorePower(),
  },
  {
    rule: 'shore-main', severity: 'warning', when: 'the shore main breaker has no ELCI', says: /has no ELCI/,
    // a plain breaker stands in for a main breaker without earth-leakage protection
    bad: (d) => d.wire([d.add('shore-inlet', 'Shore power'), 'l'], [d.add('breaker', 'Plain main breaker', { rating: 30 }), 'in'], { lengthFt: 3, kind: 'ac', domain: 'ac' }),
    good: (d) => void d.shorePower(),
  },
  {
    rule: 'galvanic-isolator', severity: 'warning', when: 'the shore ground has no galvanic isolator', says: /has no galvanic isolator/,
    bad: (d) => {
      const inlet = d.add('shore-inlet', 'Shore power');
      d.wire([inlet, 'l'], [d.add('elci', 'Shore main breaker', { rating: 30 }), 'in'], { lengthFt: 3 });
      d.wire([inlet, 'g'], d.stud(d.add('ac-ground-bus', 'AC ground bus')));
    },
    good: (d) => void d.shorePower(),
  },
  {
    rule: 'ac-dc-bond', severity: 'error', when: 'the AC ground is not bonded to the DC negative', says: /not connected to the DC negative/,
    bad: (d) => {
      const inlet = d.add('shore-inlet', 'Shore power');
      const gi = d.add('galvanic-isolator', 'Galvanic isolator');
      d.wire([inlet, 'l'], [d.add('elci', 'Shore main breaker', { rating: 30 }), 'in'], { lengthFt: 3 });
      d.wire([inlet, 'g'], [gi, 'a']);
      d.wire([gi, 'b'], d.stud(d.add('ac-ground-bus', 'AC ground bus')));
    },
    good: (d) => void d.shorePower(),
  },
  {
    rule: 'source-selector', severity: 'error', when: 'shore power and a generator can feed a panel at the same time', says: /can be fed by more than one AC source at once/,
    bad: (d) => {
      const { panel } = d.acPanel(d.shorePower().feed);
      const brk = d.add('elci', 'Generator breaker', { rating: 30 });
      d.wire([d.add('generator', 'Generator', { amps: 25 }), 'l'], [brk, 'in']);
      d.wire([brk, 'out'], [panel, 'in']);
    },
    good: (d) => {
      const sel = d.add('selector', 'Source selector');
      const brk = d.add('elci', 'Generator breaker', { rating: 30 });
      d.wire(d.shorePower().feed, [sel, 'in1']);
      d.wire([d.add('generator', 'Generator', { amps: 25 }), 'l'], [brk, 'in']);
      d.wire([brk, 'out'], [sel, 'in2']);
      d.acPanel([sel, 'out']);
    },
  },
  {
    rule: 'charger-not-on-inverter', severity: 'error', when: 'the battery charger can run from the inverter', says: /can be powered by the inverter/,
    bad: (d) => d.wire(d.acPanel([d.add('inverter', 'Inverter', { watts: 1500 }), 'acout']).breaker, [d.add('charger', 'Battery charger', { amps: 30 }), 'acin']),
    good: (d) => d.wire(d.acPanel(d.shorePower().feed).breaker, [d.add('charger', 'Battery charger', { amps: 30 }), 'acin']),
  },
  {
    rule: 'shore-only', severity: 'warning', when: 'a shore-only appliance can run from the inverter', says: /can run from the inverter/,
    bad: (d) => d.wire(d.acPanel([d.add('inverter', 'Inverter', { watts: 1500 }), 'acout']).breaker, [d.add('ac-load', 'Air conditioner', { watts: 1000, shoreOnly: true }), 'l']),
    good: (d) => d.wire(d.acPanel(d.shorePower().feed).breaker, [d.add('ac-load', 'Air conditioner', { watts: 1000, shoreOnly: true }), 'l']),
  },
];

const found = (build: (d: Drawing) => void, c: Case, volts: 12 | 24) => {
  const d = new Drawing(volts);
  build(d);
  return audit(d.d).filter((f) => f.rule === c.rule && f.severity === c.severity && c.says.test(f.message));
};

describe('design check rules', () => {
  for (const c of CASES) {
    const volts = c.rule === 'v12-on-24' ? 24 : 12;
    describe(`${c.rule} (${c.severity}): ${c.when}`, () => {
      it('is reported on a drawing that has the problem', () => {
        const f = found(c.bad, c, volts);
        expect(f).toHaveLength(1);
        expect(f[0].fix, 'says what to do about it').toBeTruthy();
      });
      it('is not reported on a drawing that does it properly', () => {
        expect(found(c.good, c, volts).map((f) => f.message)).toEqual([]);
      });
    });
  }

  it('every rule in audit.ts has a case here', () => {
    const source = readFileSync(new URL('../src/engine/audit.ts', import.meta.url), 'utf8');
    const inSource = new Set([...source.matchAll(/\badd\(\s*'(error|warning|info)',\s*'([a-z0-9-]+)'/g)].map((m) => `${m[2]} (${m[1]})`));
    const covered = new Set(CASES.map((c) => `${c.rule} (${c.severity})`));
    expect(inSource.size).toBeGreaterThan(20);
    expect([...inSource].filter((r) => !covered.has(r)).sort()).toEqual([]);
    // and no case here is for a rule that no longer exists
    expect([...covered].filter((r) => !inSource.has(r)).sort()).toEqual([]);
  });
});

describe('a wire after a switch is held to the fuse in front of the switch', () => {
  /** House bank → fuse → switch(es) → wire under test → load. */
  const drawing = (o: { fuse: number; gauge: string; switches?: number; notes?: string[] }) => {
    const d = new Drawing();
    let feed = d.fusedBattery('House bank', { chemistry: 'agm' }, { rating: o.fuse, fuseClass: 'MRBF' }).feed;
    for (let i = 0; i < (o.switches ?? 1); i++) {
      const sw = d.add(i === 0 ? 'switch' : 'contactor', i === 0 ? 'Battery switch' : 'Contactor');
      d.wire(feed, [sw, 'in'], { gauge: HEAVY });
      feed = [sw, 'out'];
    }
    const w = d.wire(feed, [d.add('load', 'Cabin lights', { amps: 5 }), 'pos'], { gauge: o.gauge, notes: o.notes });
    return { d: d.d, w };
  };
  const protection = (x: { d: Design; w: Wire }) => audit(x.d).filter((f) => f.rule === 'branch-protection' && f.wires?.includes(x.w.id));

  it('names the fuse in front of the switch and the wire it is too big for', () => {
    const x = drawing({ fuse: 50, gauge: '14' });
    const f = protection(x);
    expect(f).toHaveLength(1);
    expect(f[0].message).toMatch(/Battery switch → Cabin lights: protected by 50 A but 14 AWG.* is only rated 35 A\./);
    expect(f[0].nodes).toEqual([x.d.nodes.find((n) => n.type === 'fuse')!.id]);
  });
  it('follows the feed back through more than one switch or contactor', () => {
    expect(protection(drawing({ fuse: 50, gauge: '14', switches: 2 }))).toHaveLength(1);
  });
  it('passes when the wire can carry the fuse rating', () => {
    expect(protection(drawing({ fuse: 30, gauge: '14' }))).toEqual([]);
    expect(protection(drawing({ fuse: 50, gauge: '10' }))).toEqual([]);
  });
  it('leaves a starter cable exempt', () => {
    expect(protection(drawing({ fuse: 50, gauge: '14', notes: ['starter-exempt'] }))).toEqual([]);
  });
});
