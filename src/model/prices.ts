// Price list for the cost estimate.
//
// EVERY NUMBER HERE IS A ROUGH PLACEHOLDER, in US dollars, for typical marine-grade parts bought
// at retail. They were not taken from any supplier's price list and have not been checked. They
// exist so that two designs can be compared ("is 24 V cheaper?") and so the user has a starting
// point to correct. The app says so wherever a cost is shown, and every price can be edited.
//
// All prices live in this file. A project stores only the ones its owner has changed.

import type { Chemistry } from './types';

export type PriceBasis = 'each' | 'per ft' | 'per kWh' | 'per amp' | 'per watt';

export interface PriceDef {
  /** Stable id, stored in projects. Never reuse or rename one. */
  key: string;
  group: string;
  label: string;
  basis: PriceBasis;
  /** Default price in US dollars. A placeholder: see the note at the top of this file. */
  usd: number;
}

/** What the owner has changed from the defaults. Saved with the project. */
export interface PriceOverrides {
  /** Symbol shown in front of amounts. The numbers are not converted. */
  currency?: string;
  /** Price by key, in that currency, on the default basis (cable per foot). */
  rates?: Record<string, number>;
}

export const DEFAULT_CURRENCY = '$';

const cable = (awg: string, usd: number): PriceDef => ({ key: `cable:${awg}`, group: 'Cable, single conductor (DC)', label: `${awg} AWG tinned marine wire`, basis: 'per ft', usd });
const acCable = (awg: string, usd: number): PriceDef => ({ key: `accable:${awg}`, group: 'Cable, 3-conductor (AC)', label: `${awg}/3 AC boat cable`, basis: 'per ft', usd });
const fuse = (cls: string, label: string, usd: number): PriceDef => ({ key: `fuse:${cls}`, group: 'Fuses, with holder', label, basis: 'each', usd });
const battery = (chem: Chemistry, label: string, usd: number): PriceDef => ({ key: `battery:${chem}`, group: 'Batteries', label, basis: 'per kWh', usd });
const part = (id: string, group: string, label: string, usd: number): PriceDef => ({ key: `part:${id}`, group, label, basis: 'each', usd });
const rate = (id: string, group: string, label: string, basis: PriceBasis, usd: number): PriceDef => ({ key: `rate:${id}`, group, label, basis, usd });

const SMALL = 'Breakers and small parts';
const DIST = 'Switching and distribution';
const CHARGE = 'Charging and conversion';
const AC = 'AC equipment';

export const PRICE_DEFS: PriceDef[] = [
  cable('18', 0.25), cable('16', 0.35), cable('14', 0.45), cable('12', 0.65), cable('10', 0.95), cable('8', 1.6), cable('6', 2.4),
  cable('4', 3.5), cable('2', 5), cable('1', 6.5), cable('1/0', 8), cable('2/0', 10), cable('3/0', 12.5), cable('4/0', 15),

  acCable('18', 1.1), acCable('16', 1.3), acCable('14', 1.6), acCable('12', 2.2), acCable('10', 3.2), acCable('8', 5.5), acCable('6', 8),
  acCable('4', 12), acCable('2', 17), acCable('1', 21), acCable('1/0', 26), acCable('2/0', 32), acCable('3/0', 40), acCable('4/0', 48),

  fuse('ATC', 'Blade fuse (ATC/ATO) with inline holder', 8),
  fuse('MIDI', 'MIDI/AMI fuse with holder', 30),
  fuse('MRBF', 'Terminal fuse (MRBF) with block', 45),
  fuse('ANL', 'ANL fuse with holder', 55),
  fuse('Class T', 'Class T fuse with holder', 110),

  part('breaker', SMALL, 'Surface-mount DC breaker', 45),
  part('dc-breaker', SMALL, 'DC panel breaker', 18),
  part('ac-breaker', SMALL, 'AC panel breaker (double-pole)', 28),
  part('blade-fuse', SMALL, 'Blade fuse', 1),
  part('lug', SMALL, 'Tinned lug', 3),
  part('ring-terminal', SMALL, 'Heat-shrink ring terminal', 0.5),

  battery('flooded', 'Flooded lead-acid', 180),
  battery('agm', 'AGM', 330),
  battery('gel', 'Gel', 380),
  battery('lifepo4', 'Lithium (LiFePO4)', 500),

  part('switch', DIST, 'Battery switch', 50),
  part('busbar', DIST, 'Bus bar', 40),
  part('shunt', DIST, 'Shunt and battery monitor', 180),
  part('fuse-block', DIST, 'Fuse block', 50),
  part('dc-panel', DIST, 'DC panel (without breakers)', 300),
  part('contactor', DIST, 'Contactor, solenoid or relay', 150),
  part('bms', DIST, 'External BMS', 500),
  part('bilge-switch', DIST, 'Bilge switch (Auto/Off/Man)', 35),
  part('helm-switch', DIST, 'Helm control switch', 40),

  part('acr', CHARGE, 'Automatic charging relay', 110),
  part('isolator', CHARGE, 'Battery isolator', 130),
  part('apd', CHARGE, 'Alternator protection device', 110),
  part('regulator', CHARGE, 'External alternator regulator', 380),
  part('controller', CHARGE, 'Wind or hydro charge controller', 250),
  part('dump-load', CHARGE, 'Dump load', 90),
  rate('dcdc', CHARGE, 'DC-DC charger', 'per amp', 8),
  rate('converter', CHARGE, '24→12 V converter', 'per amp', 5),
  rate('mppt', CHARGE, 'MPPT solar controller', 'per amp', 6),
  rate('charger', CHARGE, 'Battery charger', 'per amp', 9),
  rate('alternator', CHARGE, 'Alternator', 'per amp', 5),
  rate('solar', CHARGE, 'Solar panel', 'per watt', 1),
  rate('wind', CHARGE, 'Wind generator', 'per watt', 2.5),
  rate('hydro', CHARGE, 'Hydro generator', 'per watt', 8),

  part('shore-inlet', AC, 'Shore power inlet', 90),
  part('elci', AC, 'Main breaker with ELCI', 330),
  part('galvanic-isolator', AC, 'Galvanic isolator', 280),
  part('selector', AC, 'AC source selector', 160),
  part('transfer-switch', AC, 'Automatic transfer switch', 180),
  part('ac-panel', AC, 'AC panel (without breakers)', 350),
  rate('inverter', AC, 'Inverter', 'per watt', 0.35),
  rate('inverter-charger', AC, 'Inverter/charger', 'per watt', 0.75),
  rate('generator', AC, 'AC generator', 'per watt', 1.5),
];

const BY_KEY = new Map(PRICE_DEFS.map((d) => [d.key, d]));

export const priceDef = (key: string): PriceDef | undefined => BY_KEY.get(key);

/** The price in force for a key: the owner's if they set one, otherwise the default. Undefined for an unknown key. */
export function priceFor(key: string, overrides?: PriceOverrides): number | undefined {
  const own = overrides?.rates?.[key];
  if (typeof own === 'number' && Number.isFinite(own) && own >= 0) return own;
  return BY_KEY.get(key)?.usd;
}

export const currencyOf = (overrides?: PriceOverrides) => overrides?.currency || DEFAULT_CURRENCY;

/** "$1,240", "$38", "$0.45": whole units from 100 up, cents below. */
export function fmtMoney(amount: number, currency = DEFAULT_CURRENCY): string {
  const n = amount >= 100 ? Math.round(amount).toLocaleString('en-US') : amount.toLocaleString('en-US', { minimumFractionDigits: amount % 1 === 0 ? 0 : 2, maximumFractionDigits: 2 });
  return `${currency}${n}`;
}
