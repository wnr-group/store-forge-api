import { Injectable } from '@nestjs/common';
import { sql } from 'drizzle-orm';
import { platformCan } from '../../../common/constants/platform-permissions.js';
import type { PlatformLevel } from '../../../common/interfaces/request-context.js';
import {
  DatabaseService,
  rowsOf,
  type DbTx,
} from '../../../database/database.service.js';
import { BillingService } from '../../billing/billing.service.js';
import { AuditQueryDto } from '../audit/audit.dto.js';
import { AuditService } from '../audit/audit.service.js';
import { resolveSeriesRange } from '../usage/series.js';
import type { DashboardDto, DashboardQueryDto } from './dashboard.dto.js';

const n = (v: unknown) => Number(v ?? 0);

/**
 * The Overview page. Every number is counted from the database at request time: tenants, subscriptions by their real state, growth,
 * revenue and payments, the latest audited actions and whether the database answers. What a role may not read (billing, the audit log)
 * is left out as null instead of failing the whole page.
 */
@Injectable()
export class DashboardService {
  constructor(
    private readonly db: DatabaseService,
    private readonly billing: BillingService,
    private readonly audit: AuditService,
  ) {}

  private async growth(tx: DbTx, from: string, to: string, bucket: string) {
    const points = (rows: unknown) =>
      rowsOf<{ bucket_start: string | Date; created: unknown }>(rows).map(
        (r) => ({
          date: new Date(r.bucket_start).toISOString().slice(0, 10),
          count: n(r.created),
        }),
      );
    const [orgs, subs] = await Promise.all([
      tx.execute(
        sql`select * from public.platform_new_organizations_series(${from}::date, ${to}::date, ${bucket})`,
      ),
      tx.execute(sql`
        select b.start::date as bucket_start, count(s.id) as created
        from generate_series(date_trunc(${bucket}, ${from}::timestamp), date_trunc(${bucket}, ${to}::timestamp), ('1 ' || ${bucket})::interval) as b(start)
        left join public.tenant_subscriptions s
          on s.created_at >= (b.start at time zone 'UTC') and s.created_at < ((b.start + ('1 ' || ${bucket})::interval) at time zone 'UTC')
        group by b.start order by b.start`),
    ]);
    return {
      bucket,
      newOrganizations: points(orgs),
      newSubscriptions: points(subs),
    };
  }

  async get(
    adminId: string,
    level: PlatformLevel,
    q: DashboardQueryDto,
  ): Promise<DashboardDto> {
    const range = resolveSeriesRange(q.from ?? '', q.to ?? '');
    const database = (await this.db.ping()) ? 'up' : 'down';

    const core = await this.db.withUser(adminId, async (tx) => {
      const [stats] = rowsOf<{
        total_tenants: unknown;
        active_tenants: unknown;
        suspended_tenants: unknown;
        total_users: unknown;
      }>(await tx.execute(sql`select * from public.platform_overview_stats()`));
      const [subs] = rowsOf<{
        active: unknown;
        trialing: unknown;
        past_due: unknown;
        expired: unknown;
        canceled: unknown;
      }>(
        await tx.execute(sql`
          select
            count(*) filter (where s.status = 'active') as active,
            count(*) filter (where s.status = 'trialing' and (s.trial_ends_at is null or s.trial_ends_at > now())) as trialing,
            count(*) filter (where s.status = 'past_due') as past_due,
            count(*) filter (where s.status = 'expired' or (s.status = 'trialing' and s.trial_ends_at <= now())) as expired,
            count(*) filter (where s.status = 'canceled') as canceled
          from public.tenant_subscriptions s`),
      );
      return {
        tenants: {
          total: n(stats?.total_tenants),
          active: n(stats?.active_tenants),
          suspended: n(stats?.suspended_tenants),
          users: n(stats?.total_users),
        },
        subscriptions: {
          active: n(subs?.active),
          trialing: n(subs?.trialing),
          pastDue: n(subs?.past_due),
          expired: n(subs?.expired),
          canceled: n(subs?.canceled),
        },
        growth: await this.growth(tx, range.from, range.to, range.bucket),
      };
    });

    const billing = platformCan(level, 'billing:read')
      ? await this.billing.summary(adminId, { from: range.from, to: range.to })
      : null;
    const recentActivity = platformCan(level, 'audit:read')
      ? (
          await this.audit.list(
            adminId,
            Object.assign(new AuditQueryDto(), { page: 1, limit: 8 }),
          )
        ).items
      : null;

    return {
      from: range.from,
      to: range.to,
      ...core,
      billing,
      recentActivity,
      health: { api: 'up', database },
    };
  }
}
