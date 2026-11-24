import { describe, expect, it } from 'vitest';
import {
  FEATURE_KEYS,
  LIMIT_KEYS,
  limitLevel,
  limitPercent,
} from '../../common/constants/plan-catalog.js';
import {
  EntitlementsService,
  computeEntitlements,
  reportLimits,
  type RawEntitlements,
} from './entitlements.service.js';

const raw = (over: Partial<RawEntitlements> = {}): RawEntitlements => ({
  subscription: {
    status: 'active',
    trial_ends_at: null,
    current_period_end: null,
    plan_code: 'basic',
    plan_name: 'Basic',
    is_unrestricted: false,
    ...over.subscription,
  },
  features: over.features ?? {},
  limits: over.limits ?? {},
  feature_overrides: over.feature_overrides ?? {},
  limit_overrides: over.limit_overrides ?? {},
});

describe('computeEntitlements', () => {
  it('switches on only what the plan lists, and leaves everything else off and unlimited', () => {
    const e = computeEntitlements(
      raw({
        features: { discount_codes: true, meta_pixel: false },
        limits: { products: { soft: 8, hard: 10 } },
      }),
    );
    expect(e.features.discount_codes).toEqual({
      enabled: true,
      source: 'plan',
    });
    expect(e.features.meta_pixel.enabled).toBe(false);
    expect(e.features.google_analytics.enabled).toBe(false);
    expect(e.limits.products).toMatchObject({
      soft: 8,
      hard: 10,
      source: 'plan',
    });
    expect(e.limits.storage_bytes).toMatchObject({ soft: null, hard: null });
  });

  it('allows every feature and no limits on an unrestricted plan, including features added later', () => {
    const e = computeEntitlements(
      raw({
        subscription: { is_unrestricted: true } as never,
        limits: { products: { soft: 1, hard: 1 } },
      }),
    );
    for (const k of FEATURE_KEYS)
      expect(e.features[k]).toEqual({ enabled: true, source: 'unrestricted' });
    for (const k of LIMIT_KEYS) expect(e.limits[k].hard).toBeNull();
  });

  it('lets an exception win over the plan in both directions, and over an unrestricted plan', () => {
    const e = computeEntitlements(
      raw({
        features: { discount_codes: true },
        feature_overrides: { discount_codes: false, meta_pixel: true },
        limits: { products: { soft: null, hard: 10 } },
        limit_overrides: {
          products: { soft: null, hard: null },
          staff_accounts: { soft: 1, hard: 2 },
        },
      }),
    );
    expect(e.features.discount_codes).toEqual({
      enabled: false,
      source: 'override',
    });
    expect(e.features.meta_pixel).toEqual({
      enabled: true,
      source: 'override',
    });
    expect(e.limits.products).toMatchObject({ hard: null, source: 'override' });
    expect(e.limits.staff_accounts).toMatchObject({
      soft: 1,
      hard: 2,
      source: 'override',
    });

    const restricted = computeEntitlements(
      raw({
        subscription: { is_unrestricted: true } as never,
        feature_overrides: { google_analytics: false },
        limit_overrides: { products: { soft: null, hard: 5 } },
      }),
    );
    expect(restricted.features.google_analytics.enabled).toBe(false);
    expect(restricted.features.meta_pixel.enabled).toBe(true);
    expect(restricted.limits.products.hard).toBe(5);
  });

  it('grants nothing unless the subscription is trialing, active or past due', () => {
    const features = { discount_codes: true };
    for (const status of ['canceled', 'expired'] as const) {
      const e = computeEntitlements(
        raw({ subscription: { status } as never, features }),
      );
      expect(e.entitled).toBe(false);
      expect(e.features.discount_codes.enabled).toBe(false);
    }
    for (const status of ['active', 'past_due', 'trialing'] as const) {
      expect(
        computeEntitlements(
          raw({ subscription: { status } as never, features }),
        ).features.discount_codes.enabled,
      ).toBe(true);
    }
  });

  it('treats a trial whose end has passed as expired without any job having run', () => {
    const sub = {
      status: 'trialing',
      trial_ends_at: '2026-01-10T00:00:00Z',
    } as never;
    const now = new Date('2026-01-10T00:00:00Z');
    const over = computeEntitlements(
      raw({ subscription: sub, features: { discount_codes: true } }),
      now,
    );
    expect(over.subscriptionStatus).toBe('expired');
    expect(over.entitled).toBe(false);
    const before = computeEntitlements(
      raw({ subscription: sub, features: { discount_codes: true } }),
      new Date('2026-01-09T23:59:59Z'),
    );
    expect(before.subscriptionStatus).toBe('trialing');
    expect(before.features.discount_codes.enabled).toBe(true);
  });
});

describe('limit levels', () => {
  it('is ok below both thresholds, warns at the soft limit or at 80% of the hard limit, and is reached at the hard limit', () => {
    expect(limitLevel(5, { soft: null, hard: null })).toBe('ok');
    expect(limitLevel(7, { soft: null, hard: 10 })).toBe('ok');
    expect(limitLevel(8, { soft: null, hard: 10 })).toBe('warning');
    expect(limitLevel(3, { soft: 3, hard: 10 })).toBe('warning');
    expect(limitLevel(10, { soft: 3, hard: 10 })).toBe('reached');
    expect(limitLevel(11, { soft: null, hard: 10 })).toBe('reached');
    expect(limitLevel(0, { soft: null, hard: 0 })).toBe('reached');
  });

  it('reports percent of the hard limit, or nothing when unlimited', () => {
    expect(limitPercent(50, 200)).toBe(25);
    expect(limitPercent(1, 3)).toBe(33);
    expect(limitPercent(5, null)).toBeNull();
    expect(limitPercent(0, 0)).toBe(100);
  });

  it('builds a report and marks unmeasurable usage as unknown instead of ok', () => {
    const e = computeEntitlements(
      raw({ limits: { products: { soft: null, hard: 10 } } }),
    );
    const rep = reportLimits(e, { products: 9, storage_bytes: null });
    expect(rep.find((r) => r.key === 'products')).toMatchObject({
      used: 9,
      percent: 90,
      level: 'warning',
    });
    expect(rep.find((r) => r.key === 'storage_bytes')).toMatchObject({
      used: null,
      level: 'unknown',
    });
  });
});

describe('EntitlementsService.assertWithinLimit', () => {
  it('never refuses a limit that is only reported (orders), without touching the database', async () => {
    const service = new EntitlementsService(null as never);
    await expect(
      service.assertWithinLimit(
        {} as never,
        'tenant',
        'orders_per_month',
        1_000_000,
      ),
    ).resolves.toBeUndefined();
  });
});
