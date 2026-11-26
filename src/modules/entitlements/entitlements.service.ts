import { Injectable } from '@nestjs/common';
import { sql } from 'drizzle-orm';
import {
  FEATURE_CATALOG,
  FEATURE_KEYS,
  LIMIT_CATALOG,
  LIMIT_KEYS,
  limitLevel,
  limitPercent,
  type FeatureKey,
  type LimitKey,
  type LimitLevel,
  type LimitValue,
  type SubscriptionStatus,
} from '../../common/constants/plan-catalog.js';
import { AppException } from '../../common/app.exception.js';
import {
  DatabaseService,
  rowsOf,
  type DbTx,
} from '../../database/database.service.js';

export type EntitlementSource = 'plan' | 'unrestricted' | 'override';

export interface EffectiveFeature {
  enabled: boolean;
  source: EntitlementSource;
}
export interface EffectiveLimit extends LimitValue {
  source: EntitlementSource;
  enforced: boolean;
}

export interface Entitlements {
  planCode: string;
  planName: string;
  isUnrestricted: boolean;
  /** The stored status, except that a trial whose end has passed reads as `expired` (no job has to run for that to be true). */
  subscriptionStatus: SubscriptionStatus;
  /** Whether the subscription currently grants anything: trialing (not ended), active or past_due. */
  entitled: boolean;
  trialEndsAt: string | null;
  currentPeriodEnd: string | null;
  features: Record<FeatureKey, EffectiveFeature>;
  limits: Record<LimitKey, EffectiveLimit>;
}

/** What `tenant_entitlements()` returns. */
export interface RawEntitlements {
  subscription: {
    status: SubscriptionStatus;
    trial_ends_at: string | null;
    current_period_end: string | null;
    plan_code: string;
    plan_name: string;
    is_unrestricted: boolean;
  };
  features: Record<string, boolean>;
  limits: Record<string, { soft: number | null; hard: number | null }>;
  feature_overrides: Record<string, boolean>;
  limit_overrides: Record<string, { soft: number | null; hard: number | null }>;
}

export interface LimitReport {
  key: LimitKey;
  label: string;
  unit: 'count' | 'bytes';
  enforced: boolean;
  used: number | null;
  soft: number | null;
  hard: number | null;
  percent: number | null;
  level: LimitLevel | 'unknown';
  source: EntitlementSource;
}

const ENTITLED: readonly SubscriptionStatus[] = [
  'trialing',
  'active',
  'past_due',
];

/**
 * The rule, in one place: an override wins; otherwise an unrestricted plan allows every feature and has no limits; otherwise the plan's
 * own rows apply (no feature row means off, no limit row means unlimited). Nothing is granted unless the subscription is entitled.
 * The SQL function tenant_has_feature() applies the same rule for the database's own use; a test keeps the two in step.
 */
export function computeEntitlements(
  raw: RawEntitlements,
  now: Date = new Date(),
): Entitlements {
  const sub = raw.subscription;
  const trialOver =
    sub.status === 'trialing' &&
    sub.trial_ends_at !== null &&
    new Date(sub.trial_ends_at).getTime() <= now.getTime();
  const status: SubscriptionStatus = trialOver ? 'expired' : sub.status;
  const entitled = ENTITLED.includes(status);

  const features = {} as Record<FeatureKey, EffectiveFeature>;
  for (const key of FEATURE_KEYS) {
    const override = raw.feature_overrides[key];
    let enabled: boolean;
    let source: EntitlementSource;
    if (override !== undefined) {
      enabled = override;
      source = 'override';
    } else if (sub.is_unrestricted) {
      enabled = true;
      source = 'unrestricted';
    } else {
      enabled = raw.features[key] === true;
      source = 'plan';
    }
    features[key] = { enabled: entitled && enabled, source };
  }

  const limits = {} as Record<LimitKey, EffectiveLimit>;
  for (const key of LIMIT_KEYS) {
    const override = raw.limit_overrides[key];
    const own = raw.limits[key];
    const value: LimitValue = override
      ? { soft: override.soft, hard: override.hard }
      : sub.is_unrestricted
        ? { soft: null, hard: null }
        : { soft: own?.soft ?? null, hard: own?.hard ?? null };
    limits[key] = {
      ...value,
      source: override
        ? 'override'
        : sub.is_unrestricted
          ? 'unrestricted'
          : 'plan',
      enforced: LIMIT_CATALOG[key].enforced,
    };
  }

  return {
    planCode: sub.plan_code,
    planName: sub.plan_name,
    isUnrestricted: sub.is_unrestricted,
    subscriptionStatus: status,
    entitled,
    trialEndsAt: sub.trial_ends_at,
    currentPeriodEnd: sub.current_period_end,
    features,
    limits,
  };
}

/** Builds the per-limit report (used, thresholds, percent, level) from entitlements and counted usage. */
export function reportLimits(
  e: Entitlements,
  usage: Partial<Record<LimitKey, number | null>>,
): LimitReport[] {
  return LIMIT_KEYS.map((key) => {
    const limit = e.limits[key];
    const used = usage[key] ?? null;
    return {
      key,
      label: LIMIT_CATALOG[key].label,
      unit: LIMIT_CATALOG[key].unit,
      enforced: limit.enforced,
      used,
      soft: limit.soft,
      hard: limit.hard,
      percent: used === null ? null : limitPercent(used, limit.hard),
      level: used === null ? 'unknown' : limitLevel(used, limit),
      source: limit.source,
    };
  });
}

const featureBlocked = (key: FeatureKey, entitled: boolean) =>
  new AppException(
    'FORBIDDEN',
    entitled
      ? `Your plan does not include ${FEATURE_CATALOG[key].label}. Ask StoreForge to change your plan.`
      : 'Your subscription is not active, so this is not available. Ask StoreForge to renew your plan.',
    {
      code: entitled ? 'FEATURE_NOT_AVAILABLE' : 'SUBSCRIPTION_INACTIVE',
      details: { feature: key },
    },
  );

/**
 * What a tenant may use, and how much of it. Every module asks this service; none of them compares plan names. All reads go through
 * tenant_entitlements() / tenant_usage_counts(), which only a member of the tenant (or a Platform Admin) can call, so the check runs in
 * the caller's own transaction and a tenant can never ask about another tenant.
 */
@Injectable()
export class EntitlementsService {
  constructor(private readonly db: DatabaseService) {}

  async load(tx: DbTx, tenantId: string): Promise<Entitlements> {
    const row = rowsOf<{ e: RawEntitlements | null }>(
      await tx.execute(
        sql`select public.tenant_entitlements(${tenantId}::uuid) as e`,
      ),
    )[0];
    if (!row?.e)
      throw new AppException(
        'FORBIDDEN',
        'This organization has no subscription. Ask StoreForge to assign a plan.',
        { code: 'SUBSCRIPTION_REQUIRED' },
      );
    return computeEntitlements(row.e);
  }

  /** Counted usage for the given limits (all countable ones when none are named; storage only when named). */
  async usage(
    tx: DbTx,
    tenantId: string,
    keys?: readonly LimitKey[],
  ): Promise<Partial<Record<LimitKey, number | null>>> {
    const row = rowsOf<{ u: Record<string, number | string | null> }>(
      await tx.execute(
        sql`select public.tenant_usage_counts(${tenantId}::uuid, ${keys ? sql`string_to_array(${keys.join(',')}, ',')` : sql`null::text[]`}) as u`,
      ),
    )[0];
    const out: Partial<Record<LimitKey, number | null>> = {};
    for (const key of keys ?? LIMIT_KEYS) {
      const v = row?.u?.[key];
      out[key] = v === null || v === undefined ? null : Number(v);
    }
    return out;
  }

  async snapshot(tx: DbTx, tenantId: string, includeStorage = false) {
    const entitlements = await this.load(tx, tenantId);
    const keys = includeStorage
      ? LIMIT_KEYS
      : LIMIT_KEYS.filter((k) => k !== 'storage_bytes');
    const usage = await this.usage(tx, tenantId, keys);
    return { entitlements, limits: reportLimits(entitlements, usage) };
  }

  async hasFeature(
    tx: DbTx,
    tenantId: string,
    key: FeatureKey,
  ): Promise<boolean> {
    return (await this.load(tx, tenantId)).features[key].enabled;
  }

  /** Throws 403 FEATURE_NOT_AVAILABLE (or SUBSCRIPTION_INACTIVE) unless the tenant's plan includes the feature. */
  async assertFeature(
    tx: DbTx,
    tenantId: string,
    key: FeatureKey,
  ): Promise<void> {
    const e = await this.load(tx, tenantId);
    if (!e.features[key].enabled) throw featureBlocked(key, e.entitled);
  }

  /** The same check for callers that do not hold a transaction yet. */
  assertFeatureAs(
    userId: string,
    tenantId: string,
    key: FeatureKey,
  ): Promise<void> {
    return this.db.withUser(userId, (tx) =>
      this.assertFeature(tx, tenantId, key),
    );
  }

  /**
   * Refuses to add `adding` more of a resource once that would pass the HARD limit. Call it inside the transaction that inserts, BEFORE
   * the insert: it takes a per-tenant, per-resource advisory lock so two simultaneous requests cannot both squeeze under the limit.
   * Limits that are only reported (orders) never refuse. Throws 403 PLAN_LIMIT_REACHED with the numbers, or SUBSCRIPTION_INACTIVE.
   */
  async assertWithinLimit(
    tx: DbTx,
    tenantId: string,
    key: LimitKey,
    adding = 1,
  ): Promise<void> {
    if (!LIMIT_CATALOG[key].enforced) return;
    await tx.execute(
      sql`select pg_advisory_xact_lock(hashtextextended(${`entitlement:${tenantId}:${key}`}, 0))`,
    );
    const e = await this.load(tx, tenantId);
    if (!e.entitled)
      throw new AppException(
        'FORBIDDEN',
        'Your subscription is not active, so nothing new can be added. Ask StoreForge to renew your plan.',
        { code: 'SUBSCRIPTION_INACTIVE' },
      );
    const { hard } = e.limits[key];
    if (hard === null) return;
    const used = (await this.usage(tx, tenantId, [key]))[key] ?? null;
    // Storage that cannot be measured cannot be enforced; counts always can.
    if (used === null) return;
    if (used + adding > hard)
      throw new AppException(
        'FORBIDDEN',
        `Your plan allows ${hard.toLocaleString('en')} ${LIMIT_CATALOG[key].label.toLowerCase()} and you are at ${used.toLocaleString('en')}. Ask StoreForge to raise the limit.`,
        {
          code: 'PLAN_LIMIT_REACHED',
          details: { limit: key, used, hard },
        },
      );
  }

  assertWithinLimitAs(
    userId: string,
    tenantId: string,
    key: LimitKey,
    adding = 1,
  ): Promise<void> {
    return this.db.withUser(userId, (tx) =>
      this.assertWithinLimit(tx, tenantId, key, adding),
    );
  }
}
