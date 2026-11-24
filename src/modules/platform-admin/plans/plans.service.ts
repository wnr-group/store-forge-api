import { Injectable } from '@nestjs/common';
import { and, asc, count, eq, ilike, inArray, ne, or } from 'drizzle-orm';
import {
  FEATURE_CATALOG,
  FEATURE_KEYS,
  LIMIT_CATALOG,
  LIMIT_KEYS,
  type LimitValue,
} from '../../../common/constants/plan-catalog.js';
import {
  AppException,
  conflict,
  invalid,
  notFound,
} from '../../../common/app.exception.js';
import { errorChain } from '../../../common/db-errors.js';
import { Paginated } from '../../../common/dto/api-response.dto.js';
import { minorToInput, parseMoney } from '../../../common/utils/money.js';
import {
  DatabaseService,
  type DbTx,
} from '../../../database/database.service.js';
import {
  planFeatures,
  planLimits,
  plans,
  tenantSubscriptions,
  type Plan,
} from '../../../database/schema/index.js';
import { recordAudit } from '../audit/audit.service.js';
import type {
  CreatePlanDto,
  PlanCatalogDto,
  PlanDto,
  PlanListQueryDto,
  UpdatePlanDto,
} from './plans.dto.js';

const planNotFound = () =>
  notFound('That plan was not found.', 'PLAN_NOT_FOUND');

/** The facts worth keeping in the audit log about a plan (no ids of rows, only what an admin chose). */
const snapshot = (p: PlanDto) => ({
  name: p.name,
  description: p.description,
  status: p.status,
  currency: p.currency,
  monthlyPrice: p.monthlyPrice,
  yearlyPrice: p.yearlyPrice,
  trialDays: p.trialDays,
  isDefault: p.isDefault,
  isUnrestricted: p.isUnrestricted,
  sortOrder: p.sortOrder,
  features: p.features,
  limits: p.limits,
});

const likePattern = (s: string) =>
  `%${s.trim().replace(/\\/g, '\\\\').replace(/%/g, '\\%').replace(/_/g, '\\_')}%`;

/** Whole numbers only reach the database; a value that is already in the right shape is compared as-is. */
const sameLimit = (a: LimitValue, b: LimitValue) =>
  a.soft === b.soft && a.hard === b.hard;

/**
 * Subscription plan management. Plans, their features and limits are data edited here, never constants in the code; the
 * catalog (plan-catalog.ts) only says which capabilities exist. Every change is one transaction with its audit entry.
 * The tables are reachable only by Platform Admins (row level security), so these queries run as the admin.
 */
@Injectable()
export class PlansService {
  constructor(private readonly db: DatabaseService) {}

  catalog(): PlanCatalogDto {
    return {
      features: FEATURE_KEYS.map((key) => ({ key, ...FEATURE_CATALOG[key] })),
      limits: LIMIT_KEYS.map((key) => ({ key, ...LIMIT_CATALOG[key] })),
    };
  }

  /** Builds the full DTO (every catalog feature and limit present) for a set of plan rows, in the order given. */
  async hydrate(tx: DbTx, rows: Plan[]): Promise<PlanDto[]> {
    if (rows.length === 0) return [];
    const ids = rows.map((r) => r.id);
    const [features, limits, subscribers] = await Promise.all([
      tx.select().from(planFeatures).where(inArray(planFeatures.planId, ids)),
      tx.select().from(planLimits).where(inArray(planLimits.planId, ids)),
      tx
        .select({ planId: tenantSubscriptions.planId, n: count() })
        .from(tenantSubscriptions)
        .where(inArray(tenantSubscriptions.planId, ids))
        .groupBy(tenantSubscriptions.planId),
    ]);
    return rows.map((p) => {
      const featureMap = Object.fromEntries(
        FEATURE_KEYS.map((k) => [k, false]),
      ) as Record<string, boolean>;
      for (const f of features)
        if (f.planId === p.id && f.featureKey in featureMap)
          featureMap[f.featureKey] = f.enabled;
      const limitMap = Object.fromEntries(
        LIMIT_KEYS.map((k) => [k, { soft: null, hard: null }]),
      ) as Record<string, LimitValue>;
      for (const l of limits)
        if (l.planId === p.id && l.limitKey in limitMap)
          limitMap[l.limitKey] = { soft: l.softLimit, hard: l.hardLimit };
      return {
        id: p.id,
        code: p.code,
        name: p.name,
        description: p.description,
        status: p.status,
        currency: p.currency,
        monthlyPrice: minorToInput(p.monthlyPriceMinor, p.currency),
        monthlyPriceMinor: p.monthlyPriceMinor,
        yearlyPrice: minorToInput(p.yearlyPriceMinor, p.currency),
        yearlyPriceMinor: p.yearlyPriceMinor,
        trialDays: p.trialDays,
        isDefault: p.isDefault,
        isUnrestricted: p.isUnrestricted,
        sortOrder: p.sortOrder,
        features: featureMap,
        limits: limitMap,
        subscriberCount: Number(
          subscribers.find((s) => s.planId === p.id)?.n ?? 0,
        ),
        createdAt: p.createdAt,
        updatedAt: p.updatedAt,
      };
    });
  }

  private async load(tx: DbTx, id: string): Promise<PlanDto | null> {
    const rows = await tx.select().from(plans).where(eq(plans.id, id));
    return (await this.hydrate(tx, rows))[0] ?? null;
  }

  async list(
    adminId: string,
    q: PlanListQueryDto,
  ): Promise<Paginated<PlanDto>> {
    return this.db.withUser(adminId, async (tx) => {
      const where = and(
        q.status === 'all' ? undefined : eq(plans.status, q.status),
        q.search
          ? or(
              ilike(plans.name, likePattern(q.search)),
              ilike(plans.code, likePattern(q.search)),
            )
          : undefined,
      );
      const [{ total }] = await tx
        .select({ total: count() })
        .from(plans)
        .where(where);
      const rows = await tx
        .select()
        .from(plans)
        .where(where)
        .orderBy(asc(plans.sortOrder), asc(plans.name), asc(plans.id))
        .limit(q.limit)
        .offset((q.page - 1) * q.limit);
      return new Paginated(await this.hydrate(tx, rows), {
        page: q.page,
        limit: q.limit,
        total: Number(total),
      });
    });
  }

  async get(adminId: string, id: string): Promise<PlanDto> {
    const plan = await this.db.withUser(adminId, (tx) => this.load(tx, id));
    if (!plan) throw planNotFound();
    return plan;
  }

  /** Converts typed prices to minor units with the plan currency deciding the decimals allowed. */
  private prices(
    currency: string,
    monthly: string | undefined,
    yearly: string | undefined,
  ) {
    const out: { monthlyPriceMinor?: number; yearlyPriceMinor?: number } = {};
    const errors: Record<string, string> = {};
    if (monthly !== undefined) {
      const v = parseMoney(monthly, currency);
      if (v === null)
        errors.monthlyPrice = `Enter a valid amount in ${currency}.`;
      else out.monthlyPriceMinor = v;
    }
    if (yearly !== undefined) {
      const v = parseMoney(yearly, currency);
      if (v === null)
        errors.yearlyPrice = `Enter a valid amount in ${currency}.`;
      else out.yearlyPriceMinor = v;
    }
    if (Object.keys(errors).length)
      throw invalid('Please check the prices.', errors);
    return out;
  }

  private async writeFeatures(
    tx: DbTx,
    planId: string,
    features: Record<string, boolean>,
  ) {
    for (const [featureKey, enabled] of Object.entries(features))
      await tx
        .insert(planFeatures)
        .values({ planId, featureKey, enabled })
        .onConflictDoUpdate({
          target: [planFeatures.planId, planFeatures.featureKey],
          set: { enabled },
        });
  }

  private async writeLimits(
    tx: DbTx,
    planId: string,
    limits: Record<
      string,
      { soft?: number | null; hard?: number | null } | null
    >,
  ) {
    for (const [limitKey, value] of Object.entries(limits)) {
      const softLimit = value?.soft ?? null;
      const hardLimit = value?.hard ?? null;
      if (!value || (softLimit === null && hardLimit === null)) {
        await tx
          .delete(planLimits)
          .where(
            and(
              eq(planLimits.planId, planId),
              eq(planLimits.limitKey, limitKey),
            ),
          );
        continue;
      }
      await tx
        .insert(planLimits)
        .values({ planId, limitKey, softLimit, hardLimit })
        .onConflictDoUpdate({
          target: [planLimits.planId, planLimits.limitKey],
          set: { softLimit, hardLimit },
        });
    }
  }

  async create(adminId: string, v: CreatePlanDto): Promise<PlanDto> {
    const currency = v.currency ?? 'INR';
    const prices = this.prices(currency, v.monthlyPrice, v.yearlyPrice);
    try {
      return await this.db.withUser(adminId, async (tx) => {
        if (v.isDefault)
          await tx
            .update(plans)
            .set({ isDefault: false })
            .where(eq(plans.isDefault, true));
        const [row] = await tx
          .insert(plans)
          .values({
            code: v.code,
            name: v.name,
            description: v.description ?? null,
            currency,
            monthlyPriceMinor: prices.monthlyPriceMinor ?? 0,
            yearlyPriceMinor: prices.yearlyPriceMinor ?? 0,
            trialDays: v.trialDays ?? 0,
            isDefault: v.isDefault ?? false,
            isUnrestricted: v.isUnrestricted ?? false,
            sortOrder: v.sortOrder ?? 0,
            createdBy: adminId,
          })
          .returning();
        if (v.features) await this.writeFeatures(tx, row.id, v.features);
        if (v.limits) await this.writeLimits(tx, row.id, v.limits);
        const created = (await this.load(tx, row.id))!;
        await recordAudit(tx, {
          action: 'plan.created',
          entityType: 'plan',
          entityId: created.id,
          description: `Created plan "${created.name}" (${created.code})`,
          next: { code: created.code, ...snapshot(created) },
        });
        if (v.isDefault)
          await recordAudit(tx, {
            action: 'plan.default_changed',
            entityType: 'plan',
            entityId: created.id,
            description: `Made "${created.name}" the default plan`,
            next: { code: created.code },
          });
        return created;
      });
    } catch (error) {
      if (error instanceof AppException) throw error;
      if (errorChain(error).includes('plans_code_key'))
        throw conflict(
          'That plan code is already used.',
          { code: 'Choose a different code' },
          'PLAN_CODE_TAKEN',
        );
      throw error;
    }
  }

  async update(
    adminId: string,
    id: string,
    v: UpdatePlanDto,
  ): Promise<PlanDto> {
    return this.db.withUser(adminId, async (tx) => {
      const [locked] = await tx
        .select()
        .from(plans)
        .where(eq(plans.id, id))
        .for('update');
      if (!locked) throw planNotFound();
      const before = (await this.load(tx, id))!;

      const currency = v.currency ?? before.currency;
      const prices = this.prices(
        currency,
        v.monthlyPrice ??
          (v.currency !== undefined ? before.monthlyPrice : undefined),
        v.yearlyPrice ??
          (v.currency !== undefined ? before.yearlyPrice : undefined),
      );

      // Only what actually differs is written and logged.
      const patch: Partial<typeof plans.$inferInsert> = {};
      if (v.name !== undefined && v.name !== before.name) patch.name = v.name;
      if (
        v.description !== undefined &&
        (v.description ?? null) !== before.description
      )
        patch.description = v.description ?? null;
      if (currency !== before.currency) patch.currency = currency;
      if (
        prices.monthlyPriceMinor !== undefined &&
        prices.monthlyPriceMinor !== before.monthlyPriceMinor
      )
        patch.monthlyPriceMinor = prices.monthlyPriceMinor;
      if (
        prices.yearlyPriceMinor !== undefined &&
        prices.yearlyPriceMinor !== before.yearlyPriceMinor
      )
        patch.yearlyPriceMinor = prices.yearlyPriceMinor;
      if (v.trialDays !== undefined && v.trialDays !== before.trialDays)
        patch.trialDays = v.trialDays;
      if (
        v.isUnrestricted !== undefined &&
        v.isUnrestricted !== before.isUnrestricted
      )
        patch.isUnrestricted = v.isUnrestricted;
      if (v.sortOrder !== undefined && v.sortOrder !== before.sortOrder)
        patch.sortOrder = v.sortOrder;

      let becameDefault = false;
      if (v.isDefault === false && before.isDefault)
        throw invalid(
          'There must always be a default plan. Make another plan the default instead.',
          { isDefault: 'Choose another default plan' },
          'PLAN_IS_DEFAULT',
        );
      if (v.isDefault === true && !before.isDefault) {
        if (before.status !== 'active')
          throw invalid(
            'Only an active plan can be the default.',
            { isDefault: 'Activate the plan first' },
            'PLAN_INACTIVE',
          );
        becameDefault = true;
      }

      const featurePatch = Object.fromEntries(
        Object.entries(v.features ?? {}).filter(
          ([k, enabled]) => before.features[k] !== enabled,
        ),
      );
      const limitPatch = Object.fromEntries(
        Object.entries(v.limits ?? {}).filter(([k, value]) => {
          const next: LimitValue = {
            soft: value?.soft ?? null,
            hard: value?.hard ?? null,
          };
          return !sameLimit(before.limits[k], next);
        }),
      );

      if (
        Object.keys(patch).length === 0 &&
        Object.keys(featurePatch).length === 0 &&
        Object.keys(limitPatch).length === 0 &&
        !becameDefault
      )
        return before;

      if (becameDefault)
        await tx
          .update(plans)
          .set({ isDefault: false })
          .where(and(eq(plans.isDefault, true), ne(plans.id, id)));
      if (Object.keys(patch).length || becameDefault)
        await tx
          .update(plans)
          .set({ ...patch, ...(becameDefault ? { isDefault: true } : {}) })
          .where(eq(plans.id, id));
      await this.writeFeatures(tx, id, featurePatch);
      await this.writeLimits(tx, id, limitPatch);

      const after = (await this.load(tx, id))!;
      const was = snapshot(before) as Record<string, unknown>;
      const now = snapshot(after) as Record<string, unknown>;
      const changed = Object.keys(now).filter(
        (k) => JSON.stringify(was[k]) !== JSON.stringify(now[k]),
      );
      const only = (o: Record<string, unknown>) =>
        Object.fromEntries(
          changed.filter((k) => k !== 'isDefault').map((k) => [k, o[k]]),
        );
      if (changed.some((k) => k !== 'isDefault'))
        await recordAudit(tx, {
          action: 'plan.updated',
          entityType: 'plan',
          entityId: id,
          description: `Updated plan "${after.name}": ${changed.filter((k) => k !== 'isDefault').join(', ')}`,
          previous: { code: after.code, ...only(was) },
          next: { code: after.code, ...only(now) },
        });
      if (becameDefault)
        await recordAudit(tx, {
          action: 'plan.default_changed',
          entityType: 'plan',
          entityId: id,
          description: `Made "${after.name}" the default plan`,
          next: { code: after.code },
        });
      return after;
    });
  }

  /** Activating or deactivating changes what can be assigned from now on; organizations already on the plan keep it. */
  async setStatus(
    adminId: string,
    id: string,
    status: 'active' | 'inactive',
  ): Promise<PlanDto> {
    return this.db.withUser(adminId, async (tx) => {
      const [locked] = await tx
        .select()
        .from(plans)
        .where(eq(plans.id, id))
        .for('update');
      if (!locked) throw planNotFound();
      if (locked.status === status) return (await this.load(tx, id))!;
      if (status === 'inactive' && locked.isDefault)
        throw invalid(
          'The default plan cannot be deactivated. Make another plan the default first.',
          undefined,
          'PLAN_IS_DEFAULT',
        );
      await tx.update(plans).set({ status }).where(eq(plans.id, id));
      const after = (await this.load(tx, id))!;
      await recordAudit(tx, {
        action: status === 'active' ? 'plan.activated' : 'plan.deactivated',
        entityType: 'plan',
        entityId: id,
        description: `${status === 'active' ? 'Activated' : 'Deactivated'} plan "${after.name}"`,
        previous: { code: after.code, status: locked.status },
        next: { code: after.code, status, subscribers: after.subscriberCount },
      });
      return after;
    });
  }
}
