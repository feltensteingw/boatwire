// The AC side: shore power inlet and generator, the inverter or inverter/charger, AC panels and
// their circuits, battery chargers, and the grounding that ties it to the DC negative.

import { CATALOG_BY_KIND, MAX_SHORE_INLETS } from '../../model/catalog';
import type { DNode } from '../../model/types';
import { fuseClassFor, gaugeIndex } from '../calc';
import { num } from '../energy';
import { fuseLabel, type Builder, type End } from './builder';
import type { Core } from './houseBank';
import type { Plan } from './plan';

export function buildAc(b: Builder, p: Plan, core: Core, startBus: DNode | undefined) {
  const { V, acStd, BZ, PZ, run, kinds, lfp, ic, inv, acLoads, chargers, invDcAmps } = p;
  const { posBus, negBus, bms } = core;

  const shores = kinds('shore-power').slice(0, MAX_SHORE_INLETS);
  const genset = kinds('generator')[0];
  const anyAc = !!(shores.length || genset || ic || inv || acLoads.length || chargers.length);
  if (!anyAc) return;

  const acV = acStd.volts;
  const minBrk = b.us ? 15 : 10;
  /**
   * AC breaker for `a` amps. An appliance too big for one is split or given its own circuit; a
   * source (generator or inverter) puts its whole output through one breaker, so splitting the loads
   * does not help, and the fix is a smaller source or a larger breaker.
   */
  const acBrk = (a: number, what: string, nodes?: string[], source?: 'generator' | 'inverter') => {
    const fix = source
      ? `Choose a smaller ${source}${b.us ? ' or one with 120/240 V output (which splits the current between two legs)' : ''}, or fit a breaker rated for its full output.`
      : 'Split the load across two circuits, or use a larger dedicated circuit with its own breaker and cable.';
    return Math.max(minBrk, b.protection(a, { what, fix, nodes }, 'breaker-ac'));
  };
  const acGnd = b.add('ac-ground-bus', 'ac-gnd', 'AC grounding bus', { zone: PZ, notes: ['ac-dc-bond'] });
  let sourceOut: End | undefined;
  let sourceAmps = 0;
  let shoreCableGauge = '10';
  const groundTo = (from: End, len: number, equipmentGround = true) =>
    b.wire('gnd', from, [acGnd, b.stud(acGnd)], { amps: 0, len, gauge: shoreCableGauge, equipmentGround });

  // Each AC source where it leaves its own main breaker: the current it brings, that breaker's
  // rating, where it is, and its name on the source selector (`term` on the selector's input).
  const sources: { out: End; amps: number; rating: number; zone: string; name: string; term: string }[] = [];
  // The cable from each inlet, of which the largest sizes the AC/DC bond and the equipment grounds.
  const inletGauges: string[] = [];
  shores.forEach((shore, i) => {
    // A second inlet gets its own parts, numbered. With one inlet, ids and labels are as they always were.
    const sfx = i ? `-${i + 1}` : '';
    const tag = shores.length > 1 ? ` ${i + 1}` : '';
    const A = num(shore, 'amps', 30);
    // with two, the sublabel names the selector position it feeds ("Shore 2 · 50 A 120 V")
    const inlet = b.add('shore-inlet', `shore-inlet${sfx}`, shore.name, { zone: shore.zone, equipmentId: shore.id, sublabel: `${tag ? `Shore${tag} · ` : ''}${A} A ${acV} V`, data: { amps: A, volts: acV } });
    const elci = b.add('elci', `shore-elci${sfx}`, `Shore${tag} main breaker + ELCI`, { zone: shore.zone, sublabel: `${A} A · 30 mA ELCI`, data: { rating: A, part: `${A} A double-pole main breaker with ELCI` }, notes: ['shore-main'] });
    const gi = b.add('galvanic-isolator', `galv-iso${sfx}`, `Galvanic isolator${tag}`, { zone: shore.zone, data: { rating: A, part: `Galvanic isolator, ${A} A, fail-safe` }, notes: ['galvanic-isolator'] });
    const w = b.wire('ac', [inlet, 'l'], [elci, 'in'], { amps: A, protect: A, len: 3, notes: ['shore-main'] });
    // its green conductor is the size of its own cable
    b.wire('gnd', [inlet, 'g'], [gi, 'a'], { amps: 0, len: 1, gauge: w.gauge, notes: ['galvanic-isolator'] });
    b.wire('gnd', [gi, 'b'], [acGnd, b.stud(acGnd)], { amps: 0, len: run(shore.zone, PZ), gauge: w.gauge, notes: ['galvanic-isolator'] });
    inletGauges.push(w.gauge!);
    sources.push({ out: [elci, 'out'], amps: A, rating: A, zone: shore.zone, name: `Shore${tag}`, term: `Shore${tag}` });
  });
  if (inletGauges.length) shoreCableGauge = inletGauges.reduce((a, g) => (gaugeIndex(g) > gaugeIndex(a) ? g : a));
  // AC ground ↔ DC negative bond
  b.wire('gnd', [acGnd, b.stud(acGnd)], [negBus, b.stud(negBus)], { amps: 0, len: run(PZ, BZ), gauge: shoreCableGauge, notes: ['ac-dc-bond'] });

  if (genset) {
    const GW = num(genset, 'watts');
    const GA = GW / acV;
    const gR = acBrk(GA, 'Generator main breaker', ['gen-brk'], 'generator');
    const g = b.add('generator', 'genset', genset.name, { zone: genset.zone, equipmentId: genset.id, sublabel: `${GW} W`, data: { watts: GW, amps: GA } });
    const gb = b.add('elci', 'gen-brk', 'Generator main breaker', { zone: genset.zone, sublabel: `${gR} A`, data: { rating: gR } });
    b.wire('ac', [g, 'l'], [gb, 'in'], { amps: GA, protect: gR, len: 2 });
    groundTo([g, 'g'], run(genset.zone, PZ), false);
    sources.push({ out: [gb, 'out'], amps: GA, rating: gR, zone: genset.zone, name: 'Generator', term: 'Gen' });
  }
  if (sources.length === 1) {
    sourceOut = sources[0].out;
    sourceAmps = sources[0].rating;
  } else if (sources.length > 1) {
    // One break-before-make selector lets a single source feed everything after it. Everything
    // after it is sized for the largest source breaker, since any one of them may be selected.
    const rating = Math.max(...sources.map((s) => s.rating));
    const sel = b.add('selector', 'ac-selector', 'AC source selector', {
      zone: PZ,
      sublabel: `Off / ${sources.map((s) => s.name).join(' / ')} (break-before-make)`,
      data: { rating },
      notes: ['source-selector'],
      ...(sources.length > 2 ? { extraTerminals: sources.slice(2).map((s, i): [string, 'ac', 'W', string] => [`in${i + 3}`, 'ac', 'W', s.term]) } : {}),
    });
    sources.forEach((s, i) => {
      sel.terminals.find((t) => t.id === `in${i + 1}`)!.label = s.term;
      b.wire('ac', s.out, [sel, `in${i + 1}`], { amps: s.amps, protect: s.rating, len: run(s.zone, PZ) });
    });
    sourceOut = [sel, 'out'];
    sourceAmps = rating;
  }
  const srcZone = shores.length === 1 && !genset ? shores[0].zone : PZ;

  const shoreOnlyLoads = acLoads.filter((e) => !!e.props.shoreOnly);

  const acPanel = (id: string, label: string, mainA: number, sub: string) =>
    b.add('ac-panel', id, label, { zone: PZ, sublabel: `${sub} · main ${mainA} A`, data: { rating: mainA, part: `AC panel, ${mainA} A main` } });

  let mainPanel: DNode | undefined;
  let shorePanel: DNode | undefined;

  const dcInverter = (n: DNode, dcAmps: number) => {
    const r = b.protection(dcAmps, {
      what: `${n.label} DC fuse`,
      fix: V === 12 ? 'Use 24 V, which halves the current, or a smaller inverter.' : 'Use a smaller inverter, or a higher system voltage.',
      nodes: [`${n.id}-fuse`],
    }, 'feeder-fuse');
    const cls = fuseClassFor(r, { lithium: lfp, mainFeeder: true, atBattery: lfp });
    const f = b.add('fuse', `${n.id}-fuse`, `${n.label} DC fuse`, { zone: BZ, col: 4, sublabel: fuseLabel(r, cls), data: { rating: r, fuseClass: cls }, notes: ['inverter-fuse', ...(cls === 'Class T' ? ['class-t'] : [])] });
    b.wire('pos', [posBus, b.stud(posBus)], [f, 'in'], { amps: dcAmps, protect: r, len: 0.5 });
    b.pair([[f, 'out'], [n, 'dcpos']], [[negBus, b.stud(negBus)], [n, 'dcneg']], { amps: dcAmps, protect: r, len: run(BZ, n.zone) + 1, protectedBy: f.id, notes: ['inverter-fuse', 'conductor-sizing'] });
    groundTo([n, 'g'], run(n.zone, PZ));
    if (bms && n.terminals.some((t) => t.id === 'atc')) b.wire('sig', [bms, 'atc'], [n, 'atc'], { amps: 0, len: 2 });
  };

  if (ic) {
    const W = num(ic, 'watts');
    const chA = num(ic, 'chargeAmps');
    const node = b.add('inverter-charger', 'ic', ic.name, { zone: ic.zone || BZ, equipmentId: ic.id, sublabel: `${W} W · ${chA} A charger`, data: { watts: W, amps: chA, part: `Inverter/charger ${V} V ${W} W` }, notes: ['source-selector', 'inverter-fuse'] });
    dcInverter(node, Math.max(invDcAmps, chA));
    const outA = W / acV;
    if (sourceOut) {
      b.wire('ac', sourceOut, [node, 'acin'], { amps: sourceAmps, protect: sourceAmps, len: run(srcZone, node.zone) });
    }
    const mainA = sourceOut ? sourceAmps : acBrk(outA, 'AC panel main breaker', ['ac-panel'], 'inverter');
    mainPanel = acPanel('ac-panel', 'AC panel', mainA, sourceOut ? 'Inverter-backed' : 'Inverter only');
    b.wire('ac', [node, 'acout'], [mainPanel, 'in'], { amps: Math.max(outA, sourceAmps), protect: mainA, len: run(node.zone, PZ) });
    if (sourceOut && (shoreOnlyLoads.length || chargers.length)) {
      shorePanel = acPanel('ac-panel-shore', 'AC panel — shore/gen only', sourceAmps, 'Not powered by inverter');
      b.wire('ac', sourceOut, [shorePanel, 'in'], { amps: sourceAmps, protect: sourceAmps, len: 2, notes: ['shore-only'] });
    }
  } else if (inv) {
    const W = num(inv, 'watts');
    const node = b.add('inverter', 'inv', inv.name, { zone: inv.zone || BZ, equipmentId: inv.id, sublabel: `${W} W`, data: { watts: W, part: `Inverter ${V} V ${W} W` }, notes: ['inverter-fuse'] });
    dcInverter(node, invDcAmps);
    const outA = W / acV;
    if (sourceOut) {
      const ats = b.add('transfer-switch', 'ats', 'Automatic transfer switch', { zone: PZ, sublabel: 'Shore/gen priority', data: { rating: sourceAmps }, notes: ['source-selector'] });
      b.wire('ac', sourceOut, [ats, 'in1'], { amps: sourceAmps, protect: sourceAmps, len: run(srcZone, PZ) });
      b.wire('ac', [node, 'acout'], [ats, 'in2'], { amps: outA, protect: acBrk(outA, `${node.label} AC output`, [node.id, 'ats'], 'inverter'), len: run(node.zone, PZ) });
      mainPanel = acPanel('ac-panel', 'AC panel', sourceAmps, 'Inverter-backed');
      b.wire('ac', [ats, 'out'], [mainPanel, 'in'], { amps: sourceAmps, protect: sourceAmps, len: 2 });
      if (shoreOnlyLoads.length || chargers.length) {
        shorePanel = acPanel('ac-panel-shore', 'AC panel — shore/gen only', sourceAmps, 'Not powered by inverter');
        b.wire('ac', sourceOut, [shorePanel, 'in'], { amps: sourceAmps, protect: sourceAmps, len: 2, notes: ['shore-only', 'charger-not-on-inverter'] });
      }
    } else {
      const mainA = acBrk(outA, 'AC panel main breaker', ['ac-panel'], 'inverter');
      mainPanel = acPanel('ac-panel', 'AC panel', mainA, 'Inverter only');
      b.wire('ac', [node, 'acout'], [mainPanel, 'in'], { amps: outA, protect: mainA, len: run(node.zone, PZ) });
    }
  } else if (sourceOut) {
    mainPanel = acPanel('ac-panel', 'AC panel', sourceAmps, 'Shore/gen');
    b.wire('ac', sourceOut, [mainPanel, 'in'], { amps: sourceAmps, protect: sourceAmps, len: run(srcZone, PZ) });
  }

  const acCircuit = (panel: DNode, label: string, amps: number, target: End, zone: string, notes: string[] = []) => {
    const r = acBrk(amps, `${label} breaker`, [panel.id]);
    const t = b.stud(panel, { pol: 'ac', rating: r, label: `${r} A · ${label}` });
    b.wire('ac', [panel, t], target, { amps, protect: r, len: run(PZ, zone), protectedBy: panel.id, notes: ['branch-protection', ...notes] });
  };

  for (const e of acLoads) {
    const W = num(e, 'watts');
    const A = W / acV;
    const target = e.props.shoreOnly ? shorePanel ?? (inv || ic ? undefined : mainPanel) : mainPanel;
    const node = b.add('ac-load', `ac-${e.id}`, e.name, { zone: e.zone, equipmentId: e.id, sublabel: `${W} W · ${A.toFixed(1)} A`, data: { watts: W, amps: A, kind: e.kind, shoreOnly: !!e.props.shoreOnly, glyph: CATALOG_BY_KIND[e.kind]?.glyph }, notes: e.props.shoreOnly ? ['shore-only'] : [] });
    if (!target) {
      b.find('warning', 'shore-only', `${e.name} is shore-only but there is no shore power or generator to feed it.`);
      continue;
    }
    acCircuit(target, e.name, A, [node, 'l'], e.zone, e.props.shoreOnly ? ['shore-only'] : []);
    groundTo([node, 'g'], run(e.zone, PZ));
  }
  for (const c of chargers) {
    const A = num(c, 'amps');
    const outputs = Math.max(1, num(c, 'outputs', 1));
    const node = b.add('charger', `chg-${c.id}`, c.name, { zone: c.zone || BZ, equipmentId: c.id, sublabel: `${A} A · ${outputs} output${outputs > 1 ? 's' : ''}`, data: { amps: A, part: `Battery charger ${V} V ${A} A` }, notes: ['charger-not-on-inverter'] });
    const feedPanel = shorePanel ?? (ic || inv ? undefined : mainPanel);
    const acA = (A * V * 1.2) / acV / 0.85;
    if (feedPanel) {
      acCircuit(feedPanel, c.name, acA, [node, 'acin'], node.zone, ['charger-not-on-inverter']);
    } else {
      b.find('warning', 'charger-not-on-inverter', `${c.name} has no shore/generator-only AC circuit to feed it.`);
    }
    groundTo([node, 'g'], run(node.zone, PZ));
    const fr = b.protection(A, { what: `${c.name} output fuse`, nodes: [`chgfuse-${c.id}`] });
    const f = b.add('fuse', `chgfuse-${c.id}`, 'Charger output fuse', { zone: BZ, sublabel: fuseLabel(fr, fuseClassFor(fr, {})), data: { rating: fr, fuseClass: fuseClassFor(fr, {}) }, notes: ['charging-source-fuse'] });
    b.pair([[node, 'out1'], [f, 'in']], [[node, 'neg'], [negBus, b.stud(negBus)]], { amps: A, protect: fr, len: run(node.zone, BZ) + 1, protectedBy: f.id });
    b.wire('pos', [f, 'out'], [posBus, b.stud(posBus)], { amps: A, protect: fr, len: 0.5 });
    if (startBus && outputs >= 2) {
      node.terminals.push({ id: 'out2', pol: 'pos', side: 'E', label: 'OUT2+' });
      const sA = Math.min(A, 10);
      const fr2 = b.protection(sA, { what: `${c.name} start output fuse`, nodes: [`chgfuse2-${c.id}`] });
      const f2 = b.add('fuse', `chgfuse2-${c.id}`, 'Charger start output fuse', { zone: startBus.zone, sublabel: fuseLabel(fr2, fuseClassFor(fr2, {})), data: { rating: fr2, fuseClass: fuseClassFor(fr2, {}) }, notes: ['charging-source-fuse'] });
      b.wire('pos', [node, 'out2'], [f2, 'in'], { amps: sA, protect: fr2, len: run(node.zone, startBus.zone) + 1, protectedBy: f2.id });
      b.wire('pos', [f2, 'out'], [startBus, b.stud(startBus)], { amps: sA, protect: fr2, len: 0.5 });
    }
  }
  if (!shores.length && !genset && (chargers.length || shoreOnlyLoads.length)) {
    b.find('info', 'shore-main', 'There are AC chargers or shore-only loads but no shore power inlet or generator.');
  }
}
