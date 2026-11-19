// Engine: the starter circuit, the alternator, and how its charge is shared between the start
// battery and the house bank (charging relay, battery isolator, or DC-DC charger for lithium).
//
// A twin-engine boat gets all of this once per engine: the first engine is built completely, then
// the second, then the emergency parallel switch between their start batteries. The first engine
// keeps the ids a single engine has; the second engine's parts end in "-2".

import { DCDC_INPUT_FACTOR, FUSE_CLASSES, START_DCDC_SIZES } from '../../model/standards';
import type { Chemistry, DNode, Equipment } from '../../model/types';
import { fuseClassFor, gaugeIndex } from '../calc';
import { num } from '../energy';
import { bankSummary, fuseLabel, type Builder, type WOpts } from './builder';
import type { Core } from './houseBank';
import { reportBank, type Plan } from './plan';

/** Start battery fuse sizes: terminal (MRBF) fuses, whose largest is 300 A. */
const START_FUSE_SIZES = [100, 150, 200, 250, 300];

/** What to do when the alternator puts out more than the largest fuse or relay fuse. */
const ALT_FIX = 'Check the alternator output entered. If it is right, a higher system voltage would halve the current.';

/** The charge profile a DC-DC charger is set to, named for the battery it charges. */
const PROFILE: Record<Chemistry, string> = { flooded: 'flooded', agm: 'AGM', gel: 'gel', lifepo4: 'lithium' };
/** The profile for a chemistry, or nothing for one BoatWire does not know (from a hand-edited file, say). */
const profileOf = (chem: string | undefined) => (chem && Object.hasOwn(PROFILE, chem) ? PROFILE[chem as Chemistry] : undefined);

/** Suffix of the ids of the i-th engine's (or start battery's) parts: none for the first, "-2" for the second. */
const idSuffix = (i: number) => (i ? `-${i + 1}` : '');

/** A start battery: one engine's own, or one both engines share. */
interface StartBattery {
  bank: Equipment;
  chem: Chemistry;
  /** Id suffix, label number (" 1", " 2") and finding prefix ("Port engine: ") of its parts: set only when each engine has its own. */
  sfx: string;
  tag: string;
  who: string;
  /** Both engines start from it. */
  shared: boolean;
  /** The largest starter and the longest cable run of the engines it starts. */
  starterA: number;
  crankLen: number;
  /** The engines whose alternator charges it through a charging relay. */
  relayFor: Slot[];
  /** Drawn by the first engine that starts from it. */
  drawn?: { node: DNode; fuse: DNode; bus: DNode; cable: string };
  /** A charging relay or DC-DC charger from the house bank has been drawn to it. */
  fedFromHouse?: boolean;
}

/** One engine, and what was decided about its alternator before anything is drawn. */
interface Slot {
  engine: Equipment;
  /** Id suffix (none, or "-2"), label number (" 1", " 2" on twins) and finding prefix ("Port engine: " on twins). */
  sfx: string;
  tag: string;
  who: string;
  /** The start battery it starts from, if the boat has one. */
  start?: StartBattery;
  starterA: number;
  /** Alternator output at the system voltage. */
  altA: number;
  /** An external (smart) regulator is fitted. */
  extReg: boolean;
  /** Zone of the engine. */
  EZ: string;
  /** Cable run from the batteries to the engine. */
  crankLen: number;
  /** The charge-splitting arrangement the user chose for the engine. */
  split: string;
  wantsRunRelay: boolean;
  wantsIso: boolean;
  /**
   * One of the two batteries is lithium, so they are kept apart by a DC-DC charger: a relay or
   * isolator would parallel lithium with lead-acid, or give lithium the alternator's charge voltage.
   */
  needsDcdc: boolean;
  /** Lithium house, stock regulator: the alternator charges the lead-acid start battery instead. */
  toStart: boolean;
  /** The alternator feeds both banks through an isolator. */
  useIso: boolean;
}

/** The engine as drawn, for the alternator wiring that hangs off it. */
interface EngineInfo extends Slot {
  engineNode: DNode;
  /** Positive bus of the start battery, if the boat has one. */
  startBus?: DNode;
  /** Chemistry of the start battery, if the boat has one. */
  startChem?: Chemistry;
}

/** The alternator, shared by the wiring arrangements below. */
interface Alt extends EngineInfo {
  alt: DNode;
  altFuseR: number;
  altFuseCls: ReturnType<typeof fuseClassFor>;
  /** Cable run from the alternator to the batteries. */
  altLen: number;
}

/** Engines, starter circuits and alternator charging. Returns the start batteries' buses. */
export function buildEngine(b: Builder, p: Plan, core: Core): { startBuses: DNode[] } {
  const { engines, startBanks, V, BZ, run, scale, lfp } = p;
  if (!engines.length) return { startBuses: [] };
  const twin = engines.length > 1;
  // two start batteries: one for each engine; one: both engines start from it
  const each = startBanks.length > 1;

  const starts: StartBattery[] = startBanks.map((bank, i) => ({
    bank,
    chem: bankSummary(bank, V).chem,
    sfx: idSuffix(i),
    tag: each ? ` ${i + 1}` : '',
    who: each ? `${engines[i].name}: ` : '',
    shared: twin && !each,
    starterA: 0,
    crankLen: 0,
    relayFor: [],
  }));
  const slots = engines.map((engine, i): Slot => {
    const start = starts[each ? i : 0];
    const extReg = engine.props.regulator === 'external';
    const split = String(engine.props.chargeSplit ?? 'auto');
    const needsDcdc = lfp || start?.chem === 'lifepo4';
    const wantsIso = split === 'isolator-fet' || split === 'isolator-diode';
    const EZ = engine.zone || BZ;
    return {
      engine,
      sfx: idSuffix(i),
      tag: twin ? ` ${i + 1}` : '',
      who: twin ? `${engine.name}: ` : '',
      start,
      starterA: num(engine, 'starterAmps', 150) * scale,
      altA: num(engine, 'alternatorAmps', 0) * scale,
      extReg,
      EZ,
      crankLen: run(BZ, EZ),
      split,
      wantsRunRelay: split === 'relay-run',
      wantsIso,
      needsDcdc,
      // Lithium house, stock regulator: the alternator charges the lead-acid start battery instead.
      // (A lithium start battery is no better, so then the design asks for an external regulator.)
      toStart: lfp && !extReg && !!start && start.chem !== 'lifepo4',
      useIso: wantsIso && !needsDcdc && !!start,
    };
  });
  for (const st of starts) {
    const users = slots.filter((s) => s.start === st);
    st.starterA = Math.max(...users.map((s) => s.starterA));
    st.crankLen = Math.max(...users.map((s) => s.crankLen));
    st.relayFor = users.filter((s) => s.altA > 0 && !s.useIso && !s.needsDcdc);
  }

  for (const s of slots) buildOneEngine(b, p, core, s);
  if (starts.length === 2) parallelSwitch(b, p, starts[0], starts[1]);
  return { startBuses: starts.flatMap((s) => (s.drawn ? [s.drawn.bus] : [])) };
}

/** One engine: its starter circuit, its negative to the main negative bus, and its alternator. */
function buildOneEngine(b: Builder, p: Plan, core: Core, s: Slot) {
  const { BZ, lfp } = p;
  const { posBus, negBus } = core;
  const { engine, sfx, tag, start, starterA, altA, EZ, crankLen } = s;

  const engineNode = b.add('engine', `engine${sfx}`, engine.name, {
    zone: EZ,
    equipmentId: engine.id,
    sublabel: `${tag ? `Engine${tag} · ` : ''}Starter ~${Math.round(starterA)} A`,
    data: { amps: starterA, kind: 'engine', glyph: 'ENG' },
    notes: ['starter-exempt', 'common-negative', ...(tag ? ['twin-engines'] : [])],
  });
  if (start) {
    const { node: sbat, fuse: sfuse, bus: startBus, cable } = start.drawn ?? drawStartBattery(b, p, start);
    const so: WOpts = { amps: starterA, protect: starterA, len: crankLen, gauge: cable, notes: ['starter-exempt'] };
    b.wire('pos', [startBus, b.stud(startBus)], [engineNode, 'pos'], { ...so, engine: true, protectedBy: sfuse.id });
    b.wire('neg', [sbat, 'neg'], [engineNode, 'neg'], { ...so, notes: ['common-negative'] });
  } else {
    const esw = b.add('switch', `engine-switch${sfx}`, `Engine${tag} start switch`, { zone: BZ, data: { rating: 300 }, notes: ['battery-switch'] });
    const so: WOpts = { amps: starterA, protect: starterA, len: 0.5, vdLen: crankLen + 3, notes: ['starter-exempt'] };
    const w1 = b.wire('pos', [posBus, b.stud(posBus)], [esw, 'in'], so);
    b.wire('pos', [esw, 'out'], [engineNode, 'pos'], { ...so, len: crankLen, gauge: w1.gauge, engine: true });
    // (on a twin-engine boat the second engine's note is the same message, which find() drops)
    if (tag) b.find(lfp ? 'warning' : 'info', 'house-start-split', 'No dedicated start battery: both engines start from the house bank.', 'Add a start battery (role "Engine start") for each engine, or one they share, so a flat house bank can never stop you starting them.');
    else b.find(lfp ? 'warning' : 'info', 'house-start-split', 'No dedicated start battery: the engine starts from the house bank.', 'Add a start battery (role "Engine start") so a flat house bank can never stop you starting the engine.');
  }
  // engine block to main negative bus (common ground)
  const engNegGauge = b.wires.filter((w) => w.to.node === engineNode.id || w.from.node === engineNode.id).map((w) => w.gauge)[0];
  b.wire('neg', [engineNode, 'neg'], [negBus, b.stud(negBus)], { amps: Math.max(altA, starterA), len: crankLen, gauge: engNegGauge, engine: true, notes: ['common-negative'] });

  if (altA > 0) buildAlternator(b, p, core, { ...s, engineNode, startBus: start?.drawn?.bus, startChem: start?.chem });
}

/**
 * A start battery with its fuse, switch and bus. One both engines share is sized for the larger
 * starter over the longer cable run, for one start at a time.
 */
function drawStartBattery(b: Builder, p: Plan, st: StartBattery): NonNullable<StartBattery['drawn']> {
  const { V, BZ } = p;
  const { bank, sfx, tag, who, starterA, crankLen } = st;
  const s = bankSummary(bank, V);
  const sbat = b.add('battery', `start-bat${sfx}`, bank.name, { zone: bank.zone || BZ, equipmentId: bank.id, sublabel: s.text, data: { chemistry: s.chem, ah: s.ah, volts: V }, notes: ['house-start-split', ...(st.shared ? ['twin-engines'] : [])] });
  reportBank(b, p, bank, s, sbat);
  const sfWanted = Math.ceil((starterA * 2) / 50) * 50;
  // the larger fuse families that come in that size
  const sfKinds = (['Class T', 'ANL'] as const).filter((c) => FUSE_CLASSES[c].max >= sfWanted).join(' or ');
  const sfRating = b.rating(starterA * 2, START_FUSE_SIZES, {
    what: `${who}Start battery${tag} fuse`,
    carries: starterA,
    fix: `Fit a larger start fuse (${sfKinds ? `${sfKinds}, ` : ''}about ${sfWanted} A) or the size the engine maker recommends, and check the starter current entered.`,
    nodes: [`start-fuse${sfx}`],
  });
  const sfClass = fuseClassFor(sfRating, { atBattery: true, lithium: s.chem === 'lifepo4' });
  const sfuse = b.add('fuse', `start-fuse${sfx}`, `Start battery${tag} fuse`, { zone: sbat.zone, sublabel: fuseLabel(sfRating, sfClass), data: { rating: sfRating, fuseClass: sfClass }, notes: ['battery-fuse', 'starter-exempt', ...(sfClass === 'Class T' ? ['class-t'] : [])] });
  const ssw = b.add('switch', `start-switch${sfx}`, `Start battery${tag} switch`, { zone: sbat.zone, data: { rating: 300 }, notes: ['battery-switch'] });
  const startBus = b.add('bus-pos', `start-bus${sfx}`, `Start positive bus${tag}`, { zone: sbat.zone });
  const so: WOpts = { amps: starterA, protect: starterA, len: 0.5, vdLen: crankLen + 3, notes: ['starter-exempt'] };
  const w1 = b.wire('pos', [sbat, 'pos'], [sfuse, 'in'], so);
  b.wire('pos', [sfuse, 'out'], [ssw, 'in'], { ...so, len: 1, gauge: w1.gauge, protectedBy: sfuse.id });
  b.wire('pos', [ssw, 'out'], [startBus, b.stud(startBus)], { ...so, len: 1.5, gauge: w1.gauge, protectedBy: sfuse.id });
  if (s.chem === 'lifepo4') b.find('warning', 'alternator-lfp', `${who}Lithium start battery: most designs keep the start battery lead-acid so the alternator always has a battery it cannot be disconnected from.`);
  if (st.shared) b.find('info', 'twin-engines', `Both engines start from ${bank.name}. It and its cables are sized for one starter at a time, so start the engines one after the other.`, undefined, [sbat.id]);
  st.drawn = { node: sbat, fuse: sfuse, bus: startBus, cable: w1.gauge! };
  return st.drawn;
}

/**
 * A start battery for each engine: a normally-off switch between them, so either battery can start
 * either engine if one is flat. Never between lithium and lead-acid, which must not be joined.
 */
function parallelSwitch(b: Builder, p: Plan, s1: StartBattery, s2: StartBattery) {
  const { run } = p;
  const [d1, d2] = [s1.drawn!, s2.drawn!];
  if ((s1.chem === 'lifepo4') !== (s2.chem === 'lifepo4')) {
    const [li, lead] = s1.chem === 'lifepo4' ? [s1, s2] : [s2, s1];
    b.find('info', 'twin-engines', `No emergency parallel switch: ${li.bank.name} is lithium and ${lead.bank.name} lead-acid, and they must never be joined.`, 'Use one chemistry for both.', [d1.node.id, d2.node.id]);
    return;
  }
  const sw = b.add('switch', 'start-parallel', 'Emergency parallel switch', { zone: d1.bus.zone, sublabel: 'Normally off', data: { rating: 300, part: '300 A, emergency parallel (normally off)' }, notes: ['twin-engines'] });
  // sized for the larger starter, and never smaller than either start cable
  const amps = Math.max(s1.starterA, s2.starterA);
  const cable = gaugeIndex(d1.cable) >= gaugeIndex(d2.cable) ? d1.cable : d2.cable;
  const o: WOpts = { amps, protect: amps, len: 1, gauge: cable, notes: ['starter-exempt'] };
  b.wire('pos', [d1.bus, b.stud(d1.bus)], [sw, 'in'], { ...o, protectedBy: d1.fuse.id });
  b.wire('pos', [sw, 'out'], [d2.bus, b.stud(d2.bus)], { ...o, len: run(d1.bus.zone, d2.bus.zone) + 1, protectedBy: d2.fuse.id });
}

function buildAlternator(b: Builder, p: Plan, core: Core, e: EngineInfo) {
  const { BZ, run, lfp } = p;
  const { engine, sfx, tag, who, startBus, altA, extReg, EZ, split, needsDcdc, toStart, wantsIso, useIso, wantsRunRelay } = e;

  const alt = b.add('alternator', `alternator${sfx}`, `Alternator${tag}`, { zone: EZ, sublabel: `${Math.round(altA)} A${extReg ? ' · ext. reg.' : ''}`, data: { amps: altA, part: `${num(engine, 'alternatorAmps')} A alternator` } });
  const altFuseR = b.protection(altA, { what: `${who}Alternator${tag} output fuse`, fix: ALT_FIX, nodes: [`alt-fuse${sfx}`] }, 'feeder-fuse');
  const altFuseCls = fuseClassFor(altFuseR, { lithium: lfp, mainFeeder: true });
  const altLen = run(EZ, BZ);

  // A relay or isolator the owner chose but the design cannot use: say what it uses instead.
  const [lithium, other] = lfp ? ['the lithium house bank', 'the start battery'] : ['the lithium start battery', 'the house bank'];
  const instead =
    toStart || !lfp
      ? 'The design uses a DC-DC charger instead.'
      : startBus
        ? 'Instead, the design charges the start battery from the house bank through a DC-DC charger, and the alternator charges the lithium house bank through an external regulator and an alternator protection device.'
        : 'The design uses an external regulator and alternator protection instead.';
  if (wantsRunRelay && needsDcdc) {
    b.find('info', 'charge-relay', `${who}Charge splitting is set to an engine-run charging relay, but a relay would parallel ${lithium} with ${other} while the engine runs.`, instead);
  } else if (wantsRunRelay && !startBus) {
    b.find('info', 'charge-relay', `${who}Charge splitting is set to a charging relay, but there is only one battery bank, so no relay is needed.`);
  } else if (split === 'acr' && needsDcdc && startBus) {
    b.find('info', 'acr', `${who}Charge splitting is set to an ACR, but an ACR would parallel ${lithium} with ${other} whenever either is being charged.`, instead);
  }
  if (wantsIso && needsDcdc) {
    b.find('info', 'isolator', `${who}Charge splitting is set to a battery isolator, but an isolator cannot give ${lithium} its own charge profile or protect the alternator from a BMS disconnect.`, instead);
  } else if (wantsIso && !startBus) {
    b.find('info', 'isolator', `${who}Charge splitting is set to a battery isolator, but there is only one battery bank, so no isolator is needed.`);
  }

  const a: Alt = { ...e, alt, altFuseR, altFuseCls, altLen };
  if (toStart && startBus) {
    alternatorToStartBattery(b, p, core, a, startBus);
    return;
  }
  if (useIso && startBus) alternatorThroughIsolator(b, p, core, a, startBus);
  else alternatorToHouse(b, p, core, a);
  alternatorRegulation(b, p, core, a);
  if (needsDcdc && !lfp) {
    // Lead-acid house, lithium start battery: with no relay to the start battery, the house bank is the
    // only battery on the alternator, and the house battery switch can disconnect it.
    alternatorProtection(b, a, 'alternator-disconnect');
    b.find(
      'info',
      'alternator-disconnect',
      `${who}The start battery is charged through a DC-DC charger, so the house bank is the only battery on the alternator. Switching the house bank off with the engine running would leave the alternator with no battery, and the voltage spike can destroy it. The design adds an alternator protection device to absorb that spike.`,
      'Never switch the house bank off while the engine is running.',
    );
  }
  // (not needed when an isolator feeds both banks)
  if (startBus && !useIso) chargeStartFromHouse(b, p, core, a, startBus);
}

/** An alternator protection device on the alternator output, which absorbs the spike if its battery is disconnected while it charges. */
function alternatorProtection(b: Builder, a: Alt, note: string) {
  const { alt, engineNode, EZ, sfx, tag } = a;
  const apd = b.add('apd', `alt-apd${sfx}`, `Alternator protection device${tag}`, { zone: EZ, data: { part: 'Alternator protection device (APD)' }, notes: [note] });
  b.wire('pos', [alt, 'b'], [apd, 'b'], { amps: 5, protect: 10, len: 1, gauge: '10', engine: true });
  b.wire('neg', [apd, 'neg'], [engineNode, 'neg'], { amps: 5, len: 1, gauge: '10', engine: true });
}

/** Lithium house, lead-acid start battery, stock regulator: the alternator charges the start battery, and a DC-DC charger carries the charge on to the house bank. */
function alternatorToStartBattery(b: Builder, p: Plan, core: Core, a: Alt, startBus: DNode) {
  const { V, BZ } = p;
  const { posBus, negBus } = core;
  const { alt, altA, altFuseR, altFuseCls, altLen, engineNode, crankLen, sfx, tag, who } = a;

  const af = b.add('fuse', `alt-fuse${sfx}`, `Alternator${tag} output fuse`, { zone: startBus.zone, sublabel: fuseLabel(altFuseR, altFuseCls), data: { rating: altFuseR, fuseClass: altFuseCls }, notes: ['charging-source-fuse'] });
  b.wire('pos', [alt, 'b'], [af, 'in'], { amps: altA, protect: altFuseR, len: altLen, engine: true, protectedBy: af.id, notes: ['alternator-lfp'] });
  b.wire('pos', [af, 'out'], [startBus, b.stud(startBus)], { amps: altA, protect: altFuseR, len: 0.5 });
  b.wire('neg', [alt, 'neg'], [engineNode, 'neg'], { amps: altA, len: 2, engine: true, gauge: b.wires[b.wires.length - 2].gauge });
  // (the request is held to 100 A, so the list always has a size for it)
  const dcA = b.rating(Math.min(altA * 0.6, V === 12 ? 100 : 50), [18, 30, 50, 100], { what: `${who}DC-DC charger${tag} (start → house)`, nodes: [`alt-dcdc${sfx}`] });
  const dcdc = b.add('dcdc', `alt-dcdc${sfx}`, `DC-DC charger${tag} (start → house)`, { zone: BZ, sublabel: `${dcA} A lithium profile`, data: { rating: dcA, part: `DC-DC charger ${V}/${V}-${dcA}, isolated` }, notes: ['dcdc', 'alternator-lfp'] });
  const inA = dcA * 1.15;
  const inR = b.protection(inA, { what: `${who}DC-DC${tag} input fuse`, nodes: [`dcdc-in-fuse${sfx}`] });
  const outR = b.protection(dcA, { what: `${who}DC-DC${tag} output fuse`, nodes: [`dcdc-out-fuse${sfx}`] });
  const fIn = b.add('fuse', `dcdc-in-fuse${sfx}`, `DC-DC${tag} input fuse`, { zone: startBus.zone, col: 5, sublabel: fuseLabel(inR, 'MIDI'), data: { rating: inR, fuseClass: 'MIDI' }, notes: ['charging-source-fuse'] });
  const fOut = b.add('fuse', `dcdc-out-fuse${sfx}`, `DC-DC${tag} output fuse`, { zone: BZ, sublabel: fuseLabel(outR, 'MIDI'), data: { rating: outR, fuseClass: 'MIDI' }, notes: ['charging-source-fuse'] });
  b.wire('pos', [startBus, b.stud(startBus)], [fIn, 'in'], { amps: inA, protect: inR, len: 0.5 });
  b.pair([[fIn, 'out'], [dcdc, 'in']], [[negBus, b.stud(negBus)], [dcdc, 'inneg']], { amps: inA, protect: inR, len: 2, protectedBy: fIn.id });
  b.pair([[dcdc, 'out'], [fOut, 'in']], [[dcdc, 'outneg'], [negBus, b.stud(negBus)]], { amps: dcA, protect: outR, len: 2, protectedBy: fOut.id });
  b.wire('pos', [fOut, 'out'], [posBus, b.stud(posBus)], { amps: dcA, protect: outR, len: 0.5 });
  b.wire('sig', [engineNode, 'run'], [dcdc, 'run'], { amps: 0, len: crankLen });
}

/** Alternator → isolator → each bank through its own fuse (the banks are never bridged). */
function alternatorThroughIsolator(b: Builder, p: Plan, core: Core, a: Alt, startBus: DNode) {
  const { BZ } = p;
  const { posBus, negBus } = core;
  const { engine, alt, altA, altFuseR, altFuseCls, altLen, split, extReg, sfx, tag, who } = a;

  const diode = split === 'isolator-diode';
  const isoR = b.rating(altA * 1.25, [70, 120, 160, 200, 250, 350], {
    what: `${who}${diode ? 'Diode' : 'FET'} battery isolator${tag}`,
    carries: altA,
    fix: 'Open the engine and set "Charge splitting" to Automatic, which uses a charging relay instead of an isolator.',
    nodes: [`alt-isolator${sfx}`],
  });
  const iso = b.add('isolator', `alt-isolator${sfx}`, `${diode ? 'Diode' : 'FET'} battery isolator${tag}`, {
    zone: BZ,
    sublabel: `${isoR} A · ${diode ? '~0.7 V drop' : 'near-zero drop'}`,
    data: { rating: isoR, isolatorType: diode ? 'diode' : 'fet', part: `${diode ? 'Diode' : 'MOSFET (zero-drop)'} battery isolator, 1 input / 2 outputs, ${isoR} A${diode ? ', with excitation (E) terminal' : ''}` },
    notes: ['isolator', 'charging-source-fuse'],
  });
  // A diode isolator drops ~0.7 V, so a stock regulator must see battery voltage, not its own output.
  // (An external regulator already senses at the house bus, below.)
  const comp = String(engine.props.isolatorSense ?? 'excite');
  if (diode && !extReg && comp !== 'none') {
    iso.data.compensation = comp === 'sense' ? 'sense' : 'excite';
    if (comp === 'sense') {
      alt.terminals.push({ id: 'sense', pol: 'sig', side: 'N', label: 'S' });
      b.wire('sig', [alt, 'sense'], [posBus, b.stud(posBus, { pol: 'sig', label: 'sense' })], { amps: 0, len: altLen, notes: ['isolator-compensation'] });
    } else {
      alt.terminals.push({ id: 'exc', pol: 'sig', side: 'N', label: 'EXC' });
      iso.terminals.push({ id: 'exc', pol: 'sig', side: 'N', label: 'E' });
      b.wire('sig', [iso, 'exc'], [alt, 'exc'], { amps: 0, len: altLen, notes: ['isolator-compensation'] });
    }
    iso.notes = [...(iso.notes ?? []), 'isolator-compensation'];
  }
  const [aw] = b.pair([[alt, 'b'], [iso, 'in']], [[alt, 'neg'], [negBus, b.stud(negBus)]], { amps: altA, protect: altFuseR, len: altLen, engine: true, notes: ['isolator'] });
  const outs: [string, DNode, string][] = [['out1', posBus, 'house'], ['out2', startBus, 'start']];
  for (const [term, bus, which] of outs) {
    const f = b.add('fuse', `iso-fuse-${which}${sfx}`, `Isolator${tag} fuse (${which} side)`, { zone: bus.zone, col: 5, sublabel: fuseLabel(altFuseR, altFuseCls), data: { rating: altFuseR, fuseClass: altFuseCls }, notes: ['charging-source-fuse'] });
    b.wire('pos', [iso, term], [f, 'in'], { amps: altA, protect: altFuseR, len: 1.5, gauge: aw.gauge, protectedBy: f.id });
    b.wire('pos', [f, 'out'], [bus, b.stud(bus)], { amps: altA, protect: altFuseR, len: 0.5, gauge: aw.gauge });
  }
  b.wire('neg', [iso, 'neg'], [negBus, b.stud(negBus)], { amps: 1, len: 1.5, gauge: '16' });
}

/** Alternator → house bus directly, through a fuse at the bus end. */
function alternatorToHouse(b: Builder, p: Plan, core: Core, a: Alt) {
  const { BZ } = p;
  const { posBus, negBus } = core;
  const { alt, altA, altFuseR, altFuseCls, altLen, sfx, tag } = a;

  const af = b.add('fuse', `alt-fuse${sfx}`, `Alternator${tag} output fuse`, { zone: BZ, sublabel: fuseLabel(altFuseR, altFuseCls), data: { rating: altFuseR, fuseClass: altFuseCls }, notes: ['charging-source-fuse'] });
  const [aw] = b.pair([[alt, 'b'], [af, 'in']], [[alt, 'neg'], [negBus, b.stud(negBus)]], { amps: altA, protect: altFuseR, len: altLen, engine: true, protectedBy: af.id, notes: ['charging-source-fuse'] });
  b.wire('pos', [af, 'out'], [posBus, b.stud(posBus)], { amps: altA, protect: altFuseR, len: 0.5, gauge: aw.gauge });
}

/** External regulator: required (with an alternator protection device) when the alternator charges lithium, optional otherwise. */
function alternatorRegulation(b: Builder, p: Plan, core: Core, a: Alt) {
  const { lfp } = p;
  const { posBus, bms } = core;
  const { alt, altLen, extReg, EZ, startBus, sfx, tag, who } = a;

  if (lfp) {
    const reg = b.add('regulator', `alt-reg${sfx}`, `Smart alternator regulator${tag}`, { zone: EZ, sublabel: 'Lithium profile, belt/temperature limiting', data: { part: 'External regulator (e.g. Wakespeed WS500 / Balmar MC-618)' }, notes: ['alternator-lfp'] });
    b.wire('sig', [reg, 'field'], [alt, 'field'], { amps: 0, len: 2 });
    b.wire('sig', [reg, 'sense'], [posBus, b.stud(posBus, { pol: 'sig', label: 'sense' })], { amps: 0, len: altLen });
    alternatorProtection(b, a, 'alternator-lfp');
    if (bms) b.wire('sig', [bms, 'atc'], [reg, 'atc'], { amps: 0, len: altLen });
    if (!extReg && startBus) b.find('error', 'alternator-lfp', `${who}Lithium house bank and lithium start battery with a stock regulator: there is no lead-acid battery the alternator can charge directly.`, 'Make the start battery lead-acid (alternator → start, DC-DC → house) or fit an external regulator.');
    else if (!extReg) b.find('error', 'alternator-lfp', `${who}Lithium house bank with the alternator wired to it but no start battery and a stock regulator.`, 'Add a lead-acid start battery (alternator → start, DC-DC → house) or fit an external regulator.');
  } else if (extReg) {
    const reg = b.add('regulator', `alt-reg${sfx}`, `Smart alternator regulator${tag}`, { zone: EZ, sublabel: 'Multi-stage', data: { part: 'External regulator' } });
    b.wire('sig', [reg, 'field'], [alt, 'field'], { amps: 0, len: 2 });
    b.wire('sig', [reg, 'sense'], [posBus, b.stud(posBus, { pol: 'sig', label: 'sense' })], { amps: 0, len: altLen });
  }
}

/**
 * Keeps the start battery charged from the house side: a DC-DC charger set to the start battery's
 * profile when either battery is lithium, otherwise a charging relay. One per start battery: when
 * both engines share it, the first engine that needs it draws it.
 */
function chargeStartFromHouse(b: Builder, p: Plan, core: Core, a: Alt, startBus: DNode) {
  const { V, BZ } = p;
  const { posBus, negBus } = core;
  const { engine, altA, engineNode, crankLen, needsDcdc, startChem, who } = a;
  const st = a.start!;
  if (st.fedFromHouse) return;
  st.fedFromHouse = true;
  const { sfx, tag } = st;

  if (needsDcdc) {
    // A start battery needs little charge. Take the larger charger only if the alternator covers what it draws.
    const sizes = START_DCDC_SIZES[V];
    const fits = sizes.filter((s) => s * DCDC_INPUT_FACTOR <= altA);
    const dcA = fits.length ? fits[fits.length - 1] : sizes[0];
    if (!fits.length) {
      // (The owner enters the alternator's rating at 12 V; altA is its output at the system voltage.)
      const entered = V === 12 ? '' : ` at ${V} V (the ${num(engine, 'alternatorAmps')} A entered is at 12 V)`;
      b.find('info', 'dcdc', `${who}The alternator makes about ${Math.round(altA)} A${entered}, less than the ${Math.round(dcA * DCDC_INPUT_FACTOR)} A the start battery's DC-DC charger draws at full output, so the house bank makes up the difference while the engine runs.`, 'If the charger lets you set its current limit, set it below the alternator\'s output.');
    }
    const profile = profileOf(startChem);
    const dcdc = b.add('dcdc', `start-dcdc${sfx}`, `DC-DC charger (house → start${tag})`, { zone: BZ, sublabel: `${dcA} A${profile ? ` ${profile} profile` : ''}`, data: { rating: dcA, part: `DC-DC charger ${V}/${V}-${dcA}${profile ? `, ${profile} profile` : ''}` }, notes: ['dcdc'] });
    const r = b.protection(dcA * DCDC_INPUT_FACTOR, { what: `${st.who}DC-DC charger${tag} fuse (each side)`, nodes: [`start-dcdc-in${sfx}`, `start-dcdc-out${sfx}`] });
    const f1 = b.add('fuse', `start-dcdc-in${sfx}`, `DC-DC${tag} input fuse`, { zone: BZ, col: 5, sublabel: fuseLabel(r, 'ATC'), data: { rating: r, fuseClass: fuseClassFor(r, {}) }, notes: ['charging-source-fuse'] });
    const f2 = b.add('fuse', `start-dcdc-out${sfx}`, `DC-DC${tag} output fuse`, { zone: startBus.zone, sublabel: fuseLabel(r, 'ATC'), data: { rating: r, fuseClass: fuseClassFor(r, {}) }, notes: ['charging-source-fuse'] });
    b.wire('pos', [posBus, b.stud(posBus)], [f1, 'in'], { amps: dcA, protect: r, len: 0.5 });
    b.pair([[f1, 'out'], [dcdc, 'in']], [[negBus, b.stud(negBus)], [dcdc, 'inneg']], { amps: dcA, protect: r, len: 2, protectedBy: f1.id });
    b.pair([[dcdc, 'out'], [f2, 'in']], [[dcdc, 'outneg'], [negBus, b.stud(negBus)]], { amps: dcA, protect: r, len: 2, protectedBy: f2.id });
    b.wire('pos', [f2, 'out'], [startBus, b.stud(startBus)], { amps: dcA, protect: r, len: 0.5 });
  } else {
    // The relay carries the alternator's charge on to the house bank. A start battery both engines
    // share gets one relay, sized for the larger alternator charging through it. It is always
    // voltage-sensing: joining two engines' D+ lines to one relay coil would feed one alternator's
    // excitation into the other.
    const users = st.relayFor;
    const relayA = Math.max(...users.map((u) => u.altA));
    const runRelay = a.wantsRunRelay && !st.shared;
    if (st.shared && users.some((u) => u.wantsRunRelay)) {
      b.find('info', 'twin-engines', `Both engines share ${st.bank.name}, so one voltage-sensing charging relay is used: it closes when either engine is charging.`, undefined, [`acr${sfx}`]);
    }
    const acrR = relayA > 100 ? b.rating(relayA, [500], { what: `${st.who}${runRelay ? 'Charging relay' : 'Automatic charging relay'}${tag}`, fix: ALT_FIX, nodes: [`acr${sfx}`] }) : 120;
    const acr = runRelay
      ? b.add('acr', `acr${sfx}`, `Charging relay${tag} (engine-run)`, {
          zone: BZ,
          sublabel: `${acrR} A · closes on D+`,
          data: { rating: acrR, trigger: 'engine-run', part: `Split-charge relay, continuous duty, ${acrR} A, D+/ignition triggered` },
          notes: ['charge-relay'],
        })
      : b.add('acr', `acr${sfx}`, `Automatic charging relay${tag}`, { zone: BZ, sublabel: `${acrR} A`, data: { rating: acrR, part: `ACR / VSR ${acrR} A` }, notes: ['acr', ...(st.shared ? ['twin-engines'] : [])] });
    if (runRelay) {
      // coil is energised by the alternator's D+ / engine-run signal, so the banks join only while charging
      acr.terminals.push({ id: 'trig', pol: 'sig', side: 'N', label: 'D+' });
      b.wire('sig', [engineNode, 'run'], [acr, 'trig'], { amps: 0, len: crankLen });
    }
    const relay = runRelay ? 'Relay' : 'ACR';
    const fr = b.protection(relayA, { what: `${st.who}${relay}${tag} fuse (each side)`, fix: ALT_FIX, nodes: [`acr-fuse-house${sfx}`, `acr-fuse-start${sfx}`] }, 'feeder-fuse');
    const cls = fuseClassFor(fr, { mainFeeder: true });
    const fa = b.add('fuse', `acr-fuse-house${sfx}`, `${relay}${tag} fuse (house side)`, { zone: BZ, col: 5, sublabel: fuseLabel(fr, cls), data: { rating: fr, fuseClass: cls }, notes: ['battery-fuse'] });
    const fb = b.add('fuse', `acr-fuse-start${sfx}`, `${relay}${tag} fuse (start side)`, { zone: startBus.zone, sublabel: fuseLabel(fr, cls), data: { rating: fr, fuseClass: cls }, notes: ['battery-fuse'] });
    const o = { amps: relayA, protect: fr, len: 1.5 };
    b.wire('pos', [posBus, b.stud(posBus)], [fa, 'in'], { ...o, len: 0.5 });
    b.wire('pos', [fa, 'out'], [acr, 'a'], { ...o, protectedBy: fa.id });
    b.wire('pos', [acr, 'b'], [fb, 'in'], { ...o, protectedBy: fb.id });
    b.wire('pos', [fb, 'out'], [startBus, b.stud(startBus)], { ...o, len: 0.5 });
    b.wire('neg', [acr, 'neg'], [negBus, b.stud(negBus)], { amps: 1, len: 1.5, gauge: '16' });
  }
}
