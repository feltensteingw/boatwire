// Charging from the sun, wind and water: panels and MPPT controllers, wind and hydro generators
// with their diversion (dump-load) controllers.

import { VDROP } from '../../model/standards';
import { fuseClassFor } from '../calc';
import { num } from '../energy';
import { fuseLabel, MPPT_SIZES, type Builder } from './builder';
import type { Core } from './houseBank';
import type { Plan } from './plan';

export function buildSolar(b: Builder, p: Plan, core: Core) {
  const { V, BZ, run, solars } = p;
  const { posBus, negBus, bms } = core;

  solars.forEach((e) => {
    const W = num(e, 'watts');
    const vmp = num(e, 'arrayVmp', 36);
    const imp = W / vmp;
    const isc = imp * 1.1;
    const outA = W / (V * 1.18);
    const ctrl = b.rating(outA, MPPT_SIZES, {
      what: `MPPT controller for ${e.name}`,
      limitsItself: true,
      fix: `Split the array between two controllers${V === 12 ? ', or use 24 V, which halves the current' : ''}.`,
      nodes: [`mppt-${e.id}`],
    });
    const pvR = b.rating(isc * 1.56, [10, 15, 16, 20, 25, 32, 40, 50, 63], {
      what: `PV disconnect for ${e.name}`,
      carries: isc,
      fix: 'Wire more of the panels in series (higher voltage, less current), or split the array into two strings, each with its own disconnect and controller.',
      nodes: [`pvbrk-${e.id}`],
    });
    const panel = b.add('solar-panel', `pv-${e.id}`, e.name, { zone: e.zone, equipmentId: e.id, sublabel: `${W} W · Vmp ${vmp} V`, data: { watts: W, amps: imp } });
    const brk = b.add('breaker', `pvbrk-${e.id}`, 'PV disconnect', { zone: BZ, col: 1, sublabel: `${pvR} A DC breaker`, data: { rating: pvR, part: `PV DC breaker ${pvR} A` }, notes: ['mppt'] });
    const mppt = b.add('mppt', `mppt-${e.id}`, 'MPPT controller', { zone: BZ, sublabel: `${Math.round(vmp * 2.8 / 50) * 50 || 100}/${ctrl}`, equipmentId: e.id, data: { rating: ctrl, amps: outA, part: `MPPT ${ctrl} A` }, notes: ['mppt'] });
    const fr = b.protection(ctrl, { what: 'MPPT output fuse', nodes: [`pvfuse-${e.id}`] });
    const f = b.add('fuse', `pvfuse-${e.id}`, 'MPPT output fuse', { zone: BZ, sublabel: fuseLabel(fr, fuseClassFor(fr, {})), data: { rating: fr, fuseClass: fuseClassFor(fr, {}) }, notes: ['charging-source-fuse'] });
    const len = run(e.zone, BZ);
    const [pw] = b.pair([[panel, 'pos'], [brk, 'in']], [[panel, 'neg'], [mppt, 'pvneg']], { amps: imp, protect: pvR, len, volts: vmp, limit: VDROP.critical, notes: ['conductor-sizing'] });
    b.wire('pos', [brk, 'out'], [mppt, 'pvpos'], { amps: imp, protect: pvR, len: 1, volts: vmp, gauge: pw.gauge, protectedBy: brk.id });
    b.pair([[mppt, 'bat'], [f, 'in']], [[mppt, 'batneg'], [negBus, b.stud(negBus)]], { amps: ctrl, protect: fr, len: 2, protectedBy: f.id, notes: ['charging-source-fuse'] });
    b.wire('pos', [f, 'out'], [posBus, b.stud(posBus)], { amps: ctrl, protect: fr, len: 0.5 });
    if (bms) b.wire('sig', [bms, 'atc'], [mppt, 'atc'], { amps: 0, len: 2 });
  });
}

export function buildWindHydro(b: Builder, p: Plan, core: Core) {
  const { V, BZ, run, winds } = p;
  const { posBus, negBus } = core;

  winds.forEach((e) => {
    const W = num(e, 'watts');
    const A = W / V;
    const isWind = e.kind === 'wind';
    const gen = b.add(isWind ? 'wind-gen' : 'hydro-gen', `gen-${e.id}`, e.name, { zone: e.zone, equipmentId: e.id, sublabel: `${W} W`, data: { watts: W, amps: A } });
    const ctl = b.add('controller', `ctl-${e.id}`, `${isWind ? 'Wind' : 'Hydro'} controller`, { zone: BZ, sublabel: 'with dump-load diversion', data: { rating: Math.ceil(A) }, notes: ['dump-load'] });
    const fr = b.protection(A, { what: `${isWind ? 'Wind' : 'Hydro'} output fuse`, nodes: [`ctlfuse-${e.id}`] });
    const f = b.add('fuse', `ctlfuse-${e.id}`, `${isWind ? 'Wind' : 'Hydro'} output fuse`, { zone: BZ, sublabel: fuseLabel(fr, fuseClassFor(fr, {})), data: { rating: fr, fuseClass: fuseClassFor(fr, {}) }, notes: ['charging-source-fuse'] });
    const dump = b.add('dump-load', `dump-${e.id}`, 'Dump load', { zone: BZ, sublabel: `${W} W resistor`, notes: ['dump-load'] });
    b.pair([[gen, 'pos'], [ctl, 'in']], [[gen, 'neg'], [ctl, 'inneg']], { amps: A, protect: A, len: run(e.zone, BZ), limit: VDROP.critical });
    b.pair([[ctl, 'bat'], [f, 'in']], [[ctl, 'batneg'], [negBus, b.stud(negBus)]], { amps: A, protect: fr, len: 2, protectedBy: f.id });
    b.wire('pos', [f, 'out'], [posBus, b.stud(posBus)], { amps: A, protect: fr, len: 0.5 });
    b.pair([[ctl, 'dump'], [dump, 'pos']], [[dump, 'neg'], [negBus, b.stud(negBus)]], { amps: A, protect: A, len: 2 });
  });
}
