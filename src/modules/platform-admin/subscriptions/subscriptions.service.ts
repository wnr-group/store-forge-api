import { Injectable } from '@nestjs/common';
import { eq, sql } from 'drizzle-orm';
import { notFound } from '../../../common/app.exception.js';
import {
  DatabaseService,
  type DbTx,
} from '../../../database/database.service.js';
import { plans, tenantSubscriptions } from '../../../database/schema/index.js';
import { recordAudit } from '../audit/audit.service.js';
import { mapProvisioningError } from '../platform-errors.js';
import type { AssignPlanDto, SubscriptionDto } from './subscriptions.dto.js';

const subscriptionNotFound = () =>
  notFound('Organization not found.', 'ORGANIZATION_NOT_FOUND');

const brief = (s: SubscriptionDto) => ({
  plan: s.plan.name,
  planCode: s.plan.code,
  billingInterval: s.billingInterval,
  status: s.status,
  trialEndsAt: s.trialEndsAt?.toISOString() ?? null,
  currentPeriodEnd: s.currentPeriodEnd?.toISOString() ?? null,
});

/**
 * A tenant's subscription. The status and dates are decided in one SQL function (apply_plan_to_tenant), shared with the
 * trigger that gives every new tenant the default plan, so a plan can never be applied in two different ways. Entitlements
 * and limits are derived from the plan, so moving a tenant to another plan changes what it may use immediately.
 */
@Injectable()
export class SubscriptionsService {
  constructor(private readonly db: DatabaseService) {}

  async read(tx: DbTx, tenantId: string): Promise<SubscriptionDto | null> {
    const [row] = await tx
      .select({ s: tenantSubscriptions, p: plans })
      .from(tenantSubscriptions)
      .innerJoin(plans, eq(plans.id, tenantSubscriptions.planId))
      .where(eq(tenantSubscriptions.tenantId, tenantId));
    if (!row) return null;
    const { s, p } = row;
    return {
      id: s.id,
      tenantId: s.tenantId,
      plan: {
        id: p.id,
        code: p.code,
        name: p.name,
        status: p.status,
        currency: p.currency,
        monthlyPriceMinor: p.monthlyPriceMinor,
        yearlyPriceMinor: p.yearlyPriceMinor,
        isUnrestricted: p.isUnrestricted,
      },
      status: s.status,
      billingInterval: s.billingInterval,
      trialEndsAt: s.trialEndsAt,
      currentPeriodStart: s.currentPeriodStart,
      currentPeriodEnd: s.currentPeriodEnd,
      cancelAtPeriodEnd: s.cancelAtPeriodEnd,
      canceledAt: s.canceledAt,
      createdAt: s.createdAt,
      updatedAt: s.updatedAt,
    };
  }

  async get(adminId: string, tenantId: string): Promise<SubscriptionDto> {
    const found = await this.db.withUser(adminId, (tx) =>
      this.read(tx, tenantId),
    );
    if (!found) throw subscriptionNotFound();
    return found;
  }

  /**
   * Puts a tenant on a plan INSIDE the caller's transaction and logs it. `created` marks a brand-new tenant (its first
   * subscription): a trial starts by default and the entry is `subscription.created`. Returns the resulting subscription.
   * Nothing is written when the tenant is already on that plan and interval.
   */
  async assignInTx(
    tx: DbTx,
    tenantId: string,
    v: Pick<AssignPlanDto, 'planId' | 'billingInterval' | 'startTrial'>,
    opts: { created?: boolean } = {},
  ): Promise<SubscriptionDto> {
    const before = await this.read(tx, tenantId);
    const interval = v.billingInterval ?? before?.billingInterval ?? 'monthly';
    if (
      !opts.created &&
      before &&
      before.plan.id === v.planId &&
      before.billingInterval === interval &&
      !v.startTrial &&
      (before.status === 'active' || before.status === 'trialing')
    )
      return before;

    await tx.execute(
      sql`select public.platform_assign_plan(${tenantId}::uuid, ${v.planId}::uuid, ${interval}, ${v.startTrial ?? opts.created ?? !before})`,
    );
    const after = (await this.read(tx, tenantId))!;
    const creating = opts.created || !before;
    await recordAudit(tx, {
      action: creating ? 'subscription.created' : 'subscription.changed',
      entityType: 'subscription',
      entityId: after.id,
      organizationId: tenantId,
      description: creating
        ? `Started plan "${after.plan.name}" (${after.billingInterval}, ${after.status})`
        : `Changed plan from "${before!.plan.name}" to "${after.plan.name}" (${after.billingInterval}, ${after.status})`,
      previous: before && !opts.created ? brief(before) : null,
      next: brief(after),
    });
    return after;
  }

  /** The subscription the new-tenant trigger created on the default plan, recorded in the audit log. */
  async auditInitial(
    tx: DbTx,
    tenantId: string,
  ): Promise<SubscriptionDto | null> {
    const sub = await this.read(tx, tenantId);
    if (sub)
      await recordAudit(tx, {
        action: 'subscription.created',
        entityType: 'subscription',
        entityId: sub.id,
        organizationId: tenantId,
        description: `Started plan "${sub.plan.name}" (${sub.billingInterval}, ${sub.status})`,
        next: brief(sub),
      });
    return sub;
  }

  async assign(
    adminId: string,
    tenantId: string,
    v: AssignPlanDto,
  ): Promise<SubscriptionDto> {
    try {
      return await this.db.withUser(adminId, (tx) =>
        this.assignInTx(tx, tenantId, v),
      );
    } catch (error) {
      return mapProvisioningError(error);
    }
  }
}
