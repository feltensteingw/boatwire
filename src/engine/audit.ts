// Audit: check any design (hand-drawn or generated) against the rules.

import { NODE_DEFS } from '../model/nodeDefs';
import { BATTERY_FUSE_MAX_IN, BATTERY_FUSE_SHEATHED_MAX_IN, FUSE_CLASSES, LITHIUM_FUSE_MIN_AIC, SHORE_MAIN_MAX_FT, VDROP, type FuseClass } from '../model/standards';
import type { Design, DNode, Finding, Severity, Wire } from '../model/types';
import { ampacity, inverterDcAmps, isUnsized, vdropPct } from './calc';
import { AC_SOURCE_TERMS, buildGraph, key, passThrough, positiveNets, SOURCE_TERMS, walk, type Graph, type Reach } from './graph';
import { cableText, fmtLen, fmtShort, type Units } from '../model/units';
import { joinTerminals } from './connect';

const LEAD = new Set(['flooded', 'agm', 'gel']);

// Wording for a length BoatWire guessed from locations, as opposed to one the user entered.
const guess = (w: Wire) => (w.lengthEstimated ? 'about ' : '');
const guessed = (w: Wire) => (w.lengthEstimated ? ' (estimated from their locations; enter the measured length)' : '');

export function audit(design: Design, opts: { acVolts?: number; units?: Units } = {}): Finding[] {
  const units = opts.units ?? 'imperial';
  const g = buildGraph(design);
  const V = design.systemVoltage;
  const acV = opts.acVolts ?? 120;
  const out: Finding[] = [];
  const add = (severity: Severity, rule: string, message: string, fix?: string, nodes?: string[], wires?: string[]) =>
    out.push({ id: `a${out.length + 1}`, rule, severity, message, fix, nodes, wires });

  const batteries = design.nodes.filter((n) => n.type === 'battery');
  const label = (n: DNode) => n.label;
  const amps = estimateCurrents(design);

  // 1. Battery fuse within 7 in
  for (const bat of batteries) {
    for (const w of g.at.get(key(bat.id, 'pos')) ?? []) {
      if (w.kind !== 'pos') continue;
      const o = w.from.node === bat.id ? w.to : w.from;
      const n = g.node.get(o.node)!;
      const inches = w.lengthFt * 12;
      if (!NODE_DEFS[n.type].protective) {
        add('error', 'battery-fuse', `${label(bat)}: positive cable to ${label(n)} has no fuse at the battery.`, `Add a fuse (MRBF terminal fuse, or Class T for lithium) within ${fmtShort(BATTERY_FUSE_MAX_IN, units)} of the battery positive.`, [bat.id, n.id], [w.id]);
      } else if (inches > BATTERY_FUSE_SHEATHED_MAX_IN) {
        add('error', 'battery-fuse', `${label(bat)}: fuse is ${guess(w)}${fmtShort(inches, units)} from the battery${guessed(w)}.`, `Move it within ${fmtShort(BATTERY_FUSE_MAX_IN, units)} of the terminal.`, [bat.id, n.id], [w.id]);
      } else if (inches > BATTERY_FUSE_MAX_IN) {
        add('warning', 'battery-fuse', `${label(bat)}: fuse is ${guess(w)}${fmtShort(inches, units)} from the battery${guessed(w)} — allowed only if the cable is sheathed.`, `Move it within ${fmtShort(BATTERY_FUSE_MAX_IN, units)}, or sheath the cable.`, [bat.id, n.id], [w.id]);
      } else if (w.lengthEstimated) {
        // A freshly drawn wire: nobody has measured it yet, so ask rather than pass or fail it.
        add('info', 'battery-fuse', `${label(bat)}: how far is ${label(n)} from the battery? The cable length has not been entered.`, `Measure the cable from the battery positive to the fuse and enter it as the wire's length. It must be within ${fmtShort(BATTERY_FUSE_MAX_IN, units)} (${fmtShort(BATTERY_FUSE_SHEATHED_MAX_IN, units)} if sheathed).`, [bat.id, n.id], [w.id]);
      }
    }
  }

  // 2. Loads must be protected; bilge pumps unswitched; 12 V loads not on 24 V
  for (const n of design.nodes) {
    if (n.type !== 'load') continue;
    const posWires = g.at.get(key(n.id, 'pos')) ?? [];
    const negWires = g.at.get(key(n.id, 'neg')) ?? [];
    if (posWires.length === 0) {
      add('info', 'neg-return', `${label(n)} is not connected.`, 'Connect it to a protected circuit.', [n.id]);
      continue;
    }
    if (negWires.length === 0) {
      add('warning', 'neg-return', `${label(n)} has no negative return conductor.`, 'Run a negative of the same gauge back to the negative bus.', [n.id]);
    }
    const reach = walk(g, { node: n.id, term: 'pos' }, ['pos']);
    const toBat = reach.filter((r) => r.node.type === 'battery');
    if (toBat.some((r) => !r.protectedPath)) {
      add('error', 'branch-protection', `${label(n)} has no fuse or breaker between it and the battery.`, 'Feed it from a panel breaker or a fuse sized for the wire.', [n.id]);
    }
    if (n.data.kind === 'bilge-pump' && toBat.length && toBat.every((r) => r.switched)) {
      add('warning', 'unswitched', `${label(n)} goes through the battery switch — it will not run with the boat shut down.`, 'Feed bilge pumps from a fused always-on circuit on the battery side of the main switch.', [n.id]);
    }
    if (V === 24 && n.data.v24ok === false && toBat.length) {
      add('error', 'v12-on-24', `${label(n)} is 12 V-only but is fed from the 24 V system.`, 'Feed it through a 24→12 V converter.', [n.id]);
    }
  }

  // 3. Charging sources fused at the battery end
  for (const n of design.nodes) {
    for (const t of SOURCE_TERMS[n.type] ?? []) {
      if (!n.terminals.some((x) => x.id === t)) continue;
      const reach = walk(g, { node: n.id, term: t }, ['pos']).filter((r) => r.node.type === 'battery');
      if (reach.some((r) => !r.protectedPath)) {
        add('error', 'charging-source-fuse', `${label(n)} connects to a battery without a fuse.`, 'Add a fuse at the battery / bus end of the conductor.', [n.id]);
      }
    }
  }

  // 4. Battery isolation switch
  for (const bat of batteries) {
    const reach = walk(g, { node: bat.id, term: 'pos' }, ['pos'], { stopAtSwitch: true });
    const exposed = reach.filter((r) => (r.node.type === 'load' && !r.node.data.kind?.toString().includes('bilge') && r.node.data.alwaysOn !== true) || r.node.type === 'dc-panel');
    const viaBlock = exposed.filter((r) => !r.via.some((v) => g.node.get(v)?.type === 'fuse-block'));
    if (viaBlock.length) {
      add('warning', 'battery-switch', `${label(bat)} feeds ${viaBlock.map((r) => label(r.node)).slice(0, 3).join(', ')} without an isolation switch.`, 'Install a battery switch after the main fuse.', [bat.id]);
    }
  }

  // 4b. A fuse on a lithium battery must be able to interrupt the battery's short-circuit current
  for (const bat of batteries) {
    if (bat.data.chemistry !== 'lifepo4') continue;
    for (const w of g.at.get(key(bat.id, 'pos')) ?? []) {
      if (w.kind !== 'pos') continue;
      const n = g.node.get(w.from.node === bat.id ? w.to.node : w.from.node);
      if (n?.type !== 'fuse') continue;
      const name = n.data.fuseClass;
      const cls = name ? FUSE_CLASSES[name as FuseClass] : undefined;
      if (!cls) {
        add('warning', 'class-t', `${label(n)} on ${label(bat)}: the fuse type is not set, so its interrupt rating cannot be checked.`, 'Select the fuse and choose its type. A lithium battery needs a Class T fuse.', [n.id, bat.id]);
      } else if (cls.aic < LITHIUM_FUSE_MIN_AIC) {
        add(
          'error',
          'class-t',
          `${label(n)} on ${label(bat)} is ${/^A/.test(name!) ? 'an' : 'a'} ${name} fuse, which can only interrupt about ${cls.aic.toLocaleString('en-US')} A. A lithium battery can deliver more than that into a short circuit, so the fuse may arc instead of clearing.`,
          `Replace it with a Class T fuse (about ${FUSE_CLASSES['Class T'].aic.toLocaleString('en-US')} A interrupt rating).`,
          [n.id, bat.id],
        );
      }
    }
  }

  // 5. Mixed chemistry on one positive net
  const nets = positiveNets(g);
  const byNet = new Map<string, DNode[]>();
  for (const bat of batteries) {
    const r = nets.get(key(bat.id, 'pos'));
    if (!r) continue;
    if (!byNet.has(r)) byNet.set(r, []);
    byNet.get(r)!.push(bat);
  }
  for (const group of byNet.values()) {
    const hasL = group.some((b) => b.data.chemistry === 'lifepo4');
    const hasLead = group.some((b) => LEAD.has(String(b.data.chemistry)));
    if (hasL && hasLead) {
      add('error', 'no-mixed-chemistry', `Lithium and lead-acid batteries are directly connected (${group.map(label).join(', ')}).`, 'Separate them with a DC-DC charger instead of a switch, ACR or direct cable.', group.map((b) => b.id));
    }
  }

  // 6. Alternator on a lithium net needs protection
  for (const alt of design.nodes.filter((n) => n.type === 'alternator')) {
    const lfp = walk(g, { node: alt.id, term: 'b' }, ['pos']).some((r) => r.node.type === 'battery' && r.node.data.chemistry === 'lifepo4');
    if (!lfp) continue;
    const hasApd = (g.at.get(key(alt.id, 'b')) ?? []).some((w) => g.node.get(w.from.node === alt.id ? w.to.node : w.from.node)?.type === 'apd');
    const hasReg = (g.at.get(key(alt.id, 'field')) ?? []).some((w) => g.node.get(w.from.node === alt.id ? w.to.node : w.from.node)?.type === 'regulator');
    if (!hasApd || !hasReg) {
      add('error', 'alternator-lfp', 'The alternator charges a lithium bank directly without an external regulator and alternator protection device.', 'Charge lithium through a DC-DC charger from a lead-acid start battery, or fit an external regulator plus APD.', [alt.id]);
    }
  }

  // 6b. Battery isolators
  for (const iso of design.nodes.filter((n) => n.type === 'isolator')) {
    const chems = new Set<string>();
    for (const t of iso.terminals.filter((x) => x.id.startsWith('out'))) {
      for (const r of walk(g, { node: iso.id, term: t.id }, ['pos'])) {
        if (r.node.type === 'battery') chems.add(r.node.data.chemistry === 'lifepo4' ? 'lifepo4' : 'lead');
      }
    }
    if (chems.has('lifepo4')) {
      add('warning', 'isolator', `${label(iso)} feeds a lithium bank. It gives every bank the alternator's voltage, so lithium can't get its own charge profile, and a BMS disconnect can still spike the alternator.`, 'Charge lithium through a DC-DC charger instead.', [iso.id]);
    }
    if (iso.data.isolatorType === 'diode') {
      const hasReg = design.nodes.some((n) => n.type === 'regulator');
      if (!hasReg && !diodeCompensated(g, iso)) add('warning', 'isolator', `${label(iso)} is a diode isolator: its ~0.7 V drop leaves the batteries undercharged with a stock regulator.`, 'Wire the isolator\'s "E" terminal to the alternator excitation terminal, move the alternator sense lead to the battery side of the isolator, or use a FET (zero-drop) isolator or an ACR.', [iso.id]);
    }
  }

  // 7. Shunt: only the battery negative on the battery side
  for (const sh of design.nodes.filter((n) => n.type === 'shunt')) {
    for (const w of g.at.get(key(sh.id, 'bat')) ?? []) {
      const o = w.from.node === sh.id ? w.to : w.from;
      const bat = g.node.get(o.node);
      if (bat?.type !== 'battery') {
        add('warning', 'shunt', `${label(bat ?? sh)} is connected on the battery side of the shunt.`, 'Move it to the system side of the shunt.', [sh.id]);
        continue;
      }
      const others = (g.at.get(key(bat.id, 'neg')) ?? []).filter((x) => x.id !== w.id);
      for (const x of others) {
        const on = g.node.get(x.from.node === bat.id ? x.to.node : x.from.node);
        if (on && on.type !== 'shunt') {
          add('warning', 'shunt', `${label(on)} connects straight to ${label(bat)} negative, bypassing the battery monitor shunt.`, 'Connect it to the negative bus on the system side of the shunt.', [bat.id, on.id], [x.id]);
        }
      }
    }
  }

  // 8a. A wire with no size cannot be checked at all. Say so, rather than let the drawing read as clean.
  const unsized = design.wires.filter(isUnsized);
  if (unsized.length) {
    const one = unsized.length === 1;
    add(
      'warning',
      'unsized-wire',
      `${unsized.length} wire${one ? ' has' : 's have'} no size set, so ${one ? 'it is' : 'they are'} not checked for ampacity, fuse match or voltage drop.`,
      `Click ${one ? 'the dotted wire' : 'each dotted wire'} and choose its conductor size.`,
      undefined,
      unsized.map((w) => w.id),
    );
  }

  // 8. Wire ampacity, protection and voltage drop
  for (const w of design.wires) {
    if (!w.gauge || w.kind === 'sig' || w.kind === 'gnd') continue;
    const a = w.amps ?? amps.get(w.id);
    const amp = ampacity(w.gauge, w.inEngineSpace, w.kind === 'ac') * (w.cable?.match(/^(\d+)×/) ? Number(w.cable.split('×')[0]) : 1);
    const ends = [w.from, w.to].map((e) => ({ e, n: g.node.get(e.node)! }));
    const names = `${ends[0].n?.label} → ${ends[1].n?.label}`;
    if (a !== undefined && a > amp) {
      add('error', 'conductor-sizing', `${names}: ${cableText(w, units)} carries ~${Math.round(a)} A, above its ${Math.round(amp)} A ampacity.`, 'Use a larger conductor.', undefined, [w.id]);
    }
    if (!w.notes?.includes('starter-exempt') && w.kind !== 'neg') {
      for (const { e, n } of ends) {
        if (!n || !NODE_DEFS[n.type].protective) continue;
        const t = n.terminals.find((x) => x.id === e.term);
        const isOut = e.term !== 'in' || n.type === 'fuse' || n.type === 'breaker';
        if (!isOut) continue;
        const rating = t?.rating ?? n.data.rating;
        if (typeof rating === 'number' && rating > amp * 1.0001) {
          add('error', 'branch-protection', `${names}: protected by ${rating} A but ${cableText(w, units)} is only rated ${Math.round(amp)} A.`, `Use a smaller fuse/breaker or a larger wire.`, [n.id], [w.id]);
          break;
        }
      }
    }
    if (a !== undefined && w.lengthFt > 0) {
      const volts = w.domain === 'ac' ? acV : Number(ends.find((x) => x.n?.type === 'load')?.n?.data.volts ?? V);
      const vd = w.vdropPct ?? vdropPct(a, w.lengthFt, w.gauge, volts);
      const critical = ends.some((x) => x.n?.data.critical === true);
      const limit = w.vdropLimit ?? (critical ? VDROP.critical : VDROP.nonCritical);
      if (vd > limit + 0.01) {
        add('warning', 'conductor-sizing', `${names}: ${vd.toFixed(1)}% voltage drop (limit ${limit}%).`, 'Increase the wire size or shorten the run.', undefined, [w.id]);
      }
    }
  }

  // 9. AC: shore main, galvanic isolator, AC/DC bond, single source, charger feed
  const inlets = design.nodes.filter((n) => n.type === 'shore-inlet');
  for (const inlet of inlets) {
    // With two inlets, say which one.
    const which = inlets.length > 1 ? `${label(inlet)}: ` : '';
    const ws = g.at.get(key(inlet.id, 'l')) ?? [];
    const ok = ws.some((w) => {
      const o = g.node.get(w.from.node === inlet.id ? w.to.node : w.from.node);
      return o && (o.type === 'elci' || o.type === 'breaker') && w.lengthFt <= SHORE_MAIN_MAX_FT;
    });
    if (ws.length && !ok) add('error', 'shore-main', `${which}No main breaker within ${fmtLen(SHORE_MAIN_MAX_FT, units)} of the shore-power inlet.`, 'Install a double-pole main breaker with ELCI protection close to the inlet.', [inlet.id]);
    const hasElci = ws.some((w) => g.node.get(w.from.node === inlet.id ? w.to.node : w.from.node)?.type === 'elci');
    if (ws.length && ok && !hasElci) add('warning', 'shore-main', `${which}The shore-power main breaker has no ELCI (earth-leakage) protection.`, 'Use a main breaker with 30 mA ELCI.', [inlet.id]);
    const gws = g.at.get(key(inlet.id, 'g')) ?? [];
    const hasGi = gws.some((w) => g.node.get(w.from.node === inlet.id ? w.to.node : w.from.node)?.type === 'galvanic-isolator');
    if (!hasGi) add('warning', 'galvanic-isolator', `${which}Shore-power ground has no galvanic isolator.`, 'Install a galvanic isolator (or isolation transformer) in the green ground conductor at the inlet.', [inlet.id]);
    if (!walkGround(g, inlet.id)) {
      add('error', 'ac-dc-bond', `${which}AC grounding conductor is not connected to the DC negative / engine ground.`, 'Bond the AC grounding bus to the main DC negative bus.', [inlet.id]);
    }
  }
  for (const p of design.nodes.filter((n) => n.type === 'ac-panel')) {
    const reach = walk(g, { node: p.id, term: 'in' }, ['ac']).filter((r) => AC_SOURCE_TERMS[r.node.type]?.includes(r.term));
    const kinds = new Set(reach.map((r) => r.node.id));
    if (kinds.size > 1 && reach.some((r) => !r.selected)) {
      add('error', 'source-selector', `${label(p)} can be fed by more than one AC source at once (${reach.map((r) => label(r.node)).join(', ')}).`, 'Add a break-before-make source selector or an automatic transfer switch.', [p.id]);
    }
  }
  for (const c of design.nodes.filter((n) => n.type === 'charger')) {
    const reach = walk(g, { node: c.id, term: 'acin' }, ['ac']);
    if (reach.some((r) => (r.node.type === 'inverter' || r.node.type === 'inverter-charger') && r.term === 'acout')) {
      add('error', 'charger-not-on-inverter', `${label(c)} can be powered by the inverter.`, 'Move the charger to the shore/generator-only AC circuit.', [c.id]);
    }
  }
  for (const n of design.nodes.filter((x) => x.type === 'ac-load')) {
    const reach = walk(g, { node: n.id, term: 'l' }, ['ac']).filter((r) => AC_SOURCE_TERMS[r.node.type]?.includes(r.term));
    if (reach.some((r) => !r.protectedPath)) add('error', 'branch-protection', `${label(n)} has no AC breaker.`, 'Feed it from an AC panel breaker.', [n.id]);
    if (n.data.shoreOnly && reach.some((r) => r.node.type === 'inverter' || r.node.type === 'inverter-charger')) {
      add('warning', 'shore-only', `${label(n)} can run from the inverter and will drain the batteries quickly.`, 'Put it on a shore/generator-only circuit.', [n.id]);
    }
  }

  // 10. Wires that join terminals which must never be joined (e.g. positive to negative)
  for (const w of design.wires) {
    const a = g.node.get(w.from.node);
    const b = g.node.get(w.to.node);
    const pa = a?.terminals.find((t) => t.id === w.from.term)?.pol;
    const pb = b?.terminals.find((t) => t.id === w.to.term)?.pol;
    if (!a || !b || !pa || !pb) continue;
    const joined = joinTerminals(pa, pb);
    if (!joined.ok) add('error', 'wire-mismatch', `${label(a)} → ${label(b)}: this wire joins ${joined.what}.`, 'Delete the wire and redraw it between matching terminals.', [a.id, b.id], [w.id]);
  }

  return out;
}

/**
 * Does something make a stock regulator see battery voltage despite a diode isolator's drop?
 * Either the isolator's excitation ("E") terminal is wired, an alternator's remote-sense lead is wired
 * (it can only usefully go to the battery side), or the user recorded the compensation on the isolator.
 */
function diodeCompensated(g: Graph, iso: DNode): boolean {
  if (iso.data.compensation === 'excite' || iso.data.compensation === 'sense') return true;
  if ((g.at.get(key(iso.id, 'exc')) ?? []).length > 0) return true;
  return g.design.nodes.some((n) => n.type === 'alternator' && (g.at.get(key(n.id, 'sense')) ?? []).length > 0);
}

function walkGround(g: Graph, inletId: string): boolean {
  // gnd wires through conducting nodes until a DC negative bus / engine is reached
  const seen = new Set<string>();
  const stack = [inletId];
  while (stack.length) {
    const id = stack.pop()!;
    if (seen.has(id)) continue;
    seen.add(id);
    const n = g.node.get(id);
    if (!n) continue;
    if (id !== inletId && (n.type === 'bus-neg' || n.type === 'engine' || n.type === 'shunt')) return true;
    if (id !== inletId && n.type !== 'galvanic-isolator' && n.type !== 'ac-ground-bus') continue;
    for (const t of n.terminals) {
      for (const w of g.at.get(key(n.id, t.id)) ?? []) {
        if (w.kind !== 'gnd') continue;
        stack.push(w.from.node === n.id ? w.to.node : w.from.node);
      }
    }
  }
  return false;
}

/**
 * Estimate the current in each wire that has no explicit amps: the side of
 * the wire away from the batteries determines it (sum of loads, or source
 * output for charging conductors).
 */
export function estimateCurrents(design: Design): Map<string, number> {
  const g = buildGraph(design);
  const res = new Map<string, number>();
  const V = design.systemVoltage;
  const loadAmps = (n: DNode): number => {
    if (typeof n.data.amps === 'number') return n.data.amps;
    if (typeof n.data.watts === 'number') return n.data.watts / V;
    return 0;
  };
  const side = (e: { node: string; term: string }, w: Wire) => {
    const n = g.node.get(e.node);
    if (!n) return { bat: false, load: 0, src: 0 };
    const kinds: Wire['kind'][] = [w.kind];
    let reach: Reach[];
    if (!NODE_DEFS[n.type].conducts) {
      reach = [{ node: n, term: e.term, protectedPath: false, switched: false, selected: false, via: [] }];
    } else {
      reach = walk(g, e, kinds, { exclude: w.id });
      for (const t of passThrough(n, e.term)) reach.push(...walk(g, { node: n.id, term: t }, kinds, { exclude: w.id }));
    }
    let bat = false;
    let load = 0;
    let src = 0;
    for (const r of reach) {
      const t = r.node.type;
      if (t === 'battery') bat = true;
      else if ((t === 'inverter' || t === 'inverter-charger') && (r.term === 'dcpos' || r.term === 'dcneg')) {
        // The DC side of an inverter is a load when inverting. An inverter/charger is also a source
        // when charging. This case must come before the general "source" case below, which would
        // otherwise count only the (much smaller) charge current.
        load += inverterDcAmps(Number(r.node.data.watts ?? 0), V);
        if (t === 'inverter-charger') src += Number(r.node.data.amps ?? 0);
      } else if (SOURCE_TERMS[t]?.includes(r.term) || AC_SOURCE_TERMS[t]?.includes(r.term) || t === 'solar-panel' || t === 'wind-gen' || t === 'hydro-gen') src += Number(r.node.data.amps ?? r.node.data.rating ?? 0);
      else if (t === 'load' || t === 'engine' || t === 'ac-load') load += loadAmps(r.node);
      else if (t === 'converter' || t === 'dcdc') load += Number(r.node.data.rating ?? 0) * 0.6;
    }
    return { bat, load, src };
  };
  for (const w of design.wires) {
    if (w.amps !== undefined || w.kind === 'sig' || w.kind === 'gnd') continue;
    const a = side(w.from, w);
    const b = side(w.to, w);
    let amps: number | undefined;
    // Away from the battery the wire carries the loads out or the charge in, whichever is larger.
    if (a.bat && !b.bat) amps = Math.max(b.load, b.src);
    else if (b.bat && !a.bat) amps = Math.max(a.load, a.src);
    else amps = Math.max(a.load, b.load, a.src, b.src) || undefined;
    if (amps !== undefined) res.set(w.id, amps);
  }
  return res;
}

