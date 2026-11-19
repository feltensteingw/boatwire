// High-current equipment (windlass, thruster, winches and anything over the panel's range) and
// the dedicated battery banks some boats fit beside it.

import { DEDICATED_BANK_ROLES, dedicatedRoleFor } from '../../model/catalog';
import { GAUGES, STANDARD_BREAKERS_DC, VDROP } from '../../model/standards';
import type { DNode, Equipment } from '../../model/types';
import { fmtLen, fmtSize } from '../../model/units';
import { fuseClassFor, nextStandard, protectionFor, runLength } from '../calc';
import { bankSummary, fuseLabel, SWITCH_SIZES, type Builder, type WOpts } from './builder';
import { loadNode } from './distribution';
import type { Core } from './houseBank';
import { reportBank, type Plan } from './plan';

/** The buses of a dedicated bank, which its loads connect to. */
export interface DedicatedBank {
  bus: DNode;
  nbus: DNode;
}

const DED_KEYS: Record<string, string> = { windlass: 'wl', thruster: 'th', winch: 'wn', fridge: 'fr' };

/**
 * A dedicated bank sits beside its equipment and supplies the load current through short cables.
 * It is recharged from the house bank by a DC-DC charger.
 */
function dedicatedBank(b: Builder, p: Plan, core: Core, e: Equipment, role: string): DedicatedBank {
  const { V, BZ, run, dedLoads } = p;
  const { posBus, negBus } = core;
  const key = DED_KEYS[role] ?? role;
  const label = DEDICATED_BANK_ROLES[role].label;
  const served = dedLoads.filter((l) => l.ded === role);
  if (!served.length) {
    b.find('info', 'dedicated-bank', `${e.name} is a dedicated ${label.toLowerCase()} battery, but there is no ${label.toLowerCase()} equipment for it to power.`, 'Add the equipment, or change the battery\'s role.');
  }
  const s = bankSummary(e, V);
  const lfpBank = s.chem === 'lifepo4';
  const dcA = V === 12 ? 30 : 15;
  const loadAmps = Math.max(dcA, served.reduce((sum, l) => sum + l.amps, 0));
  const rating = protectionFor(loadAmps);
  const cls = fuseClassFor(rating, { atBattery: true, lithium: lfpBank });
  const swRating = nextStandard(rating, SWITCH_SIZES);
  const bat = b.add('battery', `${key}-bat`, e.name, { zone: e.zone, sublabel: s.text, equipmentId: e.id, data: { chemistry: s.chem, ah: s.ah, volts: V }, notes: ['dedicated-bank'] });
  reportBank(b, p, e, s, bat);
  const bus = b.add('bus-pos', `${key}-bus`, `${label} positive bus`, { zone: e.zone });
  const nbus = b.add('bus-neg', `${key}-nbus`, `${label} negative bus`, { zone: e.zone });
  const fuse = b.add('fuse', `${key}-fuse`, `${label} battery fuse`, { zone: e.zone, sublabel: fuseLabel(rating, cls), data: { rating, fuseClass: cls }, notes: ['battery-fuse'] });
  const sw = b.add('switch', `${key}-switch`, `${label} battery switch`, { zone: e.zone, data: { rating: swRating, part: `Battery switch, ${swRating} A continuous` }, notes: ['battery-switch'] });
  const o = { amps: loadAmps, protect: rating, len: 0.5 };
  const bw = b.wire('pos', [bat, 'pos'], [fuse, 'in'], o);
  b.wire('pos', [fuse, 'out'], [sw, 'in'], { ...o, len: 1, gauge: bw.gauge, protectedBy: fuse.id });
  b.wire('pos', [sw, 'out'], [bus, b.stud(bus)], { ...o, len: 1, gauge: bw.gauge, protectedBy: fuse.id });
  b.wire('neg', [bat, 'neg'], [nbus, b.stud(nbus)], { ...o, len: 1.5, gauge: bw.gauge, notes: ['negative-same-size'] });
  // charge from house via DC-DC
  const dcdc = b.add('dcdc', `${key}-dcdc`, `DC-DC charger (house → ${label.toLowerCase()})`, { zone: BZ, sublabel: `${dcA} A`, data: { rating: dcA, part: `DC-DC charger ${V}/${V}-${dcA}` }, notes: ['dcdc', 'dedicated-bank'] });
  const fIn = b.add('fuse', `${key}-dcdc-in`, 'DC-DC input fuse', { zone: BZ, col: 5, sublabel: fuseLabel(protectionFor(dcA * 1.1), 'MIDI'), data: { rating: protectionFor(dcA * 1.1), fuseClass: 'MIDI' }, notes: ['charging-source-fuse'] });
  const fOut = b.add('fuse', `${key}-dcdc-out`, 'DC-DC output fuse', { zone: e.zone, sublabel: fuseLabel(protectionFor(dcA), 'MIDI'), data: { rating: protectionFor(dcA), fuseClass: 'MIDI' }, notes: ['charging-source-fuse'] });
  const len = run(BZ, e.zone);
  b.wire('pos', [posBus, b.stud(posBus)], [fIn, 'in'], { amps: dcA * 1.1, protect: protectionFor(dcA * 1.1), len: 0.5 });
  b.wire('pos', [fIn, 'out'], [dcdc, 'in'], { amps: dcA * 1.1, protect: protectionFor(dcA * 1.1), len: 2, protectedBy: fIn.id });
  b.wire('neg', [negBus, b.stud(negBus)], [dcdc, 'inneg'], { amps: dcA, len: 2 });
  const ow = b.wire('pos', [dcdc, 'out'], [fOut, 'in'], { amps: dcA, protect: protectionFor(dcA), len, protectedBy: fOut.id });
  b.wire('pos', [fOut, 'out'], [bus, b.stud(bus)], { amps: dcA, protect: protectionFor(dcA), len: 0.5 });
  b.wire('neg', [dcdc, 'outneg'], [nbus, b.stud(nbus)], { amps: dcA, len, gauge: ow.gauge });
  // common negative between banks (carries only DC-DC return current)
  b.wire('neg', [nbus, b.stud(nbus)], [negBus, b.stud(negBus)], { amps: dcA, len, gauge: ow.gauge, notes: ['common-negative'] });
  return { bus, nbus };
}

export function buildDedicatedBanks(b: Builder, p: Plan, core: Core): Map<string, DedicatedBank> {
  const built = new Map<string, DedicatedBank>();
  for (const [role, e] of p.dedBanks) built.set(role, dedicatedBank(b, p, core, e, role));
  return built;
}

/**
 * Heavy loads and loads on dedicated banks: each gets its own fuse or breaker and a contactor or
 * relay. A load on a dedicated bank is switched from the house panel.
 */
export function buildHeavyLoads(b: Builder, p: Plan, core: Core, housePanel: { panel: DNode } | undefined, dedBuilt: Map<string, DedicatedBank>) {
  const { profile, BZ, PZ, HZ, run, lfp, heavyLoads, dedLoads } = p;
  const { posBus, negBus } = core;

  for (const l of [...heavyLoads, ...dedLoads]) {
    const ded = l.ded ? dedBuilt.get(l.ded) : undefined;
    const srcBus = ded?.bus ?? posBus;
    const srcNeg = ded?.nbus ?? negBus;
    const srcZone = ded ? srcBus.zone : BZ;
    let prot: DNode;
    let rating: number;
    if (l.heavy) {
      const useFuse = l.amps * 1.25 > STANDARD_BREAKERS_DC[STANDARD_BREAKERS_DC.length - 1];
      rating = useFuse ? protectionFor(l.amps) : protectionFor(l.amps, 'breaker-dc');
      const cls = useFuse ? fuseClassFor(rating, { lithium: lfp, mainFeeder: true }) : undefined;
      prot = useFuse
        ? b.add('fuse', `prot-${l.e.id}`, `${l.e.name} fuse`, { zone: srcZone, col: 6, sublabel: fuseLabel(rating, cls!), data: { rating, fuseClass: cls }, notes: ['heavy-load'] })
        : b.add('breaker', `prot-${l.e.id}`, `${l.e.name} breaker`, { zone: srcZone, sublabel: `${rating} A (manual reset)`, data: { rating, part: `Surface-mount breaker ${rating} A` }, notes: ['heavy-load'] });
    } else {
      rating = protectionFor(l.amps);
      const cls = fuseClassFor(rating, {});
      prot = b.add('fuse', `prot-${l.e.id}`, `${l.e.name} fuse`, { zone: srcZone, col: 6, sublabel: fuseLabel(rating, cls), data: { rating, fuseClass: cls }, notes: ['dedicated-bank'] });
    }
    const relayPart = l.e.kind === 'windlass' ? 'Reversing solenoid / control box' : l.heavy ? 'Solenoid' : `Relay ${nextStandard(l.amps * 1.25, [30, 40, 70, 100])} A`;
    const cont = b.add('contactor', `cont-${l.e.id}`, `${l.e.name} ${l.heavy ? 'contactor' : 'relay'}`, {
      zone: l.e.zone,
      data: { rating: nextStandard(l.amps, l.heavy ? [100, 150, 250, 400, 600] : [30, 40, 70, 100]), part: relayPart },
      notes: l.ded ? ['dedicated-bank'] : ['heavy-load'],
    });
    const load = loadNode(b, p, l);
    const len = runLength(profile, srcZone, l.e.zone);
    const o: WOpts = { amps: l.amps, protect: rating, len, limit: l.heavy ? VDROP.nonCritical : l.critical ? VDROP.critical : VDROP.nonCritical, protectedBy: prot.id, notes: [l.heavy ? 'heavy-load' : 'dedicated-bank', 'conductor-sizing'] };
    const pw = b.wire('pos', [prot, 'out'], [cont, 'in'], { ...o, vdLen: len + 1 });
    b.wire('pos', [srcBus, b.stud(srcBus)], [prot, 'in'], { ...o, len: 0.5, gauge: pw.gauge });
    b.wire('pos', [cont, 'out'], [load, 'pos'], { ...o, len: 1, gauge: pw.gauge });
    b.wire('neg', [srcNeg, b.stud(srcNeg)], [load, 'neg'], { ...o, gauge: pw.gauge, protectedBy: undefined, notes: ['negative-same-size'] });
    // Control: a helm switch for motors, and for loads on a dedicated bank the relay is
    // powered from a small breaker on the house DC panel.
    const ctl = ded && housePanel ? { panel: housePanel.panel, t: b.stud(housePanel.panel, { rating: 5, label: `5 A · ${l.e.name} control` }) } : undefined;
    if (l.heavy) {
      const helm = b.add('helm-switch', `helm-${l.e.id}`, `${l.e.name} control`, {
        zone: HZ,
        notes: ['heavy-load'],
        extraTerminals: ctl ? [['in', 'pos', 'W', '+']] : undefined,
      });
      if (ctl) b.wire('sig', [ctl.panel, ctl.t], [helm, 'in'], { amps: 0, len: run(PZ, HZ), notes: ['dedicated-bank'] });
      b.wire('sig', [helm, 'out'], [cont, 'coil'], { amps: 0, len: run(HZ, l.e.zone) });
    } else if (ctl) {
      b.wire('sig', [ctl.panel, ctl.t], [cont, 'coil'], { amps: 0, len: run(PZ, l.e.zone), notes: ['dedicated-bank'] });
    }
    if (!ded && GAUGES.findIndex((g) => g.awg === pw.gauge) >= GAUGES.findIndex((g) => g.awg === '2/0')) {
      const role = dedicatedRoleFor(l.e.kind);
      b.find('info', 'voltage-choice', `${l.e.name}: a ${fmtLen(Math.round(len), profile.units)} run at ${Math.round(l.amps)} A needs ${fmtSize(pw.gauge, profile.units)} cable.`, role ? `A dedicated battery near the load would cut this substantially: add a Battery bank with the role "${DEDICATED_BANK_ROLES[role].label} (dedicated)". 24 V would also help.` : 'A dedicated battery near the load (charged by DC-DC), or 24 V, would cut this substantially.');
    }
  }
}
