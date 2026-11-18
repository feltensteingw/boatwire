// Ideal-design generator: equipment list + boat profile + scenario → Design.

import { CATALOG_BY_KIND, DEDICATED_BANK_ROLES, dedicatedRoleFor, HEAVY_DC_THRESHOLD_A } from '../model/catalog';
import { growTerminal, makeNode } from '../model/nodeDefs';
import { AC_STANDARDS, FUSE_CLASSES, GAUGES, STANDARD_BREAKERS_DC, VDROP } from '../model/standards';
import type {
  Chemistry,
  Design,
  DNode,
  Equipment,
  Finding,
  NodeType,
  Project,
  Scenario,
  Severity,
  Wire,
  WireKind,
} from '../model/types';
import { fuseClassFor, nextStandard, protectionFor, runLength, sizeConductor } from './calc';
import { energyBudget, num } from './energy';
import { effectiveEquipment, scenarioVoltage } from './scenario';

type End = [DNode, string];

interface WOpts {
  amps: number;
  /** Rating of the protective device (wire ampacity must meet it). */
  protect?: number;
  limit?: number;
  len: number;
  /** Length used for the voltage-drop calculation (defaults to len). */
  vdLen?: number;
  volts?: number;
  engine?: boolean;
  notes?: string[];
  gauge?: string;
  protectedBy?: string;
  equipmentGround?: boolean;
}

const CHEM_LABEL: Record<Chemistry, string> = { flooded: 'Flooded', agm: 'AGM', gel: 'Gel', lifepo4: 'LiFePO4' };
const MPPT_SIZES = [10, 15, 20, 30, 50, 70, 85, 100];
const CONVERTER_SIZES = [10, 20, 30, 40, 70];
const SWITCH_SIZES = [300, 350, 600, 800];
const INVERTER_EFF = 0.9;

class Builder {
  nodes: DNode[] = [];
  wires: Wire[] = [];
  findings: Finding[] = [];
  private wn = 0;

  constructor(
    public V: number,
    public acV: number,
    public us: boolean,
  ) {}

  add(type: NodeType, id: string, label: string, opts: Parameters<typeof makeNode>[3] = {}): DNode {
    const n = makeNode(type, id, label, { role: id, ...opts });
    this.nodes.push(n);
    return n;
  }

  stud(n: DNode, opts: Parameters<typeof growTerminal>[1] = {}): string {
    return growTerminal(n, opts);
  }

  wire(kind: WireKind, a: End, b: End, o: WOpts): Wire {
    const domain = kind === 'ac' || kind === 'gnd' ? 'ac' : 'dc';
    const volts = o.volts ?? (domain === 'ac' ? this.acV : this.V);
    const w: Wire = {
      id: `w${++this.wn}`,
      kind,
      domain,
      from: { node: a[0].id, term: a[1] },
      to: { node: b[0].id, term: b[1] },
      lengthFt: Math.round(o.len * 10) / 10,
      amps: Math.round(o.amps * 10) / 10,
      notes: o.notes,
      protectedBy: o.protectedBy,
      inEngineSpace: o.engine,
      equipmentGround: o.equipmentGround,
    };
    if (kind === 'sig') {
      w.gauge = o.gauge ?? '18';
      w.amps = undefined;
    } else if (o.gauge) {
      w.gauge = o.gauge;
    } else {
      const limit = o.limit ?? VDROP.critical;
      const r = sizeConductor({
        designAmps: o.amps,
        protectAmps: o.protect ?? o.amps,
        oneWayFt: o.vdLen ?? o.len,
        volts,
        vdropLimit: limit,
        inEngineSpace: o.engine,
        ac: kind === 'ac',
      });
      w.gauge = r.gauge;
      w.vdropLimit = limit;
      w.vdropPct = Math.round(r.vdropPct * 100) / 100;
      if (r.overflow) {
        const big = GAUGES[GAUGES.length - 1];
        const runs = Math.max(2, Math.ceil((o.protect ?? o.amps) / big.ampacity105));
        w.cable = `${runs}× ${big.awg}`;
        w.vdropPct = Math.round((r.vdropPct / runs) * 100) / 100;
        this.find('warning', 'conductor-sizing', `${a[0].label} → ${b[0].label} needs ${runs} parallel ${big.awg} AWG cables.`, 'Consider a higher system voltage or moving the equipment closer to the batteries.', [a[0].id, b[0].id]);
      }
    }
    if (domain === 'ac' && kind === 'ac') w.cable = w.cable ?? `${w.gauge}/3`;
    this.wires.push(w);
    return w;
  }

  /** Positive + negative pair with identical gauge. */
  pair(pos: [End, End], neg: [End, End], o: WOpts): [Wire, Wire] {
    const p = this.wire('pos', pos[0], pos[1], o);
    const n = this.wire('neg', neg[0], neg[1], { ...o, gauge: p.gauge, notes: ['negative-same-size'], protectedBy: undefined });
    n.vdropPct = p.vdropPct;
    n.vdropLimit = p.vdropLimit;
    n.cable = p.cable;
    return [p, n];
  }

  find(severity: Severity, rule: string, message: string, fix?: string, nodes?: string[]) {
    if (this.findings.some((f) => f.message === message)) return;
    this.findings.push({ id: `g${this.findings.length + 1}`, rule, severity, message, fix, nodes });
  }
}

function bankSummary(e: Equipment, V: number) {
  const unitV = num(e, 'unitVolts', 12);
  const units = num(e, 'units', 1);
  const unitAh = num(e, 'unitAh', 100);
  const series = Math.max(1, Math.round(V / unitV));
  const parallel = Math.floor(units / series);
  const chem = (e.props.chemistry as Chemistry) ?? 'agm';
  return {
    unitV,
    units,
    unitAh,
    series,
    parallel,
    chem,
    ah: parallel * unitAh,
    valid: unitV <= V && units % series === 0 && parallel > 0,
    text: `${units}× ${unitV} V ${unitAh} Ah ${CHEM_LABEL[chem]} · ${series}S${parallel}P = ${V} V ${parallel * unitAh} Ah`,
  };
}

function fuseLabel(rating: number, cls: string) {
  return `${rating} A ${cls}`;
}

export function generateIdeal(project: Project, scenario?: Scenario): Design {
  const { profile } = project;
  const V = scenarioVoltage(project, scenario);
  const acStd = AC_STANDARDS[profile.acStandard];
  const b = new Builder(V, acStd.volts, profile.acStandard === 'us120');
  const eq = effectiveEquipment(project, scenario);
  const BZ = profile.batteryZone;
  const PZ = profile.panelZone;
  const run = (a: string, z: string) => runLength(profile, a, z);
  const scale = 12 / V; // catalog currents are quoted at 12 V

  const design: Design = {
    id: scenario?.id ?? 'ideal',
    name: scenario?.name ?? 'Ideal',
    systemVoltage: V,
    nodes: b.nodes,
    wires: b.wires,
    findings: b.findings,
  };

  const kinds = (k: string) => eq.filter((e) => e.kind === k);
  const banks = kinds('battery-bank');
  const house = banks.filter((e) => (e.props.role ?? 'house') === 'house');
  const startBank = banks.find((e) => e.props.role === 'start');
  // Dedicated banks (windlass, thruster, winch, refrigeration): role → bank equipment
  const dedBanks = new Map<string, Equipment>();
  for (const r of Object.keys(DEDICATED_BANK_ROLES)) {
    const e = banks.find((x) => x.props.role === r);
    if (e) dedBanks.set(r, e);
  }
  const engine = kinds('engine')[0];

  if (house.length === 0) {
    b.find('error', 'bank-sizing', 'No house battery bank. Add a battery bank with the role "House" to generate a design.');
    return design;
  }

  // The design has one of each of these. Every extra is reported, never left out silently.
  const drawnOnce: [Equipment[], string][] = [
    [kinds('engine'), 'engine'],
    [kinds('inverter-charger'), 'inverter/charger'],
    // a separate inverter is not drawn when there is an inverter/charger
    [[...kinds('inverter-charger').slice(0, 1), ...kinds('inverter')], 'inverter'],
    [kinds('shore-power'), 'shore power inlet'],
    [kinds('generator'), 'AC generator'],
    [banks.filter((e) => e.props.role === 'start'), 'engine start battery'],
    ...Object.entries(DEDICATED_BANK_ROLES).map(([r, def]): [Equipment[], string] => [banks.filter((e) => e.props.role === r), `${def.label.toLowerCase()} battery`]),
  ];
  for (const [list, what] of drawnOnce) {
    for (const e of list.slice(1)) {
      b.find(
        'warning',
        'not-drawn',
        `${e.name} is not in this design. BoatWire draws one ${what} per boat and used ${list[0].name}.`,
        'Its wiring, fuses and cables are missing from the diagram, wire schedule and bill of materials. Work those out separately, or remove it from the equipment list.',
      );
    }
  }

  const houseChem = (house[0].props.chemistry as Chemistry) ?? 'agm';
  const lfp = houseChem === 'lifepo4';
  if (house.some((h) => h.props.chemistry !== houseChem)) {
    b.find('error', 'no-mixed-chemistry', 'House banks use different chemistries. They cannot be paralleled — choose one chemistry for the house bank.');
  }
  const extBms = lfp && house.some((h) => h.props.bms === 'external');

  // ---------------------------------------------------------------- loads
  /** `ded` = role of the dedicated bank that powers this load (if the boat has one). */
  type LoadInfo = { e: Equipment; amps: number; watts: number; critical: boolean; v12: boolean; heavy: boolean; alwaysOn: boolean; ded?: string };
  const dcLoads: LoadInfo[] = eq
    .filter((e) => CATALOG_BY_KIND[e.kind]?.category === 'dc-load')
    .map((e) => {
      const watts = num(e, 'watts');
      const v12 = V === 24 && e.props.v24ok === false;
      const amps = watts / (v12 ? 12 : V);
      const heavy = ['windlass', 'bow-thruster', 'electric-winch'].includes(e.kind) || (!v12 && amps > HEAVY_DC_THRESHOLD_A);
      const role = dedicatedRoleFor(e.kind);
      const ded = role && !v12 && dedBanks.has(role) ? role : undefined;
      return { e, amps, watts, critical: !!e.props.critical, v12, heavy, alwaysOn: !!e.props.alwaysOn && !heavy && !ded, ded };
    });
  const acLoads = eq.filter((e) => CATALOG_BY_KIND[e.kind]?.category === 'ac-load');
  const ic = kinds('inverter-charger')[0];
  const inv = kinds('inverter')[0];
  const chargers = kinds('battery-charger');
  const solars = kinds('solar');
  const winds = [...kinds('wind'), ...kinds('hydro')];

  const invWatts = ic ? num(ic, 'watts') : inv ? num(inv, 'watts') : 0;
  const invDcAmps = invWatts / (V * 0.875 * INVERTER_EFF); // at low battery voltage
  const panelLoads = dcLoads.filter((l) => !l.heavy && !l.alwaysOn && !l.v12 && !l.ded);
  const v12Loads = dcLoads.filter((l) => l.v12 && !l.heavy);
  const heavyLoads = dcLoads.filter((l) => l.heavy && !l.ded);
  const dedLoads = dcLoads.filter((l) => l.ded);
  const aoLoads = dcLoads.filter((l) => l.alwaysOn);
  const continuous = dcLoads.filter((l) => !l.heavy).reduce((s, l) => s + l.watts / V, 0) * 0.6;
  const maxHeavyFromHouse = Math.max(0, ...heavyLoads.map((l) => l.amps));
  const chargeTotal =
    chargers.reduce((s, c) => s + num(c, 'amps'), 0) +
    (ic ? num(ic, 'chargeAmps') : 0) +
    solars.reduce((s, e) => s + num(e, 'watts') / V, 0) +
    (engine ? num(engine, 'alternatorAmps') * scale : 0);
  // Inverter at full output plus typical loads, with half the largest motor load (they rarely coincide).
  const mainAmps = Math.max(invDcAmps + continuous + 0.5 * maxHeavyFromHouse, maxHeavyFromHouse + continuous, chargeTotal);

  if (V === 12 && invWatts >= 2500) {
    b.find('warning', 'voltage-choice', `A ${invWatts} W inverter draws about ${Math.round(invDcAmps)} A from a 12 V bank. At 24 V it would be about ${Math.round(invDcAmps / 2)} A, with much smaller cables.`, 'Compare a 24 V scenario.');
  }

  // ---------------------------------------------------------------- house bank
  const mainFuseRating = nextStandard(mainAmps * 1.25, [100, 125, 150, 175, 200, 225, 250, 300, 350, 400, 500, 600, 800]);
  const mainFuseClass = fuseClassFor(mainFuseRating, { atBattery: true, lithium: lfp });
  if (mainFuseRating > FUSE_CLASSES['Class T'].max) {
    b.find('error', 'class-t', `Main DC current (~${Math.round(mainAmps)} A) is beyond practical fuse and switch sizes.`, 'Raise the system voltage or split loads across banks.');
  }
  const switchRating = nextStandard(mainFuseRating, SWITCH_SIZES);
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
    b.find('warning', 'bank-sizing', `House bank is ${houseAhTotal} Ah; daily use is ~${Math.round(budget.totalAhPerDay)} Ah, which suggests ~${budget.recommendedAh} Ah for two days at safe depth of discharge.`, 'Increase house capacity or reduce loads.');
  }

  // ---------------------------------------------------------------- unswitched
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
      const load = loadNode(l);
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

  function loadNode(l: LoadInfo): DNode {
    return b.add('load', `ld-${l.e.id}`, l.e.name, {
      zone: l.e.zone,
      equipmentId: l.e.id,
      sublabel: `${Math.round(l.watts)} W · ${l.amps.toFixed(1)} A${l.v12 ? ' @12 V' : ''}`,
      data: { amps: l.amps, watts: l.watts, critical: l.critical, kind: l.e.kind, v24ok: !l.v12, volts: l.v12 ? 12 : V, glyph: CATALOG_BY_KIND[l.e.kind]?.glyph },
      notes: l.alwaysOn ? ['unswitched'] : l.heavy ? ['heavy-load'] : ['branch-protection'],
    });
  }

  // ---------------------------------------------------------------- DC panel
  function buildPanel(
    id: string,
    label: string,
    loads: LoadInfo[],
    feed: { from: End; neg: End; volts: number; feederRunFrom: string },
  ) {
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
      const load = loadNode(l);
      b.pair(
        [[panel, t], [load, 'pos']],
        [[pneg, b.stud(pneg)], [load, 'neg']],
        { amps: l.amps, protect: rating, len: run(PZ, l.e.zone), volts: feed.volts, limit: l.critical ? VDROP.critical : VDROP.nonCritical, protectedBy: panel.id, notes: ['branch-protection', 'conductor-sizing'] },
      );
    }
    return { panel, pneg };
  }

  // The house panel also carries the control (relay) circuits for loads on dedicated banks.
  const housePanel =
    panelLoads.length || dedLoads.length
      ? buildPanel('dc-panel', 'DC panel', panelLoads, { from: [posBus, b.stud(posBus)], neg: [negBus, b.stud(negBus)], volts: V, feederRunFrom: BZ })
      : undefined;

  if (v12Loads.length) {
    const amps12 = v12Loads.reduce((s, l) => s + l.amps, 0);
    const convRating = nextStandard(amps12 * 1.25, CONVERTER_SIZES);
    const inAmps = (convRating * 12) / V / INVERTER_EFF;
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
    buildPanel('dc-panel-12', '12 V sub-panel', v12Loads, { from: [conv, 'out'], neg: [conv, 'outneg'], volts: 12, feederRunFrom: PZ });
    b.find('info', 'converter-24-12', `${v12Loads.length} load(s) only run on 12 V; they are fed through a ${convRating} A 24→12 V converter and a 12 V sub-panel.`);
  }

  // ---------------------------------------------------------------- dedicated banks (windlass / thruster / winch / refrigeration)
  // The bank sits beside its equipment and supplies the load current through short cables. It is recharged
  // from the house bank by a DC-DC charger, and the load is switched from the house panel through a relay.
  const DED_KEYS: Record<string, string> = { windlass: 'wl', thruster: 'th', winch: 'wn', fridge: 'fr' };
  function dedicatedBank(e: Equipment, role: string) {
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
  const dedBuilt = new Map<string, { bus: DNode; nbus: DNode }>();
  for (const [role, e] of dedBanks) dedBuilt.set(role, dedicatedBank(e, role));

  // ---------------------------------------------------------------- heavy loads and loads on dedicated banks
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
    const load = loadNode(l);
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
        zone: 'cockpit',
        notes: ['heavy-load'],
        extraTerminals: ctl ? [['in', 'pos', 'W', '+']] : undefined,
      });
      if (ctl) b.wire('sig', [ctl.panel, ctl.t], [helm, 'in'], { amps: 0, len: run(PZ, 'cockpit'), notes: ['dedicated-bank'] });
      b.wire('sig', [helm, 'out'], [cont, 'coil'], { amps: 0, len: run('cockpit', l.e.zone) });
    } else if (ctl) {
      b.wire('sig', [ctl.panel, ctl.t], [cont, 'coil'], { amps: 0, len: run(PZ, l.e.zone), notes: ['dedicated-bank'] });
    }
    if (!ded && GAUGES.findIndex((g) => g.awg === pw.gauge) >= GAUGES.findIndex((g) => g.awg === '2/0')) {
      const role = dedicatedRoleFor(l.e.kind);
      b.find('info', 'voltage-choice', `${l.e.name}: a ${Math.round(len)} ft run at ${Math.round(l.amps)} A needs ${pw.gauge} AWG cable.`, role ? `A dedicated battery near the load would cut this substantially: add a Battery bank with the role "${DEDICATED_BANK_ROLES[role].label} (dedicated)". 24 V would also help.` : 'A dedicated battery near the load (charged by DC-DC), or 24 V, would cut this substantially.');
    }
  }

  // ---------------------------------------------------------------- engine / alternator / start
  let startBus: DNode | undefined;
  let engineNode: DNode | undefined;
  if (engine) {
    const starterA = num(engine, 'starterAmps', 150) * scale;
    const altA = num(engine, 'alternatorAmps', 0) * scale;
    const extReg = engine.props.regulator === 'external';
    const EZ = engine.zone || 'engine';
    engineNode = b.add('engine', 'engine', engine.name, {
      zone: EZ,
      equipmentId: engine.id,
      sublabel: `Starter ~${Math.round(starterA)} A`,
      data: { amps: starterA, kind: 'engine', glyph: 'ENG' },
      notes: ['starter-exempt', 'common-negative'],
    });
    const crankLen = run(BZ, EZ);
    if (startBank) {
      const s = bankSummary(startBank, V);
      const sbat = b.add('battery', 'start-bat', startBank.name, { zone: startBank.zone || BZ, equipmentId: startBank.id, sublabel: s.text, data: { chemistry: s.chem, ah: s.ah, volts: V }, notes: ['house-start-split'] });
      const sfRating = nextStandard(starterA * 2, [100, 150, 200, 250, 300]);
      const sfuse = b.add('fuse', 'start-fuse', 'Start battery fuse', { zone: sbat.zone, sublabel: fuseLabel(sfRating, 'MRBF'), data: { rating: sfRating, fuseClass: 'MRBF' }, notes: ['battery-fuse', 'starter-exempt'] });
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

    if (altA > 0) {
      const alt = b.add('alternator', 'alternator', 'Alternator', { zone: EZ, sublabel: `${Math.round(altA)} A${extReg ? ' · ext. reg.' : ''}`, data: { amps: altA, part: `${num(engine, 'alternatorAmps')} A alternator` } });
      const altFuseR = protectionFor(altA);
      const altFuseCls = fuseClassFor(altFuseR, { lithium: lfp, mainFeeder: true });
      const altLen = run(EZ, BZ);
      const split = String(engine.props.chargeSplit ?? 'auto');
      const wantsIso = split === 'isolator-fet' || split === 'isolator-diode';
      const useIso = wantsIso && !lfp && !!startBus;
      const wantsRunRelay = split === 'relay-run';
      if (wantsRunRelay && lfp) {
        b.find('info', 'charge-relay', 'Charge splitting is set to an engine-run charging relay, but a relay would parallel the lithium house bank with the start battery while the engine runs.', lfp && !extReg && startBus ? 'The design uses a DC-DC charger instead.' : 'The design uses an external regulator and alternator protection instead.');
      } else if (wantsRunRelay && !startBus) {
        b.find('info', 'charge-relay', 'Charge splitting is set to a charging relay, but there is only one battery bank, so no relay is needed.');
      }
      if (wantsIso && lfp) {
        b.find('info', 'isolator', 'Charge splitting is set to a battery isolator, but an isolator cannot give the lithium house bank its own charge profile or protect the alternator from a BMS disconnect.', lfp && !extReg && startBus ? 'The design uses a DC-DC charger instead.' : 'The design uses an external regulator and alternator protection instead.');
      } else if (wantsIso && !startBus) {
        b.find('info', 'isolator', 'Charge splitting is set to a battery isolator, but there is only one battery bank, so no isolator is needed.');
      }
      if (lfp && !extReg && startBus) {
        // Alternator → start battery; DC-DC start → house
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
      } else {
        if (useIso && startBus) {
          // Alternator → isolator → each bank through its own fuse (banks never bridged)
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
        } else {
          // Alternator → house bus directly
          const af = b.add('fuse', 'alt-fuse', 'Alternator output fuse', { zone: BZ, sublabel: fuseLabel(altFuseR, altFuseCls), data: { rating: altFuseR, fuseClass: altFuseCls }, notes: ['charging-source-fuse'] });
          const [aw] = b.pair([[alt, 'b'], [af, 'in']], [[alt, 'neg'], [negBus, b.stud(negBus)]], { amps: altA, protect: altFuseR, len: altLen, engine: true, protectedBy: af.id, notes: ['charging-source-fuse'] });
          b.wire('pos', [af, 'out'], [posBus, b.stud(posBus)], { amps: altA, protect: altFuseR, len: 0.5, gauge: aw.gauge });
        }
        if (lfp) {
          const reg = b.add('regulator', 'alt-reg', 'Smart alternator regulator', { zone: EZ, sublabel: 'Lithium profile, belt/temperature limiting', data: { part: 'External regulator (e.g. Wakespeed WS500 / Balmar MC-618)' }, notes: ['alternator-lfp'] });
          const apd = b.add('apd', 'alt-apd', 'Alternator protection device', { zone: EZ, data: { part: 'Alternator protection device (APD)' }, notes: ['alternator-lfp'] });
          b.wire('sig', [reg, 'field'], [alt, 'field'], { amps: 0, len: 2 });
          b.wire('sig', [reg, 'sense'], [posBus, b.stud(posBus, { pol: 'sig', label: 'sense' })], { amps: 0, len: altLen });
          b.wire('pos', [alt, 'b'], [apd, 'b'], { amps: 5, protect: 10, len: 1, gauge: '10', engine: true });
          b.wire('neg', [apd, 'neg'], [engineNode, 'neg'], { amps: 5, len: 1, gauge: '10', engine: true });
          if (bms) b.wire('sig', [bms, 'atc'], [reg, 'atc'], { amps: 0, len: altLen });
          if (!extReg) b.find('error', 'alternator-lfp', 'Lithium house bank with the alternator wired to it but no start battery and a stock regulator.', 'Add a lead-acid start battery (alternator → start, DC-DC → house) or fit an external regulator.');
        } else if (extReg) {
          const reg = b.add('regulator', 'alt-reg', 'Smart alternator regulator', { zone: EZ, sublabel: 'Multi-stage', data: { part: 'External regulator' } });
          b.wire('sig', [reg, 'field'], [alt, 'field'], { amps: 0, len: 2 });
          b.wire('sig', [reg, 'sense'], [posBus, b.stud(posBus, { pol: 'sig', label: 'sense' })], { amps: 0, len: altLen });
        }
        // Start battery charging from house (not needed when an isolator feeds both banks)
        if (startBus && !useIso) {
          if (lfp) {
            const dcA = V === 12 ? 18 : 12;
            const dcdc = b.add('dcdc', 'start-dcdc', 'DC-DC charger (house → start)', { zone: BZ, sublabel: `${dcA} A`, data: { rating: dcA, part: `DC-DC charger ${V}/${V}-${dcA}` }, notes: ['dcdc'] });
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
      }
    }
  }

  // ---------------------------------------------------------------- solar / wind / hydro
  solars.forEach((e) => {
    const W = num(e, 'watts');
    const vmp = num(e, 'arrayVmp', 36);
    const imp = W / vmp;
    const isc = imp * 1.1;
    const outA = W / (V * 1.18);
    const ctrl = nextStandard(outA, MPPT_SIZES);
    const pvR = nextStandard(isc * 1.56, [10, 15, 16, 20, 25, 32, 40, 50, 63]);
    const panel = b.add('solar-panel', `pv-${e.id}`, e.name, { zone: e.zone, equipmentId: e.id, sublabel: `${W} W · Vmp ${vmp} V`, data: { watts: W, amps: imp } });
    const brk = b.add('breaker', `pvbrk-${e.id}`, 'PV disconnect', { zone: BZ, col: 1, sublabel: `${pvR} A DC breaker`, data: { rating: pvR, part: `PV DC breaker ${pvR} A` }, notes: ['mppt'] });
    const mppt = b.add('mppt', `mppt-${e.id}`, 'MPPT controller', { zone: BZ, sublabel: `${Math.round(vmp * 2.8 / 50) * 50 || 100}/${ctrl}`, equipmentId: e.id, data: { rating: ctrl, amps: outA, part: `MPPT ${ctrl} A` }, notes: ['mppt'] });
    const fr = protectionFor(ctrl);
    const f = b.add('fuse', `pvfuse-${e.id}`, 'MPPT output fuse', { zone: BZ, sublabel: fuseLabel(fr, fuseClassFor(fr, {})), data: { rating: fr, fuseClass: fuseClassFor(fr, {}) }, notes: ['charging-source-fuse'] });
    const len = run(e.zone, BZ);
    const [pw] = b.pair([[panel, 'pos'], [brk, 'in']], [[panel, 'neg'], [mppt, 'pvneg']], { amps: imp, protect: pvR, len, volts: vmp, limit: VDROP.critical, notes: ['conductor-sizing'] });
    b.wire('pos', [brk, 'out'], [mppt, 'pvpos'], { amps: imp, protect: pvR, len: 1, volts: vmp, gauge: pw.gauge, protectedBy: brk.id });
    b.pair([[mppt, 'bat'], [f, 'in']], [[mppt, 'batneg'], [negBus, b.stud(negBus)]], { amps: ctrl, protect: fr, len: 2, protectedBy: f.id, notes: ['charging-source-fuse'] });
    b.wire('pos', [f, 'out'], [posBus, b.stud(posBus)], { amps: ctrl, protect: fr, len: 0.5 });
    if (bms) b.wire('sig', [bms, 'atc'], [mppt, 'atc'], { amps: 0, len: 2 });
  });

  winds.forEach((e) => {
    const W = num(e, 'watts');
    const A = W / V;
    const isWind = e.kind === 'wind';
    const gen = b.add(isWind ? 'wind-gen' : 'hydro-gen', `gen-${e.id}`, e.name, { zone: e.zone, equipmentId: e.id, sublabel: `${W} W`, data: { watts: W, amps: A } });
    const ctl = b.add('controller', `ctl-${e.id}`, `${isWind ? 'Wind' : 'Hydro'} controller`, { zone: BZ, sublabel: 'with dump-load diversion', data: { rating: Math.ceil(A) }, notes: ['dump-load'] });
    const fr = protectionFor(A);
    const f = b.add('fuse', `ctlfuse-${e.id}`, `${isWind ? 'Wind' : 'Hydro'} output fuse`, { zone: BZ, sublabel: fuseLabel(fr, fuseClassFor(fr, {})), data: { rating: fr, fuseClass: fuseClassFor(fr, {}) }, notes: ['charging-source-fuse'] });
    const dump = b.add('dump-load', `dump-${e.id}`, 'Dump load', { zone: BZ, sublabel: `${W} W resistor`, notes: ['dump-load'] });
    b.pair([[gen, 'pos'], [ctl, 'in']], [[gen, 'neg'], [ctl, 'inneg']], { amps: A, protect: A, len: run(e.zone, BZ), limit: VDROP.critical });
    b.pair([[ctl, 'bat'], [f, 'in']], [[ctl, 'batneg'], [negBus, b.stud(negBus)]], { amps: A, protect: fr, len: 2, protectedBy: f.id });
    b.wire('pos', [f, 'out'], [posBus, b.stud(posBus)], { amps: A, protect: fr, len: 0.5 });
    b.pair([[ctl, 'dump'], [dump, 'pos']], [[dump, 'neg'], [negBus, b.stud(negBus)]], { amps: A, protect: A, len: 2 });
  });

  // ---------------------------------------------------------------- AC side
  const shore = kinds('shore-power')[0];
  const genset = kinds('generator')[0];
  const anyAc = !!(shore || genset || ic || inv || acLoads.length || chargers.length);
  if (anyAc) {
    const acV = acStd.volts;
    const minBrk = b.us ? 15 : 10;
    const acBrk = (a: number) => Math.max(minBrk, protectionFor(a, 'breaker-ac'));
    const acGnd = b.add('ac-ground-bus', 'ac-gnd', 'AC grounding bus', { zone: PZ, notes: ['ac-dc-bond'] });
    let sourceOut: End | undefined;
    let sourceAmps = 0;
    let shoreCableGauge = '10';
    const groundTo = (from: End, len: number, equipmentGround = true) =>
      b.wire('gnd', from, [acGnd, b.stud(acGnd)], { amps: 0, len, gauge: shoreCableGauge, equipmentGround });

    let elci: DNode | undefined;
    if (shore) {
      const A = num(shore, 'amps', 30);
      sourceAmps = A;
      const inlet = b.add('shore-inlet', 'shore-inlet', shore.name, { zone: shore.zone, equipmentId: shore.id, sublabel: `${A} A ${acV} V`, data: { amps: A, volts: acV } });
      elci = b.add('elci', 'shore-elci', 'Shore main breaker + ELCI', { zone: shore.zone, sublabel: `${A} A · 30 mA ELCI`, data: { rating: A, part: `${A} A double-pole main breaker with ELCI` }, notes: ['shore-main'] });
      const gi = b.add('galvanic-isolator', 'galv-iso', 'Galvanic isolator', { zone: shore.zone, data: { rating: A, part: `Galvanic isolator, ${A} A, fail-safe` }, notes: ['galvanic-isolator'] });
      const w = b.wire('ac', [inlet, 'l'], [elci, 'in'], { amps: A, protect: A, len: 3, notes: ['shore-main'] });
      shoreCableGauge = w.gauge!;
      b.wire('gnd', [inlet, 'g'], [gi, 'a'], { amps: 0, len: 1, gauge: shoreCableGauge, notes: ['galvanic-isolator'] });
      b.wire('gnd', [gi, 'b'], [acGnd, b.stud(acGnd)], { amps: 0, len: run(shore.zone, PZ), gauge: shoreCableGauge, notes: ['galvanic-isolator'] });
      sourceOut = [elci, 'out'];
    }
    // AC ground ↔ DC negative bond
    b.wire('gnd', [acGnd, b.stud(acGnd)], [negBus, b.stud(negBus)], { amps: 0, len: run(PZ, BZ), gauge: shoreCableGauge, notes: ['ac-dc-bond'] });

    if (genset) {
      const GW = num(genset, 'watts');
      const GA = GW / acV;
      const gR = acBrk(GA);
      const g = b.add('generator', 'genset', genset.name, { zone: genset.zone, equipmentId: genset.id, sublabel: `${GW} W`, data: { watts: GW, amps: GA } });
      const gb = b.add('elci', 'gen-brk', 'Generator main breaker', { zone: genset.zone, sublabel: `${gR} A`, data: { rating: gR } });
      b.wire('ac', [g, 'l'], [gb, 'in'], { amps: GA, protect: gR, len: 2 });
      groundTo([g, 'g'], run(genset.zone, PZ), false);
      if (sourceOut) {
        const sel = b.add('selector', 'ac-selector', 'AC source selector', { zone: PZ, sublabel: 'Off / Shore / Generator (break-before-make)', data: { rating: Math.max(sourceAmps, gR) }, notes: ['source-selector'] });
        b.wire('ac', sourceOut, [sel, 'in1'], { amps: sourceAmps, protect: sourceAmps, len: run(shore!.zone, PZ) });
        b.wire('ac', [gb, 'out'], [sel, 'in2'], { amps: GA, protect: gR, len: run(genset.zone, PZ) });
        sourceOut = [sel, 'out'];
        sourceAmps = Math.max(sourceAmps, gR);
      } else {
        sourceOut = [gb, 'out'];
        sourceAmps = gR;
      }
    }
    const srcZone = shore && !genset ? shore.zone : PZ;

    const shoreOnlyLoads = acLoads.filter((e) => !!e.props.shoreOnly);

    const acPanel = (id: string, label: string, mainA: number, sub: string) =>
      b.add('ac-panel', id, label, { zone: PZ, sublabel: `${sub} · main ${mainA} A`, data: { rating: mainA, part: `AC panel, ${mainA} A main` } });

    let mainPanel: DNode | undefined;
    let shorePanel: DNode | undefined;

    const dcInverter = (n: DNode, dcAmps: number) => {
      const r = protectionFor(dcAmps);
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
      const mainA = sourceOut ? sourceAmps : acBrk(outA);
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
        b.wire('ac', [node, 'acout'], [ats, 'in2'], { amps: outA, protect: acBrk(outA), len: run(node.zone, PZ) });
        mainPanel = acPanel('ac-panel', 'AC panel', sourceAmps, 'Inverter-backed');
        b.wire('ac', [ats, 'out'], [mainPanel, 'in'], { amps: sourceAmps, protect: sourceAmps, len: 2 });
        if (shoreOnlyLoads.length || chargers.length) {
          shorePanel = acPanel('ac-panel-shore', 'AC panel — shore/gen only', sourceAmps, 'Not powered by inverter');
          b.wire('ac', sourceOut, [shorePanel, 'in'], { amps: sourceAmps, protect: sourceAmps, len: 2, notes: ['shore-only', 'charger-not-on-inverter'] });
        }
      } else {
        mainPanel = acPanel('ac-panel', 'AC panel', acBrk(outA), 'Inverter only');
        b.wire('ac', [node, 'acout'], [mainPanel, 'in'], { amps: outA, protect: acBrk(outA), len: run(node.zone, PZ) });
      }
    } else if (sourceOut) {
      mainPanel = acPanel('ac-panel', 'AC panel', sourceAmps, 'Shore/gen');
      b.wire('ac', sourceOut, [mainPanel, 'in'], { amps: sourceAmps, protect: sourceAmps, len: run(srcZone, PZ) });
    }

    const acCircuit = (panel: DNode, label: string, amps: number, target: End, zone: string, notes: string[] = []) => {
      const r = acBrk(amps);
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
      const fr = protectionFor(A);
      const f = b.add('fuse', `chgfuse-${c.id}`, 'Charger output fuse', { zone: BZ, sublabel: fuseLabel(fr, fuseClassFor(fr, {})), data: { rating: fr, fuseClass: fuseClassFor(fr, {}) }, notes: ['charging-source-fuse'] });
      b.pair([[node, 'out1'], [f, 'in']], [[node, 'neg'], [negBus, b.stud(negBus)]], { amps: A, protect: fr, len: run(node.zone, BZ) + 1, protectedBy: f.id });
      b.wire('pos', [f, 'out'], [posBus, b.stud(posBus)], { amps: A, protect: fr, len: 0.5 });
      if (startBus && outputs >= 2) {
        node.terminals.push({ id: 'out2', pol: 'pos', side: 'E', label: 'OUT2+' });
        const sA = Math.min(A, 10);
        const fr2 = protectionFor(sA);
        const f2 = b.add('fuse', `chgfuse2-${c.id}`, 'Charger start output fuse', { zone: startBus.zone, sublabel: fuseLabel(fr2, fuseClassFor(fr2, {})), data: { rating: fr2, fuseClass: fuseClassFor(fr2, {}) }, notes: ['charging-source-fuse'] });
        b.wire('pos', [node, 'out2'], [f2, 'in'], { amps: sA, protect: fr2, len: run(node.zone, startBus.zone) + 1, protectedBy: f2.id });
        b.wire('pos', [f2, 'out'], [startBus, b.stud(startBus)], { amps: sA, protect: fr2, len: 0.5 });
      }
    }
    if (!shore && !genset && (chargers.length || shoreOnlyLoads.length)) {
      b.find('info', 'shore-main', 'There are AC chargers or shore-only loads but no shore power inlet or generator.');
    }
  }

  return design;
}
