import type { ShippingPricingType } from '../../database/schema/shipping.js';

/**
 * How a shipping method decides whether it can be offered and what it charges. Pure: every figure comes from the method as saved
 * and from the cart as the server priced it (never from the browser), and an answer is either a price or a reason it is not offered.
 */
export interface RateTier {
  /** Inclusive. Grams for weight tiers, paise for order-value tiers. */
  from: number;
  /** Exclusive; null means no upper limit. */
  to: number | null;
  rateMinor: number;
}

export interface PricedMethod {
  id: string;
  name: string;
  kind: 'standard' | 'express';
  pricingType: ShippingPricingType;
  flatRateMinor: number;
  freeOverMinor: number | null;
  handlingMinor: number;
  minOrderMinor: number;
  maxOrderMinor: number | null;
  minWeightGrams: number;
  maxWeightGrams: number | null;
  estDaysMin: number | null;
  estDaysMax: number | null;
  codAllowed: boolean;
  carrierCode: string | null;
  tiers: RateTier[];
}

export interface CartFacts {
  /** The items subtotal, in paise. */
  subtotalMinor: number;
  /** The total shipping weight, in grams. 0 means at least one product has no weight set. */
  weightGrams: number;
}

export type Charge =
  | { ok: true; chargeMinor: number; free: boolean }
  | { ok: false; reason: string };

/** The tier that covers `value`, if any. */
export function tierFor(
  tiers: readonly RateTier[],
  value: number,
): RateTier | undefined {
  return tiers.find((t) => value >= t.from && (t.to === null || value < t.to));
}

/** Whether this cart may use this method at all (before any price is worked out). */
export function eligibility(
  m: PricedMethod,
  cart: CartFacts,
): { ok: true } | { ok: false; reason: string } {
  if (cart.subtotalMinor < m.minOrderMinor)
    return {
      ok: false,
      reason: 'The order is below the minimum value for this method.',
    };
  if (m.maxOrderMinor !== null && cart.subtotalMinor > m.maxOrderMinor)
    return {
      ok: false,
      reason: 'The order is above the maximum value for this method.',
    };
  const weightRule =
    m.minWeightGrams > 0 ||
    m.maxWeightGrams !== null ||
    m.pricingType === 'weight' ||
    m.pricingType === 'carrier';
  if (weightRule && cart.weightGrams <= 0)
    return { ok: false, reason: 'The weight of the items is not known.' };
  if (cart.weightGrams < m.minWeightGrams)
    return {
      ok: false,
      reason: 'The parcel is lighter than this method accepts.',
    };
  if (m.maxWeightGrams !== null && cart.weightGrams > m.maxWeightGrams)
    return {
      ok: false,
      reason: 'The parcel is heavier than this method accepts.',
    };
  return { ok: true };
}

/**
 * The charge for an eligible method. `carrierPriceMinor` is the live carrier quote, needed only by carrier-priced methods; without
 * it such a method is not offered (a made-up price is never charged). A free-shipping threshold, when reached, makes any method free.
 */
export function chargeFor(
  m: PricedMethod,
  cart: CartFacts,
  carrierPriceMinor: number | null = null,
): Charge {
  if (
    m.pricingType !== 'free' &&
    m.freeOverMinor !== null &&
    cart.subtotalMinor >= m.freeOverMinor
  )
    return { ok: true, chargeMinor: 0, free: true };
  switch (m.pricingType) {
    case 'free':
      return { ok: true, chargeMinor: 0, free: true };
    case 'flat':
      return {
        ok: true,
        chargeMinor: m.flatRateMinor,
        free: m.flatRateMinor === 0,
      };
    case 'weight':
    case 'order_value': {
      const tier = tierFor(
        m.tiers,
        m.pricingType === 'weight' ? cart.weightGrams : cart.subtotalMinor,
      );
      if (!tier) return { ok: false, reason: 'No rate is set for this order.' };
      return {
        ok: true,
        chargeMinor: tier.rateMinor,
        free: tier.rateMinor === 0,
      };
    }
    case 'carrier': {
      if (carrierPriceMinor === null)
        return {
          ok: false,
          reason: 'Live carrier rates are not available right now.',
        };
      const total = carrierPriceMinor + m.handlingMinor;
      return { ok: true, chargeMinor: total, free: total === 0 };
    }
  }
}

/**
 * Tiers must cover everything from zero upwards without a gap or an overlap: they start at 0, each starts where the previous one
 * ends, and the last has no upper limit. Returns what is wrong, in words (an empty list means valid).
 */
export function tierProblems(tiers: readonly RateTier[]): string[] {
  if (tiers.length === 0) return ['Add at least one rate band.'];
  const sorted = [...tiers].sort((a, b) => a.from - b.from);
  const problems: string[] = [];
  if (sorted[0].from !== 0)
    problems.push('The first rate band must start at 0.');
  sorted.forEach((t, i) => {
    if (t.rateMinor < 0) problems.push('A rate cannot be negative.');
    if (t.to !== null && t.to <= t.from)
      problems.push('A band must end after it starts.');
    const next = sorted[i + 1];
    if (next) {
      if (t.to === null)
        problems.push('Only the last band can have no upper limit.');
      else if (t.to < next.from)
        problems.push(`There is a gap between ${t.to} and ${next.from}.`);
      else if (t.to > next.from)
        problems.push(`Two bands overlap around ${next.from}.`);
    } else if (t.to !== null)
      problems.push('The last band must have no upper limit.');
  });
  return [...new Set(problems)];
}
