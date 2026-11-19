// Engine: the starter circuit, the alternator, and how its charge is shared between the start
// battery and the house bank (charging relay, battery isolator, or DC-DC charger for lithium).

import type { Chemistry, DNode, Equipment } from '../../model/types';
import { fuseClassFor, nextStandard, protectionFor } from '../calc';
import { num } from '../energy';
import { bankSummary, fuseLabel, type Builder, type WOpts } from './builder';
import type { Core } from './houseBank';
import type { Plan } from './plan';

/** The charge profile a DC-DC charger is set to, named for the battery it charges. */
const PROFILE: Record<Chemistry, string> = { flooded: 'flooded', agm: 'AGM', gel: 'gel', lifepo4: 'lithium' };

/** The engine as drawn, for the alternator wiring that hangs off it. */
interface EngineInfo {
  engine: Equipment;
  engineNode: DNode;
  /** Positive bus of the start battery, if the boat has one. */
  startBus?: DNode;
  /** Chemistry of the start battery, if the boat has one. */
  startChem?: Chemistry;
  /** Alternator output at the system voltage. */
  altA: number;
  /** An external (smart) regulator is fitted. */
  extReg: boolean;
  /** Zone of the engine. */
  EZ: string;
  /** Cable run from the batteries to the engine. */
  crankLen: number;
}

/** The alternator and what was decided about it, shared by the wiring arrangements below. */
interface Alt extends EngineInfo {
  alt: DNode;
  altFuseR: number;
  altFuseCls: ReturnType<typeof fuseClassFor>;
  /** Cable run from the alternator to the batteries. */
  altLen: number;
  /** The charge-splitting arrangement the user chose for the engine. */
  split: string;
  wantsRunRelay: boolean;
  /**
   * One of the two batteries is lithium, so they are kept apart by a DC-DC charger: a relay or
   * isolator would parallel lithium with lead-acid, or give lithium the alternator's charge voltage.
   */
  needsDcdc: boolean;
}

/** Engine, starter circuit and alternator charging. Returns the start battery's bus, if there is one. */
export function buildEngine(b: Builder, p: Plan, core: Core): { startBus?: DNode } {
  const { engine, startBank, V, BZ, run, scale, lfp } = p;
  const { posBus, negBus } = core;
  if (!engine) return {};
  let startBus: DNode | undefined;

  const starterA = num(engine, 'starterAmps', 150) * scale;
  const altA = num(engine, 'alternatorAmps', 0) * scale;
  const extReg = engine.props.regulator === 'external';
  const EZ = engine.zone || BZ;
  const engineNode = b.add('engine', 'engine', engine.name, {
    zone: EZ,
    equipmentId: engine.id,
    sublabel: `Starter ~${Math.round(starterA)} A`,
    data: { amps: starterA, kind: 'engine', glyph: 'ENG' },
    notes: ['starter-exempt', 'common-negative'],
  });
  const crankLen = run(BZ, EZ);
  let startChem: Chemistry | undefined;
  if (startBank) {
    const s = bankSummary(startBank, V);
    startChem = s.chem;
    const sbat = b.add('battery', 'start-bat', startBank.name, { zone: startBank.zone || BZ, equipmentId: startBank.id, sublabel: s.text, data: { chemistry: s.chem, ah: s.ah, volts: V }, notes: ['house-start-split'] });
    const sfRating = nextStandard(starterA * 2, [100, 150, 200, 250, 300]);
    const sfClass = fuseClassFor(sfRating, { atBattery: true, lithium: s.chem === 'lifepo4' });
    const sfuse = b.add('fuse', 'start-fuse', 'Start battery fuse', { zone: sbat.zone, sublabel: fuseLabel(sfRating, sfClass), data: { rating: sfRating, fuseClass: sfClass }, notes: ['battery-fuse', 'starter-exempt', ...(sfClass === 'Class T' ? ['class-t'] : [])] });
    const ssw = b.add('switch', 'start-switch', 'Start battery switch', { zone: sbat.zone, data: { rating: 300 }, notes: ['battery-switch'] });
    startBus = b.add('bus-pos', 'start-bus', 'Start positive bus', { zone: sbat.zone });
    const so: WOpts = { amps: starterA, protect: starterA, len: 0.5, vdLen: crankLen + 3, notes: ['starter-exempt'] };
    const w1 = b.wire('pos', [sbat, 'pos'], [sfuse, 'in'], so);
    b.wire('pos', [sfuse, 'out'], [ssw, 'in'], { ...so, len: 1, gauge: w1.gauge, protectedBy: sfuse.id });
    b.wire('pos', [ssw, 'out'], [startBus, b.stud(startBus)], { ...so, len: 1.5, gauge: w1.gauge, protectedBy: sfuse.id });
    b.wire('pos', [startBus, b.stud(startBus)], [engineNode, 'pos'], { ...so, len: crankLen, gauge: w1.gauge, engine: true, protectedBy: sfuse.id });
    b.wire('neg', [sbat, 'neg'], [engineNode, 'neg'], { ...so, len: crankLen, gauge: w1.gauge, notes: ['common-negative'] });
    if (s.chem === 'lifepo4') b.find('warning', 'alternator-lfp', 'Lithium start battery: most designs keep the start battery lead-acid so the alternator always has a battery it cannot be disconnected from.');
  } else {
    const esw = b.add('switch', 'engine-switch', 'Engine start switch', { zone: BZ, data: { rating: 300 }, notes: ['battery-switch'] });
    const so: WOpts = { amps: starterA, protect: starterA, len: 0.5, vdLen: crankLen + 3, notes: ['starter-exempt'] };
    const w1 = b.wire('pos', [posBus, b.stud(posBus)], [esw, 'in'], so);
    b.wire('pos', [esw, 'out'], [engineNode, 'pos'], { ...so, len: crankLen, gauge: w1.gauge, engine: true });
    b.find(lfp ? 'warning' : 'info', 'house-start-split', 'No dedicated start battery: the engine starts from the house bank.', 'Add a start battery (role "Engine start") so a flat house bank can never stop you starting the engine.');
  }
  // engine block to main negative bus (common ground)
  const engNegGauge = b.wires.filter((w) => w.to.node === 'engine' || w.from.node === 'engine').map((w) => w.gauge)[0];
  b.wire('neg', [engineNode, 'neg'], [negBus, b.stud(negBus)], { amps: Math.max(altA, starterA), len: crankLen, gauge: engNegGauge, engine: true, notes: ['common-negative'] });

  if (altA > 0) buildAlternator(b, p, core, { engine, engineNode, startBus, startChem, altA, extReg, EZ, crankLen });
  return { startBus };
}

function buildAlternator(b: Builder, p: Plan, core: Core, e: EngineInfo) {
  const { BZ, run, lfp } = p;
  const { engine, startBus, startChem, altA, extReg, EZ } = e;

  const alt = b.add('alternator', 'alternator', 'Alternator', { zone: EZ, sublabel: `${Math.round(altA)} A${extReg ? ' · ext. reg.' : ''}`, data: { amps: altA, part: `${num(engine, 'alternatorAmps')} A alternator` } });
  const altFuseR = protectionFor(altA);
  const altFuseCls = fuseClassFor(altFuseR, { lithium: lfp, mainFeeder: true });
  const altLen = run(EZ, BZ);
  const split = String(engine.props.chargeSplit ?? 'auto');
  const needsDcdc = lfp || startChem === 'lifepo4';
  // Lithium house, stock regulator: the alternator charges the lead-acid start battery instead.
  // (A lithium start battery is no better, so then the design asks for an external regulator.)
  const toStart = lfp && !extReg && !!startBus && startChem !== 'lifepo4';
  const wantsIso = split === 'isolator-fet' || split === 'isolator-diode';
  const useIso = wantsIso && !needsDcdc && !!startBus;
  const wantsRunRelay = split === 'relay-run';

  // A relay or isolator the owner chose but the design cannot use: say what it uses instead.
  const [lithium, other] = lfp ? ['the lithium house bank', 'the start battery'] : ['the lithium start battery', 'the house bank'];
  const instead = toStart || !lfp ? 'The design uses a DC-DC charger instead.' : 'The design uses an external regulator and alternator protection instead.';
  if (wantsRunRelay && needsDcdc) {
    b.find('info', 'charge-relay', `Charge splitting is set to an engine-run charging relay, but a relay would parallel ${lithium} with ${other} while the engine runs.`, instead);
  } else if (wantsRunRelay && !startBus) {
    b.find('info', 'charge-relay', 'Charge splitting is set to a charging relay, but there is only one battery bank, so no relay is needed.');
  } else if (split === 'acr' && needsDcdc && startBus) {
    b.find('info', 'acr', `Charge splitting is set to an ACR, but an ACR would parallel ${lithium} with ${other} whenever either is being charged.`, instead);
  }
  if (wantsIso && needsDcdc) {
    b.find('info', 'isolator', `Charge splitting is set to a battery isolator, but an isolator cannot give ${lithium} its own charge profile or protect the alternator from a BMS disconnect.`, instead);
  } else if (wantsIso && !startBus) {
    b.find('info', 'isolator', 'Charge splitting is set to a battery isolator, but there is only one battery bank, so no isolator is needed.');
  }

  const a: Alt = { ...e, alt, altFuseR, altFuseCls, altLen, split, wantsRunRelay, needsDcdc };
  if (toStart && startBus) {
    alternatorToStartBattery(b, p, core, a, startBus);
    return;
  }
  if (useIso && startBus) alternatorThroughIsolator(b, p, core, a, startBus);
  else alternatorToHouse(b, p, core, a);
  alternatorRegulation(b, p, core, a);
  // (not needed when an isolator feeds both banks)
  if (startBus && !useIso) chargeStartFromHouse(b, p, core, a, startBus);
}

/** Lithium house, lead-acid start battery, stock regulator: the alternator charges the start battery, and a DC-DC charger carries the charge on to the house bank. */
function alternatorToStartBattery(b: Builder, p: Plan, core: Core, a: Alt, startBus: DNode) {
  const { V, BZ } = p;
  const { posBus, negBus } = core;
  const { alt, altA, altFuseR, altFuseCls, altLen, engineNode, crankLen } = a;

  const af = b.add('fuse', 'alt-fuse', 'Alternator output fuse', { zone: startBus.zone, sublabel: fuseLabel(altFuseR, altFuseCls), data: { rating: altFuseR, fuseClass: altFuseCls }, notes: ['charging-source-fuse'] });
  b.wire('pos', [alt, 'b'], [af, 'in'], { amps: altA, protect: altFuseR, len: altLen, engine: true, protectedBy: af.id, notes: ['alternator-lfp'] });
  b.wire('pos', [af, 'out'], [startBus, b.stud(startBus)], { amps: altA, protect: altFuseR, len: 0.5 });
  b.wire('neg', [alt, 'neg'], [engineNode, 'neg'], { amps: altA, len: 2, engine: true, gauge: b.wires[b.wires.length - 2].gauge });
  const dcA = nextStandard(Math.min(altA * 0.6, V === 12 ? 100 : 50), [18, 30, 50, 100]);
  const dcdc = b.add('dcdc', 'alt-dcdc', 'DC-DC charger (start → house)', { zone: BZ, sublabel: `${dcA} A lithium profile`, data: { rating: dcA, part: `DC-DC charger ${V}/${V}-${dcA}, isolated` }, notes: ['dcdc', 'alternator-lfp'] });
  const inA = dcA * 1.15;
  const fIn = b.add('fuse', 'dcdc-in-fuse', 'DC-DC input fuse', { zone: startBus.zone, col: 5, sublabel: fuseLabel(protectionFor(inA), 'MIDI'), data: { rating: protectionFor(inA), fuseClass: 'MIDI' }, notes: ['charging-source-fuse'] });
  const fOut = b.add('fuse', 'dcdc-out-fuse', 'DC-DC output fuse', { zone: BZ, sublabel: fuseLabel(protectionFor(dcA), 'MIDI'), data: { rating: protectionFor(dcA), fuseClass: 'MIDI' }, notes: ['charging-source-fuse'] });
  b.wire('pos', [startBus, b.stud(startBus)], [fIn, 'in'], { amps: inA, protect: protectionFor(inA), len: 0.5 });
  b.pair([[fIn, 'out'], [dcdc, 'in']], [[negBus, b.stud(negBus)], [dcdc, 'inneg']], { amps: inA, protect: protectionFor(inA), len: 2, protectedBy: fIn.id });
  b.pair([[dcdc, 'out'], [fOut, 'in']], [[dcdc, 'outneg'], [negBus, b.stud(negBus)]], { amps: dcA, protect: protectionFor(dcA), len: 2, protectedBy: fOut.id });
  b.wire('pos', [fOut, 'out'], [posBus, b.stud(posBus)], { amps: dcA, protect: protectionFor(dcA), len: 0.5 });
  b.wire('sig', [engineNode, 'run'], [dcdc, 'run'], { amps: 0, len: crankLen });
}

/** Alternator → isolator → each bank through its own fuse (the banks are never bridged). */
function alternatorThroughIsolator(b: Builder, p: Plan, core: Core, a: Alt, startBus: DNode) {
  const { BZ } = p;
  const { posBus, negBus } = core;
  const { engine, alt, altA, altFuseR, altFuseCls, altLen, split, extReg } = a;

  const diode = split === 'isolator-diode';
  const isoR = nextStandard(altA * 1.25, [70, 120, 160, 200, 250, 350]);
  const iso = b.add('isolator', 'alt-isolator', diode ? 'Diode battery isolator' : 'FET battery isolator', {
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
    const f = b.add('fuse', `iso-fuse-${which}`, `Isolator fuse (${which} side)`, { zone: bus.zone, col: 5, sublabel: fuseLabel(altFuseR, altFuseCls), data: { rating: altFuseR, fuseClass: altFuseCls }, notes: ['charging-source-fuse'] });
    b.wire('pos', [iso, term], [f, 'in'], { amps: altA, protect: altFuseR, len: 1.5, gauge: aw.gauge, protectedBy: f.id });
    b.wire('pos', [f, 'out'], [bus, b.stud(bus)], { amps: altA, protect: altFuseR, len: 0.5, gauge: aw.gauge });
  }
  b.wire('neg', [iso, 'neg'], [negBus, b.stud(negBus)], { amps: 1, len: 1.5, gauge: '16' });
}

/** Alternator → house bus directly, through a fuse at the bus end. */
function alternatorToHouse(b: Builder, p: Plan, core: Core, a: Alt) {
  const { BZ } = p;
  const { posBus, negBus } = core;
  const { alt, altA, altFuseR, altFuseCls, altLen } = a;

  const af = b.add('fuse', 'alt-fuse', 'Alternator output fuse', { zone: BZ, sublabel: fuseLabel(altFuseR, altFuseCls), data: { rating: altFuseR, fuseClass: altFuseCls }, notes: ['charging-source-fuse'] });
  const [aw] = b.pair([[alt, 'b'], [af, 'in']], [[alt, 'neg'], [negBus, b.stud(negBus)]], { amps: altA, protect: altFuseR, len: altLen, engine: true, protectedBy: af.id, notes: ['charging-source-fuse'] });
  b.wire('pos', [af, 'out'], [posBus, b.stud(posBus)], { amps: altA, protect: altFuseR, len: 0.5, gauge: aw.gauge });
}

/** External regulator: required (with an alternator protection device) when the alternator charges lithium, optional otherwise. */
function alternatorRegulation(b: Builder, p: Plan, core: Core, a: Alt) {
  const { lfp } = p;
  const { posBus, bms } = core;
  const { alt, altLen, engineNode, extReg, EZ, startBus } = a;

  if (lfp) {
    const reg = b.add('regulator', 'alt-reg', 'Smart alternator regulator', { zone: EZ, sublabel: 'Lithium profile, belt/temperature limiting', data: { part: 'External regulator (e.g. Wakespeed WS500 / Balmar MC-618)' }, notes: ['alternator-lfp'] });
    const apd = b.add('apd', 'alt-apd', 'Alternator protection device', { zone: EZ, data: { part: 'Alternator protection device (APD)' }, notes: ['alternator-lfp'] });
    b.wire('sig', [reg, 'field'], [alt, 'field'], { amps: 0, len: 2 });
    b.wire('sig', [reg, 'sense'], [posBus, b.stud(posBus, { pol: 'sig', label: 'sense' })], { amps: 0, len: altLen });
    b.wire('pos', [alt, 'b'], [apd, 'b'], { amps: 5, protect: 10, len: 1, gauge: '10', engine: true });
    b.wire('neg', [apd, 'neg'], [engineNode, 'neg'], { amps: 5, len: 1, gauge: '10', engine: true });
    if (bms) b.wire('sig', [bms, 'atc'], [reg, 'atc'], { amps: 0, len: altLen });
    if (!extReg && startBus) b.find('error', 'alternator-lfp', 'Lithium house bank and lithium start battery with a stock regulator: there is no lead-acid battery the alternator can charge directly.', 'Make the start battery lead-acid (alternator → start, DC-DC → house) or fit an external regulator.');
    else if (!extReg) b.find('error', 'alternator-lfp', 'Lithium house bank with the alternator wired to it but no start battery and a stock regulator.', 'Add a lead-acid start battery (alternator → start, DC-DC → house) or fit an external regulator.');
  } else if (extReg) {
    const reg = b.add('regulator', 'alt-reg', 'Smart alternator regulator', { zone: EZ, sublabel: 'Multi-stage', data: { part: 'External regulator' } });
    b.wire('sig', [reg, 'field'], [alt, 'field'], { amps: 0, len: 2 });
    b.wire('sig', [reg, 'sense'], [posBus, b.stud(posBus, { pol: 'sig', label: 'sense' })], { amps: 0, len: altLen });
  }
}

/**
 * Keeps the start battery charged from the house side: a DC-DC charger set to the start battery's
 * profile when either battery is lithium, otherwise a charging relay.
 */
function chargeStartFromHouse(b: Builder, p: Plan, core: Core, a: Alt, startBus: DNode) {
  const { V, BZ } = p;
  const { posBus, negBus } = core;
  const { altA, wantsRunRelay, engineNode, crankLen, needsDcdc, startChem } = a;

  if (needsDcdc) {
    // A start battery needs little charge. Take the larger charger only if the alternator covers what it draws.
    const sizes = V === 12 ? [10, 18] : [12];
    const fits = sizes.filter((s) => s * 1.15 <= altA);
    const dcA = fits.length ? fits[fits.length - 1] : sizes[0];
    if (!fits.length) {
      b.find('info', 'dcdc', `The alternator makes about ${Math.round(altA)} A, less than the ${Math.round(dcA * 1.15)} A the start battery's DC-DC charger draws at full output, so the house bank makes up the difference while the engine runs.`, 'If the charger lets you set its current limit, set it below the alternator\'s output.');
    }
    const profile = PROFILE[startChem ?? 'agm'];
    const dcdc = b.add('dcdc', 'start-dcdc', 'DC-DC charger (house → start)', { zone: BZ, sublabel: `${dcA} A ${profile} profile`, data: { rating: dcA, part: `DC-DC charger ${V}/${V}-${dcA}, ${profile} profile` }, notes: ['dcdc'] });
    const r = protectionFor(dcA * 1.15);
    const f1 = b.add('fuse', 'start-dcdc-in', 'DC-DC input fuse', { zone: BZ, col: 5, sublabel: fuseLabel(r, 'ATC'), data: { rating: r, fuseClass: fuseClassFor(r, {}) }, notes: ['charging-source-fuse'] });
    const f2 = b.add('fuse', 'start-dcdc-out', 'DC-DC output fuse', { zone: startBus.zone, sublabel: fuseLabel(r, 'ATC'), data: { rating: r, fuseClass: fuseClassFor(r, {}) }, notes: ['charging-source-fuse'] });
    b.wire('pos', [posBus, b.stud(posBus)], [f1, 'in'], { amps: dcA, protect: r, len: 0.5 });
    b.pair([[f1, 'out'], [dcdc, 'in']], [[negBus, b.stud(negBus)], [dcdc, 'inneg']], { amps: dcA, protect: r, len: 2, protectedBy: f1.id });
    b.pair([[dcdc, 'out'], [f2, 'in']], [[dcdc, 'outneg'], [negBus, b.stud(negBus)]], { amps: dcA, protect: r, len: 2, protectedBy: f2.id });
    b.wire('pos', [f2, 'out'], [startBus, b.stud(startBus)], { amps: dcA, protect: r, len: 0.5 });
  } else {
    const acrR = altA > 100 ? 500 : 120;
    const acr = wantsRunRelay
      ? b.add('acr', 'acr', 'Charging relay (engine-run)', {
          zone: BZ,
          sublabel: `${acrR} A · closes on D+`,
          data: { rating: acrR, trigger: 'engine-run', part: `Split-charge relay, continuous duty, ${acrR} A, D+/ignition triggered` },
          notes: ['charge-relay'],
        })
      : b.add('acr', 'acr', 'Automatic charging relay', { zone: BZ, sublabel: `${acrR} A`, data: { rating: acrR, part: `ACR / VSR ${acrR} A` }, notes: ['acr'] });
    if (wantsRunRelay) {
      // coil is energised by the alternator's D+ / engine-run signal, so the banks join only while charging
      acr.terminals.push({ id: 'trig', pol: 'sig', side: 'N', label: 'D+' });
      b.wire('sig', [engineNode, 'run'], [acr, 'trig'], { amps: 0, len: crankLen });
    }
    const fr = protectionFor(Math.min(altA, acrR));
    const cls = fuseClassFor(fr, { mainFeeder: true });
    const fa = b.add('fuse', 'acr-fuse-house', `${wantsRunRelay ? 'Relay' : 'ACR'} fuse (house side)`, { zone: BZ, col: 5, sublabel: fuseLabel(fr, cls), data: { rating: fr, fuseClass: cls }, notes: ['battery-fuse'] });
    const fb = b.add('fuse', 'acr-fuse-start', `${wantsRunRelay ? 'Relay' : 'ACR'} fuse (start side)`, { zone: startBus.zone, sublabel: fuseLabel(fr, cls), data: { rating: fr, fuseClass: cls }, notes: ['battery-fuse'] });
    const o = { amps: Math.min(altA, acrR), protect: fr, len: 1.5 };
    b.wire('pos', [posBus, b.stud(posBus)], [fa, 'in'], { ...o, len: 0.5 });
    b.wire('pos', [fa, 'out'], [acr, 'a'], { ...o, protectedBy: fa.id });
    b.wire('pos', [acr, 'b'], [fb, 'in'], { ...o, protectedBy: fb.id });
    b.wire('pos', [fb, 'out'], [startBus, b.stud(startBus)], { ...o, len: 0.5 });
    b.wire('neg', [acr, 'neg'], [negBus, b.stud(negBus)], { amps: 1, len: 1.5, gauge: '16' });
  }
}
