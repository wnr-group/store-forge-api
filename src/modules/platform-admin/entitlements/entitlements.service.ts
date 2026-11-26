import { Injectable } from '@nestjs/common';
import { and, eq, sql } from 'drizzle-orm';
import {
  isFeatureKey,
  isLimitKey,
  limitLevel,
  limitPercent,
  type LimitKey,
  type LimitLevel,
} from '../../../common/constants/plan-catalog.js';
import { invalid, notFound } from '../../../common/app.exception.js';
import { Paginated } from '../../../common/dto/api-response.dto.js';
import {
  DatabaseService,
  rowsOf,
  type DbTx,
} from '../../../database/database.service.js';
import {
  tenantFeatureOverrides,
  tenantLimitOverrides,
} from '../../../database/schema/index.js';
import { toEntitlementsDto } from '../../entitlements/entitlements.mapper.js';
import { EntitlementsService } from '../../entitlements/entitlements.service.js';
import { recordAudit } from '../audit/audit.service.js';
import { mapProvisioningError } from '../platform-errors.js';
import { SubscriptionsService } from '../subscriptions/subscriptions.service.js';
import type {
  LimitUsageQueryDto,
  LimitUsageRowDto,
  SetFeatureOverrideDto,
  SetLimitOverrideDto,
  TenantEntitlementsDto,
} from './entitlements.dto.js';

const RANK: Record<LimitLevel, number> = { ok: 0, warning: 1, reached: 2 };

type UsagePageRaw = {
  id: string;
  name: string;
  slug: string;
  status: string;
  plan_code: string;
  plan_name: string;
  subscription_status: string;
  is_unrestricted: boolean;
  products_used: unknown;
  products_soft: unknown;
  products_hard: unknown;
  staff_used: unknown;
  staff_soft: unknown;
  staff_hard: unknown;
  orders_used: unknown;
  orders_soft: unknown;
  orders_hard: unknown;
  total_count: unknown;
};
const num = (v: unknown) => Number(v ?? 0);
const numOrNull = (v: unknown) =>
  v === null || v === undefined ? null : Number(v);

const orgNotFound = () =>
  notFound('Organization not found.', 'ORGANIZATION_NOT_FOUND');

/**
 * Platform Admin view and control of what a tenant may use: its effective features and limits with usage, exceptions for one tenant
 * (which always win over the plan), and the platform-wide report of tenants close to their limits. Plan-level changes are made on the
 * plan itself; here only a single tenant is changed, and every change is logged with before and after.
 */
@Injectable()
export class PlatformEntitlementsService {
  constructor(
    private readonly db: DatabaseService,
    private readonly entitlements: EntitlementsService,
    private readonly subscriptions: SubscriptionsService,
  ) {}

  private async view(
    tx: DbTx,
    tenantId: string,
  ): Promise<TenantEntitlementsDto> {
    if (!(await this.subscriptions.read(tx, tenantId))) throw orgNotFound();
    const { entitlements, limits } = await this.entitlements.snapshot(
      tx,
      tenantId,
      true,
    );
    const [features, limitRows] = await Promise.all([
      tx
        .select()
        .from(tenantFeatureOverrides)
        .where(eq(tenantFeatureOverrides.tenantId, tenantId)),
      tx
        .select()
        .from(tenantLimitOverrides)
        .where(eq(tenantLimitOverrides.tenantId, tenantId)),
    ]);
    return Object.assign(toEntitlementsDto(entitlements, limits), {
      featureOverrides: features
        .map((o) => ({
          key: o.featureKey,
          enabled: o.enabled,
          note: o.note,
          updatedAt: o.updatedAt,
        }))
        .sort((a, b) => a.key.localeCompare(b.key)),
      limitOverrides: limitRows
        .map((o) => ({
          key: o.limitKey,
          soft: o.softLimit,
          hard: o.hardLimit,
          note: o.note,
          updatedAt: o.updatedAt,
        }))
        .sort((a, b) => a.key.localeCompare(b.key)),
    });
  }

  get(adminId: string, tenantId: string): Promise<TenantEntitlementsDto> {
    return this.db.withUser(adminId, (tx) => this.view(tx, tenantId));
  }

  async setFeature(
    adminId: string,
    tenantId: string,
    key: string,
    v: SetFeatureOverrideDto,
  ): Promise<TenantEntitlementsDto> {
    if (!isFeatureKey(key))
      throw invalid(
        'That feature does not exist.',
        { key: 'Unknown feature' },
        'FEATURE_UNKNOWN',
      );
    try {
      return await this.db.withUser(adminId, async (tx) => {
        if (!(await this.subscriptions.read(tx, tenantId))) throw orgNotFound();
        const where = and(
          eq(tenantFeatureOverrides.tenantId, tenantId),
          eq(tenantFeatureOverrides.featureKey, key),
        );
        const [before] = await tx
          .select()
          .from(tenantFeatureOverrides)
          .where(where);
        const note = v.note ?? null;
        if (v.enabled === null) {
          if (before) {
            await tx.delete(tenantFeatureOverrides).where(where);
            await recordAudit(tx, {
              action: 'entitlement.feature_override_removed',
              entityType: 'entitlement',
              entityId: tenantId,
              organizationId: tenantId,
              description: `Removed the exception for ${key}; the plan applies again`,
              previous: {
                feature: key,
                enabled: before.enabled,
                note: before.note,
              },
            });
          }
        } else if (
          !before ||
          before.enabled !== v.enabled ||
          (v.note !== undefined && before.note !== note)
        ) {
          await tx
            .insert(tenantFeatureOverrides)
            .values({
              tenantId,
              featureKey: key,
              enabled: v.enabled,
              note,
              updatedBy: adminId,
            })
            .onConflictDoUpdate({
              target: [
                tenantFeatureOverrides.tenantId,
                tenantFeatureOverrides.featureKey,
              ],
              set: {
                enabled: v.enabled,
                note: v.note !== undefined ? note : (before?.note ?? null),
                updatedBy: adminId,
                updatedAt: sql`now()`,
              },
            });
          await recordAudit(tx, {
            action: 'entitlement.feature_overridden',
            entityType: 'entitlement',
            entityId: tenantId,
            organizationId: tenantId,
            description: `${v.enabled ? 'Switched on' : 'Switched off'} ${key} for this organization, whatever its plan says`,
            previous: before
              ? { feature: key, enabled: before.enabled, note: before.note }
              : null,
            next: { feature: key, enabled: v.enabled, note },
          });
        }
        return this.view(tx, tenantId);
      });
    } catch (error) {
      return mapProvisioningError(error);
    }
  }

  async setLimit(
    adminId: string,
    tenantId: string,
    key: string,
    v: SetLimitOverrideDto,
  ): Promise<TenantEntitlementsDto> {
    if (!isLimitKey(key))
      throw invalid(
        'That limit does not exist.',
        { key: 'Unknown limit' },
        'LIMIT_UNKNOWN',
      );
    const soft = v.soft ?? null;
    const hard = v.hard ?? null;
    if (!v.clear && soft !== null && hard !== null && soft > hard)
      throw invalid('The soft limit cannot be above the hard limit.', {
        soft: 'Must not be above the hard limit',
      });
    try {
      return await this.db.withUser(adminId, async (tx) => {
        if (!(await this.subscriptions.read(tx, tenantId))) throw orgNotFound();
        const where = and(
          eq(tenantLimitOverrides.tenantId, tenantId),
          eq(tenantLimitOverrides.limitKey, key),
        );
        const [before] = await tx
          .select()
          .from(tenantLimitOverrides)
          .where(where);
        const brief = (o: {
          softLimit: number | null;
          hardLimit: number | null;
          note: string | null;
        }) => ({
          limit: key,
          soft: o.softLimit,
          hard: o.hardLimit,
          note: o.note,
        });
        if (v.clear) {
          if (before) {
            await tx.delete(tenantLimitOverrides).where(where);
            await recordAudit(tx, {
              action: 'entitlement.limit_override_removed',
              entityType: 'entitlement',
              entityId: tenantId,
              organizationId: tenantId,
              description: `Removed the own limit for ${key}; the plan applies again`,
              previous: brief(before),
            });
          }
        } else {
          const note = v.note !== undefined ? v.note : (before?.note ?? null);
          const same =
            before &&
            before.softLimit === soft &&
            before.hardLimit === hard &&
            before.note === note;
          if (!same) {
            await tx
              .insert(tenantLimitOverrides)
              .values({
                tenantId,
                limitKey: key,
                softLimit: soft,
                hardLimit: hard,
                note,
                updatedBy: adminId,
              })
              .onConflictDoUpdate({
                target: [
                  tenantLimitOverrides.tenantId,
                  tenantLimitOverrides.limitKey,
                ],
                set: {
                  softLimit: soft,
                  hardLimit: hard,
                  note,
                  updatedBy: adminId,
                  updatedAt: sql`now()`,
                },
              });
            await recordAudit(tx, {
              action: 'entitlement.limit_overridden',
              entityType: 'entitlement',
              entityId: tenantId,
              organizationId: tenantId,
              description: `Set an own limit for ${key} on this organization (soft ${soft ?? 'none'}, hard ${hard ?? 'unlimited'})`,
              previous: before ? brief(before) : null,
              next: { limit: key, soft, hard, note },
            });
          }
        }
        return this.view(tx, tenantId);
      });
    } catch (error) {
      return mapProvisioningError(error);
    }
  }

  private fetchPage(tx: DbTx, q: LimitUsageQueryDto, page: number) {
    return tx
      .execute(
        sql`select * from public.platform_limit_usage_page(${q.search || null}, ${q.filter}, ${q.limit}, ${(page - 1) * q.limit})`,
      )
      .then((r) => rowsOf<UsagePageRaw>(r));
  }

  /** Tenants and how close each is to its limits (products, staff, orders this month). Storage is shown on the tenant itself. */
  async limitUsage(
    adminId: string,
    q: LimitUsageQueryDto,
  ): Promise<Paginated<LimitUsageRowDto>> {
    return this.db.withUser(adminId, async (tx) => {
      let page = q.page;
      let raw = await this.fetchPage(tx, q, page);
      if (raw.length === 0 && page > 1) {
        const first = await this.fetchPage(tx, q, 1);
        page = Math.max(1, Math.ceil(num(first[0]?.total_count) / q.limit));
        raw = page === 1 ? first : await this.fetchPage(tx, q, page);
      }
      const rows = raw.map((r): LimitUsageRowDto => {
        const parts: {
          key: LimitKey;
          used: number;
          soft: number | null;
          hard: number | null;
        }[] = [
          {
            key: 'products',
            used: num(r.products_used),
            soft: numOrNull(r.products_soft),
            hard: numOrNull(r.products_hard),
          },
          {
            key: 'staff_accounts',
            used: num(r.staff_used),
            soft: numOrNull(r.staff_soft),
            hard: numOrNull(r.staff_hard),
          },
          {
            key: 'orders_per_month',
            used: num(r.orders_used),
            soft: numOrNull(r.orders_soft),
            hard: numOrNull(r.orders_hard),
          },
        ];
        const limits = parts.map((p) => ({
          ...p,
          percent: limitPercent(p.used, p.hard),
          level: limitLevel(p.used, p),
        }));
        const worst = limits.reduce<LimitLevel>(
          (w, l) => (RANK[l.level] > RANK[w] ? l.level : w),
          'ok',
        );
        return {
          id: r.id,
          name: r.name,
          slug: r.slug,
          status: r.status === 'suspended' ? 'suspended' : 'active',
          planCode: r.plan_code,
          planName: r.plan_name,
          subscriptionStatus: r.subscription_status,
          isUnrestricted: r.is_unrestricted,
          worstLevel: worst,
          limits,
        };
      });
      return new Paginated(rows, {
        page,
        limit: q.limit,
        total: num(raw[0]?.total_count),
      });
    });
  }
}
