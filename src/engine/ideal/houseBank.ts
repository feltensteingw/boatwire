// House bank: batteries, main fuses, battery switch, the main positive and negative buses, the
// battery monitor shunt and, for lithium with an external BMS, the BMS and its disconnect contactor.

import { FUSE_CLASSES, VDROP } from '../../model/standards';
import type { DNode } from '../../model/types';
import { fuseClassFor, nextStandard, PROTECTION_SIZES } from '../calc';
import { daysText, energyBudget } from '../energy';
import { bankSummary, fuseLabel, SWITCH_SIZES, type Builder } from './builder';
import type { Plan } from './plan';

/** The backbone every other subsystem connects to. */
export interface Core {
  houseSwitch: DNode;
  posBus: DNode;
  negBus: DNode;
  shunt: DNode;
  /** The fuse on the first house battery. Always-on circuits tap off its output. */
  firstMainFuse?: DNode;
  /** Sizing shared by all the main battery cables. */
  mainOpts: { amps: number; protect: number; limit: number; vdLen: number };
  mainCable?: string;
  /** Set when the main cables are several conductors in parallel, e.g. "2× 4/0". */
  mainCableRuns?: string;
  bms?: DNode;
}

/** Main battery fuse sizes, smallest first: the feeder fuses from 100 A, up to the largest Class T. */
const MAIN_FUSE_SIZES = PROTECTION_SIZES['feeder-fuse'].filter((s) => s >= 100);

export function buildHouseBank(b: Builder, p: Plan): Core {
  const { project, scenario, V, BZ, lfp, extBms, house, mainAmps } = p;

  const mainFuse = nextStandard(mainAmps * 1.25, MAIN_FUSE_SIZES);
  const mainFuseRating = mainFuse ?? MAIN_FUSE_SIZES[MAIN_FUSE_SIZES.length - 1];
  const mainFuseClass = fuseClassFor(mainFuseRating, { atBattery: true, lithium: lfp });
  // (sized from the main fuse, so the main fuse error below covers it too)
  const switchRating = b.rating(mainFuseRating, SWITCH_SIZES, { what: 'House battery switch', nodes: ['house-switch'] });
  if (mainFuse === undefined) {
    // The largest fuse is drawn so the diagram is complete. The switch, buses and BMS contactor are
    // rated from it, so the finding points at them too.
    const shown = mainAmps > mainFuseRating ? `The ${mainFuseRating} A fuse, switch and buses shown are too small for that current.` : `The ${mainFuseRating} A fuse shown leaves too little margin.`;
    b.find(
      'error',
      'beyond-sizes',
      `Main DC current (~${Math.round(mainAmps)} A) is beyond practical fuse and switch sizes. ${shown}`,
      'Raise the system voltage or split loads across banks.',
      [...house.map((_, i) => `house${i}-fuse`), 'house-switch', 'pos-bus', 'neg-bus', ...(extBms ? ['house-contactor'] : [])],
    );
  }
  const houseSwitch = b.add('switch', 'house-switch', 'House battery switch', {
    zone: BZ,
    data: { rating: switchRating, part: `Battery switch, ${switchRating} A continuous` },
    notes: ['battery-switch'],
  });
  const posBus = b.add('bus-pos', 'pos-bus', 'Main positive bus', { zone: BZ, data: { rating: switchRating }, notes: ['common-negative'] });
  const negBus = b.add('bus-neg', 'neg-bus', 'Main negative bus', { zone: BZ, data: { rating: switchRating }, notes: ['common-negative'] });
  const shunt = b.add('shunt', 'house-shunt', 'House battery monitor', {
    zone: BZ,
    data: { rating: mainFuseRating > 500 ? 1000 : 500, part: `Shunt ${mainFuseRating > 500 ? 1000 : 500} A + monitor` },
    notes: ['shunt'],
  });
  const mainOpts = { amps: mainAmps, protect: mainFuseRating, limit: VDROP.critical, vdLen: 6 };

  let firstMainFuse: DNode | undefined;
  let houseAhTotal = 0;
  house.forEach((h, i) => {
    const s = bankSummary(h, V);
    houseAhTotal += s.ah;
    if (!s.valid) {
      b.find('error', 'series-parallel', `${h.name}: ${s.units}× ${s.unitV} V batteries can't make a ${V} V bank (need a multiple of ${s.series}).`, `Use ${Math.ceil(s.units / s.series) * s.series} batteries or a different battery voltage.`);
    }
    const bat = b.add('battery', `house${i}-bat`, h.name, {
      zone: h.zone || BZ,
      sublabel: s.text,
      equipmentId: h.id,
      data: { chemistry: s.chem, ah: s.ah, volts: V, bms: lfp ? String(h.props.bms ?? 'internal') : undefined, part: s.text },
      notes: ['series-parallel', ...(lfp ? ['no-mixed-chemistry'] : [])],
    });
    const fuse = b.add('fuse', `house${i}-fuse`, 'House main fuse', {
      zone: bat.zone,
      sublabel: fuseLabel(mainFuseRating, mainFuseClass),
      data: { rating: mainFuseRating, fuseClass: mainFuseClass, part: `${FUSE_CLASSES[mainFuseClass].desc}, ${mainFuseRating} A` },
      notes: ['battery-fuse', ...(mainFuseClass === 'Class T' ? ['class-t'] : [])],
    });
    firstMainFuse ??= fuse;
    b.wire('pos', [bat, 'pos'], [fuse, 'in'], { ...mainOpts, len: 0.5, notes: ['battery-fuse'] });
    b.wire('pos', [fuse, 'out'], [houseSwitch, 'in'], { ...mainOpts, len: 1.5, protectedBy: fuse.id, notes: ['conductor-sizing'] });
    b.wire('neg', [bat, 'neg'], [shunt, 'bat'], { ...mainOpts, len: 1.5, notes: ['shunt', 'negative-same-size'] });
    if (extBms) {
      bat.terminals.push({ id: 'bms', pol: 'sig', side: 'N', label: 'cells' });
    }
  });
  const mainCable = b.wires[0].gauge;
  const mainCableRuns = b.wires[0].cable;

  let bms: DNode | undefined;
  if (extBms) {
    bms = b.add('bms', 'house-bms', 'Lithium BMS', { zone: BZ, notes: ['external-bms'], data: { part: 'External BMS (e.g. Victron Lynx BMS / REC)' } });
    const contactor = b.add('contactor', 'house-contactor', 'BMS disconnect contactor', {
      zone: BZ,
      col: 4,
      data: { rating: switchRating, part: `Latching contactor ${switchRating} A` },
      notes: ['external-bms'],
    });
    b.wire('pos', [houseSwitch, 'out'], [contactor, 'in'], { ...mainOpts, len: 1, protectedBy: firstMainFuse?.id });
    b.wire('pos', [contactor, 'out'], [posBus, b.stud(posBus)], { ...mainOpts, len: 1.5, protectedBy: firstMainFuse?.id });
    b.wire('sig', [bms, 'ctl'], [contactor, 'coil'], { amps: 0, len: 2 });
    house.forEach((_, i) => {
      const bat = b.nodes.find((n) => n.id === `house${i}-bat`)!;
      b.wire('sig', [bat, 'bms'], [bms!, 'cells'], { amps: 0, len: 2 });
    });
  } else {
    b.wire('pos', [houseSwitch, 'out'], [posBus, b.stud(posBus)], { ...mainOpts, len: 2, protectedBy: firstMainFuse?.id });
  }
  b.wire('neg', [shunt, 'sys'], [negBus, b.stud(negBus)], { ...mainOpts, len: 2, gauge: mainCable }).cable = mainCableRuns;

  // Bank sizing check
  const budget = energyBudget(project, scenario);
  if (budget.totalAhPerDay > 0 && houseAhTotal < budget.recommendedAh * 0.9) {
    b.find('warning', 'bank-sizing', `House bank is ${houseAhTotal} Ah; daily use is ~${Math.round(budget.totalAhPerDay)} Ah, which suggests ~${budget.recommendedAh} Ah for ${daysText(budget.daysAutonomy)} at safe depth of discharge.`, 'Increase house capacity or reduce loads.');
  }

  return { houseSwitch, posBus, negBus, shunt, firstMainFuse, mainOpts, mainCable, mainCableRuns, bms };
}
