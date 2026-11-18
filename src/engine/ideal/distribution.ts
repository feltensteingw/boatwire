// DC distribution: the always-on circuits on the battery side of the main switch, the DC panel
// and its branch circuits, and on a 24 V boat the converter and sub-panel for 12 V-only appliances.

import { CATALOG_BY_KIND } from '../../model/catalog';
import { CONVERTER_EFFICIENCY, VDROP } from '../../model/standards';
import type { DNode } from '../../model/types';
import { fuseClassFor, nextStandard, protectionFor } from '../calc';
import { CONVERTER_SIZES, fuseLabel, type Builder, type End } from './builder';
import type { Core } from './houseBank';
import type { LoadInfo, Plan } from './plan';

/** The component that stands for an appliance on the diagram. */
export function loadNode(b: Builder, p: Plan, l: LoadInfo): DNode {
  const { V } = p;
  return b.add('load', `ld-${l.e.id}`, l.e.name, {
    zone: l.e.zone,
    equipmentId: l.e.id,
    sublabel: `${Math.round(l.watts)} W · ${l.amps.toFixed(1)} A${l.v12 ? ' @12 V' : ''}`,
    data: { amps: l.amps, watts: l.watts, critical: l.critical, kind: l.e.kind, v24ok: !l.v12, volts: l.v12 ? 12 : V, glyph: CATALOG_BY_KIND[l.e.kind]?.glyph },
    notes: l.alwaysOn ? ['unswitched'] : l.heavy ? ['heavy-load'] : ['branch-protection'],
  });
}

/** Always-on loads (bilge pumps and the like): fed through their own fuse block, ahead of the battery switch. */
export function buildAlwaysOn(b: Builder, p: Plan, core: Core) {
  const { BZ, PZ, run, aoLoads } = p;
  const { firstMainFuse, mainOpts, mainCable, mainCableRuns, negBus } = core;

  if (aoLoads.length && firstMainFuse) {
    const aoAmps = aoLoads.reduce((s, l) => s + l.amps, 0);
    const aoRating = protectionFor(aoAmps);
    const aoFuse = b.add('fuse', 'ao-fuse', 'Always-on feed fuse', {
      zone: BZ,
      sublabel: fuseLabel(aoRating, fuseClassFor(aoRating, {})),
      data: { rating: aoRating, fuseClass: fuseClassFor(aoRating, {}) },
      notes: ['unswitched'],
    });
    const block = b.add('fuse-block', 'ao-block', 'Always-on fuse block', { zone: BZ, notes: ['unswitched'], data: { part: 'Fuse block, 6 circuits (battery side of switch)' } });
    const jw = b.wire('pos', [firstMainFuse, 'out'], [aoFuse, 'in'], { ...mainOpts, len: 0.5, gauge: mainCable, protectedBy: firstMainFuse.id, notes: ['unswitched'] });
    jw.cable = mainCableRuns;
    b.wire('pos', [aoFuse, 'out'], [block, 'in'], { amps: aoAmps, protect: aoRating, len: 1.5, protectedBy: aoFuse.id });
    for (const l of aoLoads) {
      const rating = protectionFor(l.amps);
      const t = b.stud(block, { rating, label: `${rating} A · ${l.e.name}` });
      const load = loadNode(b, p, l);
      const total = run(BZ, PZ) + run(PZ, l.e.zone);
      const limit = l.critical ? VDROP.critical : VDROP.nonCritical;
      if (l.e.kind === 'bilge-pump') {
        const sw = b.add('bilge-switch', `bsw-${l.e.id}`, `${l.e.name} switch`, { zone: PZ, sublabel: 'Auto / Off / Man', notes: ['bilge-switch'] });
        b.wire('pos', [block, t], [sw, 'in'], { amps: l.amps, protect: rating, len: run(BZ, PZ), vdLen: total, limit, protectedBy: block.id });
        b.wire('pos', [sw, 'out'], [load, 'pos'], { amps: l.amps, protect: rating, len: run(PZ, l.e.zone), vdLen: total, limit, protectedBy: block.id });
      } else {
        b.wire('pos', [block, t], [load, 'pos'], { amps: l.amps, protect: rating, len: run(BZ, l.e.zone), limit, protectedBy: block.id });
      }
      const g = b.wires[b.wires.length - 1].gauge;
      b.wire('neg', [negBus, b.stud(negBus)], [load, 'neg'], { amps: l.amps, len: run(BZ, l.e.zone), gauge: g, notes: ['negative-same-size'] });
    }
  }
}

/** A DC panel with its feeder fuse, negative bus and one breaker and circuit per load. */
export function buildPanel(b: Builder, p: Plan, id: string, label: string, loads: LoadInfo[], feed: { from: End; neg: End; volts: number; feederRunFrom: string }) {
  const { BZ, PZ, run } = p;
  const sum = loads.reduce((s, l) => s + l.amps, 0);
  const feederAmps = Math.max(10, sum * 0.7);
  const mainRating = protectionFor(feederAmps, 'breaker-dc');
  const panel = b.add('dc-panel', id, label, {
    zone: PZ,
    sublabel: `Main ${mainRating} A`,
    data: { rating: mainRating, part: `DC panel, ${loads.length}+ breaker positions, ${mainRating} A main` },
    notes: ['branch-protection'],
  });
  const pneg = b.add('bus-neg', `${id}-neg`, `${label} negative bus`, { zone: PZ, col: 7, notes: ['common-negative'] });
  const feedFuseCls = fuseClassFor(mainRating, {});
  const feedFuse = b.add('fuse', `${id}-feed`, `${label} feeder fuse`, {
    zone: BZ,
    col: 6,
    sublabel: fuseLabel(mainRating, feedFuseCls),
    data: { rating: mainRating, fuseClass: feedFuseCls },
    notes: ['conductor-sizing'],
  });
  const feederLen = run(feed.feederRunFrom, PZ);
  b.wire('pos', feed.from, [feedFuse, 'in'], { amps: feederAmps, protect: mainRating, len: 0.5, volts: feed.volts });
  const fw = b.wire('pos', [feedFuse, 'out'], [panel, 'in'], { amps: feederAmps, protect: mainRating, len: feederLen, volts: feed.volts, protectedBy: feedFuse.id, notes: ['conductor-sizing'] });
  b.wire('neg', feed.neg, [pneg, b.stud(pneg)], { amps: feederAmps, len: feederLen, gauge: fw.gauge, volts: feed.volts, notes: ['negative-same-size'] });
  for (const l of loads) {
    const rating = Math.max(5, protectionFor(l.amps, 'breaker-dc'));
    const t = b.stud(panel, { rating, label: `${rating} A · ${l.e.name}` });
    const load = loadNode(b, p, l);
    b.pair(
      [[panel, t], [load, 'pos']],
      [[pneg, b.stud(pneg)], [load, 'neg']],
      { amps: l.amps, protect: rating, len: run(PZ, l.e.zone), volts: feed.volts, limit: l.critical ? VDROP.critical : VDROP.nonCritical, protectedBy: panel.id, notes: ['branch-protection', 'conductor-sizing'] },
    );
  }
  return { panel, pneg };
}

/** The house DC panel, plus the 24→12 V converter and 12 V sub-panel if anything aboard needs them. */
export function buildPanels(b: Builder, p: Plan, core: Core) {
  const { V, BZ, PZ, run, panelLoads, dedLoads, v12Loads } = p;
  const { posBus, negBus } = core;

  // The house panel also carries the control (relay) circuits for loads on dedicated banks.
  const housePanel =
    panelLoads.length || dedLoads.length
      ? buildPanel(b, p, 'dc-panel', 'DC panel', panelLoads, { from: [posBus, b.stud(posBus)], neg: [negBus, b.stud(negBus)], volts: V, feederRunFrom: BZ })
      : undefined;

  if (v12Loads.length) {
    const amps12 = v12Loads.reduce((s, l) => s + l.amps, 0);
    const convRating = nextStandard(amps12 * 1.25, CONVERTER_SIZES);
    const inAmps = (convRating * 12) / V / CONVERTER_EFFICIENCY;
    const inFuseRating = protectionFor(inAmps);
    const conv = b.add('converter', 'conv-24-12', '24→12 V converter', {
      zone: PZ,
      col: 6,
      sublabel: `${convRating} A output`,
      data: { rating: convRating, part: `DC-DC converter 24/12-${convRating}` },
      notes: ['converter-24-12'],
    });
    const cf = b.add('fuse', 'conv-fuse', 'Converter fuse', { zone: BZ, col: 5, sublabel: fuseLabel(inFuseRating, fuseClassFor(inFuseRating, {})), data: { rating: inFuseRating, fuseClass: fuseClassFor(inFuseRating, {}) } });
    b.wire('pos', [posBus, b.stud(posBus)], [cf, 'in'], { amps: inAmps, protect: inFuseRating, len: 0.5 });
    b.pair([[cf, 'out'], [conv, 'in']], [[negBus, b.stud(negBus)], [conv, 'inneg']], { amps: inAmps, protect: inFuseRating, len: run(BZ, PZ), protectedBy: cf.id });
    buildPanel(b, p, 'dc-panel-12', '12 V sub-panel', v12Loads, { from: [conv, 'out'], neg: [conv, 'outneg'], volts: 12, feederRunFrom: PZ });
    b.find('info', 'converter-24-12', `${v12Loads.length} load(s) only run on 12 V; they are fed through a ${convRating} A 24→12 V converter and a 12 V sub-panel.`);
  }

  return { housePanel };
}
