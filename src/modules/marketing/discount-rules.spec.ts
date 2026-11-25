import { describe, expect, it } from 'vitest';
import {
  campaignPhase,
  canMoveCampaign,
  customerKeyOf,
  discountAmount,
  discountStatus,
  evaluateDiscount,
  normalizeCode,
  type DiscountRule,
  type DiscountScopeSets,
  type DiscountUsage,
} from './discount-rules.js';

const NOW = new Date('2026-06-15T12:00:00Z');
const past = new Date('2026-06-01T00:00:00Z');
const future = new Date('2026-07-01T00:00:00Z');
const noSets: DiscountScopeSets = {
  productIds: new Set(),
  collectionProductIds: new Set(),
};
const lines = [
  { productId: 'p1', totalMinor: 60_000 },
  { productId: 'p2', totalMinor: 40_000 },
];

const rule = (over: Partial<DiscountRule> = {}): DiscountRule => ({
  id: 'd1',
  code: 'SAVE10',
  kind: 'percentage',
  value: 1000,
  minSubtotalMinor: 0,
  maxDiscountMinor: null,
  startsAt: null,
  expiresAt: null,
  usageLimit: null,
  perCustomerLimit: null,
  appliesTo: 'all',
  isActive: true,
  campaign: null,
  ...over,
});
const usage: DiscountUsage = { inUse: 0, byCustomer: 0 };
const run = (r: DiscountRule, u = usage, l = lines, sets = noSets) =>
  evaluateDiscount(r, l, sets, u, NOW);

describe('discount amounts', () => {
  it('takes a percentage of the eligible items, rounding down to the paisa', () => {
    expect(discountAmount(rule(), 100_000)).toBe(10_000);
    expect(discountAmount(rule({ value: 333 }), 1_000)).toBe(33);
  });

  it('caps a percentage discount at the maximum', () => {
    expect(
      discountAmount(rule({ value: 5000, maxDiscountMinor: 20_000 }), 100_000),
    ).toBe(20_000);
  });

  it('takes a fixed amount, never more than the eligible items', () => {
    expect(
      discountAmount(rule({ kind: 'fixed', value: 25_000 }), 100_000),
    ).toBe(25_000);
    expect(discountAmount(rule({ kind: 'fixed', value: 25_000 }), 10_000)).toBe(
      10_000,
    );
  });

  it('never exceeds the subtotal even at 100%', () => {
    expect(discountAmount(rule({ value: 10_000 }), 777)).toBe(777);
  });
});

describe('who may use a code, and when', () => {
  it('applies a valid code', () => {
    expect(run(rule())).toEqual({
      ok: true,
      discountMinor: 10_000,
      eligibleSubtotalMinor: 100_000,
    });
  });

  it('refuses a disabled code', () => {
    expect(run(rule({ isActive: false }))).toMatchObject({
      ok: false,
      reason: 'INACTIVE',
    });
  });

  it('refuses a code before its start and at or after its expiry', () => {
    expect(run(rule({ startsAt: future }))).toMatchObject({
      reason: 'NOT_STARTED',
    });
    expect(run(rule({ expiresAt: past }))).toMatchObject({ reason: 'EXPIRED' });
    expect(run(rule({ expiresAt: NOW }))).toMatchObject({ reason: 'EXPIRED' });
    expect(run(rule({ startsAt: past, expiresAt: future })).ok).toBe(true);
  });

  it('refuses once the usage limit is reached, and allows the last use', () => {
    const limited = rule({ usageLimit: 2 });
    expect(run(limited, { inUse: 1, byCustomer: 0 }).ok).toBe(true);
    expect(run(limited, { inUse: 2, byCustomer: 0 })).toMatchObject({
      reason: 'USAGE_LIMIT',
    });
  });

  it('enforces the per-customer limit, but only once the customer is known', () => {
    const limited = rule({ perCustomerLimit: 1 });
    expect(run(limited, { inUse: 5, byCustomer: 1 })).toMatchObject({
      reason: 'CUSTOMER_LIMIT',
    });
    expect(run(limited, { inUse: 5, byCustomer: 0 }).ok).toBe(true);
    expect(run(limited, { inUse: 5, byCustomer: null }).ok).toBe(true);
  });

  it('enforces the minimum purchase on the eligible items and says what it is', () => {
    expect(run(rule({ minSubtotalMinor: 100_001 }))).toEqual({
      ok: false,
      reason: 'MIN_SUBTOTAL',
      minSubtotalMinor: 100_001,
    });
    expect(run(rule({ minSubtotalMinor: 100_000 })).ok).toBe(true);
  });
});

describe('selected products and collections', () => {
  it('discounts only the selected products', () => {
    const r = rule({ appliesTo: 'products' });
    const sets = { ...noSets, productIds: new Set(['p2']) };
    expect(run(r, usage, lines, sets)).toEqual({
      ok: true,
      discountMinor: 4_000,
      eligibleSubtotalMinor: 40_000,
    });
  });

  it('discounts only products in the selected collections', () => {
    const r = rule({ appliesTo: 'collections', kind: 'fixed', value: 5_000 });
    const sets = { ...noSets, collectionProductIds: new Set(['p1']) };
    expect(run(r, usage, lines, sets)).toMatchObject({
      ok: true,
      discountMinor: 5_000,
      eligibleSubtotalMinor: 60_000,
    });
  });

  it('refuses a scoped code when nothing in the cart is eligible', () => {
    expect(run(rule({ appliesTo: 'products' }))).toMatchObject({
      reason: 'NO_ELIGIBLE_ITEMS',
    });
  });

  it('measures the minimum purchase on eligible items only', () => {
    const r = rule({ appliesTo: 'products', minSubtotalMinor: 50_000 });
    const sets = { ...noSets, productIds: new Set(['p2']) };
    expect(run(r, usage, lines, sets)).toMatchObject({
      reason: 'MIN_SUBTOTAL',
    });
  });
});

describe('campaigns', () => {
  const window = (
    status: 'draft' | 'active' | 'paused' | 'completed',
    startsAt: Date | null = null,
    endsAt: Date | null = null,
  ) => ({ status, startsAt, endsAt });

  it('a code works only while its campaign is live', () => {
    expect(run(rule({ campaign: window('active', past, future) })).ok).toBe(
      true,
    );
    for (const c of [
      window('draft'),
      window('paused'),
      window('completed'),
      window('active', future, null),
      window('active', null, past),
    ])
      expect(run(rule({ campaign: c }))).toMatchObject({
        reason: 'CAMPAIGN_INACTIVE',
      });
  });

  it('describes the phase of a campaign', () => {
    expect(campaignPhase(window('draft'), NOW)).toBe('draft');
    expect(campaignPhase(window('active', future, null), NOW)).toBe(
      'scheduled',
    );
    expect(campaignPhase(window('active', past, future), NOW)).toBe('live');
    expect(campaignPhase(window('paused', past, future), NOW)).toBe('paused');
    expect(campaignPhase(window('active', past, past), NOW)).toBe('ended');
    expect(campaignPhase(window('completed'), NOW)).toBe('ended');
  });

  it('allows only sensible status changes', () => {
    expect(canMoveCampaign('draft', 'active')).toBe(true);
    expect(canMoveCampaign('active', 'paused')).toBe(true);
    expect(canMoveCampaign('paused', 'active')).toBe(true);
    expect(canMoveCampaign('active', 'completed')).toBe(true);
    expect(canMoveCampaign('completed', 'active')).toBe(false);
    expect(canMoveCampaign('active', 'draft')).toBe(false);
  });
});

describe('dashboard status and normalising', () => {
  it('reports why a code is not working', () => {
    expect(discountStatus(rule(), 0, NOW)).toBe('active');
    expect(discountStatus(rule({ isActive: false }), 0, NOW)).toBe('disabled');
    expect(discountStatus(rule({ startsAt: future }), 0, NOW)).toBe(
      'scheduled',
    );
    expect(discountStatus(rule({ expiresAt: past }), 0, NOW)).toBe('expired');
    expect(discountStatus(rule({ usageLimit: 3 }), 3, NOW)).toBe('exhausted');
  });

  it('upper-cases codes and lower-cases customer keys', () => {
    expect(normalizeCode('  save10 ')).toBe('SAVE10');
    expect(customerKeyOf(' Asha@Example.TEST ')).toBe('asha@example.test');
  });
});
