// Cost estimate: prices the bill of materials from the price list (model/prices.ts).
// The defaults there are rough placeholders, so everything here is an estimate of parts only.

import { currencyOf, priceFor, type PriceOverrides } from '../model/prices';
import type { Design } from '../model/types';
import type { Units } from '../model/units';
import { billOfMaterials, type BomRow, type Change } from './reports';

export interface CostedRow extends BomRow {
  /** Price of one unit as the row counts it (each, per foot or per metre). */
  unitPrice?: number;
  /** Price of the whole line. Undefined when the line cannot be priced. */
  cost?: number;
}

export interface CostSummary {
  rows: CostedRow[];
  total: number;
  /** Total by bill-of-materials category, in the order the categories appear. */
  byCategory: { category: string; cost: number }[];
  /** Lines with no price: left out of the total. */
  unpriced: number;
  currency: string;
}

export function priceBom(rows: BomRow[], prices?: PriceOverrides): CostSummary {
  const by = new Map<string, number>();
  let total = 0;
  let unpriced = 0;
  const costed = rows.map((r): CostedRow => {
    const each = r.priceKey ? priceFor(r.priceKey, prices) : undefined;
    if (each === undefined || r.priceQty === undefined || !(r.qty > 0)) {
      unpriced++;
      return r;
    }
    const cost = each * r.priceQty;
    total += cost;
    by.set(r.category, (by.get(r.category) ?? 0) + cost);
    return { ...r, unitPrice: cost / r.qty, cost };
  });
  return { rows: costed, total, byCategory: [...by].map(([category, cost]) => ({ category, cost })), unpriced, currency: currencyOf(prices) };
}

/** Estimated parts cost of a whole design. */
export const designCost = (design: Design, prices?: PriceOverrides, units: Units = 'imperial') => priceBom(billOfMaterials(design, units), prices);

// ------------------------------------------------------------ upgrade plan

/**
 * Parts a typical fix for each design-check rule needs, as price-list keys. A rule that is not
 * listed is fixed by rewiring or by parts that cannot be guessed (a larger cable of unknown size,
 * for instance), so it carries no estimate.
 */
const FIX_PARTS: Record<string, string[]> = {
  'battery-fuse': ['fuse:MRBF'],
  'class-t': ['fuse:Class T'],
  'branch-protection': ['fuse:ATC'],
  'charging-source-fuse': ['fuse:MIDI'],
  'battery-switch': ['part:switch'],
  unswitched: ['part:fuse-block', 'fuse:ATC'],
  'shore-main': ['part:elci'],
  'galvanic-isolator': ['part:galvanic-isolator'],
  'source-selector': ['part:selector'],
  'alternator-lfp': ['part:regulator', 'part:apd'],
};

export interface PlanCost {
  /** Estimated parts for the changes that could be priced. */
  cost: number;
  priced: number;
  /** Changes with no estimate: rewiring, or parts that cannot be guessed. */
  unpriced: number;
}

/** Fuses of any type count as the same kind of part when matching one change's parts against another's. */
const kindOf = (key: string) => (key.startsWith('fuse:') ? 'fuse' : key);

/** Parts a change needs: the ones it names, else the usual parts for the rule it fixes. */
function partsOf(c: Change): { parts: [string, number][]; guessed: boolean } | undefined {
  if (c.parts?.length) return { parts: c.parts, guessed: false };
  const keys = c.rule ? FIX_PARTS[c.rule] : undefined;
  return keys?.length ? { parts: keys.map((k): [string, number] => [k, 1]), guessed: true } : undefined;
}

function priceParts(parts: [string, number][], prices?: PriceOverrides): number | undefined {
  let sum = 0;
  for (const [key, qty] of parts) {
    const each = priceFor(key, prices);
    if (each === undefined || !Number.isFinite(qty)) return undefined;
    sum += each * qty;
  }
  return sum;
}

/** Rough parts cost of one change, if its parts are known or can be guessed from the rule it fixes. */
export function changeCost(c: Change, prices?: PriceOverrides): number | undefined {
  const p = partsOf(c);
  return p ? priceParts(p.parts, prices) : undefined;
}

/**
 * Rough parts cost of each priority group of the upgrade plan.
 *
 * The plan often names one missing part twice: once as a problem found ("the shore ground has no
 * galvanic isolator") and once as a part the ideal design has ("Add 1 × Galvanic isolator").
 * The part is bought once, so the guess made for the problem is dropped when the plan also lists
 * the part itself.
 */
export function planCosts(changes: Change[], prices?: PriceOverrides): Record<Change['priority'], PlanCost> {
  const out: Record<Change['priority'], PlanCost> = { safety: { cost: 0, priced: 0, unpriced: 0 }, recommended: { cost: 0, priced: 0, unpriced: 0 }, improvement: { cost: 0, priced: 0, unpriced: 0 } };
  const listed = new Map<string, number>();
  for (const c of changes) for (const [key] of c.parts ?? []) listed.set(kindOf(key), (listed.get(kindOf(key)) ?? 0) + 1);
  for (const c of changes) {
    const g = out[c.priority];
    const p = partsOf(c);
    let parts = p?.parts;
    if (p?.guessed) {
      parts = p.parts.filter(([key]) => {
        const left = listed.get(kindOf(key)) ?? 0;
        if (left > 0) listed.set(kindOf(key), left - 1);
        return left === 0;
      });
    }
    const cost = parts ? priceParts(parts, prices) : undefined;
    if (cost === undefined) g.unpriced++;
    else {
      g.cost += cost;
      g.priced++;
    }
  }
  return out;
}
