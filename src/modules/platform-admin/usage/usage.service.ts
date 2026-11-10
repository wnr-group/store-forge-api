import { Injectable } from '@nestjs/common';
import { sql } from 'drizzle-orm';
import { Paginated } from '../../../common/dto/api-response.dto.js';
import {
  DatabaseService,
  rowsOf,
  type DbTx,
} from '../../../database/database.service.js';
import { mapProvisioningError } from '../platform-errors.js';
import { notFound } from '../../../common/app.exception.js';
import { resolveSeriesRange } from './series.js';
import type {
  InactiveOrgsDto,
  NewOrganizationsSeriesDto,
  OrgUsageDto,
  OrgUsageRowDto,
  UsageListQueryDto,
  UsageSummaryDto,
} from './usage.dto.js';

/**
 * Usage & Analytics for Platform Admins. Every number comes from an aggregate SQL function: counts, bytes and
 * timestamps only. No product, customer or order record, name or amount is ever read, so merchant business data stays
 * private.
 *
 * "Not available" and "zero" are different things and stay different: storage is `null` when Supabase Storage cannot
 * be measured, and a last-activity of `null` means the organization has had none, not that the figure is missing.
 */
const n = (v: unknown) => Number(v ?? 0);
const nullableN = (v: unknown) =>
  v === null || v === undefined ? null : Number(v);
const date = (v: unknown) =>
  v === null || v === undefined ? null : new Date(v as string | Date);

type UsageRaw = {
  products: unknown;
  customers: unknown;
  orders: unknown;
  storage_bytes: unknown;
  last_activity: unknown;
  created_at: string | Date;
  status: string;
};
type UsagePageRaw = UsageRaw & {
  id: string;
  name: string;
  slug: string;
  total_count: unknown;
};

const toUsage = (r: UsageRaw): OrgUsageDto => ({
  products: n(r.products),
  customers: n(r.customers),
  orders: n(r.orders),
  storageBytes: nullableN(r.storage_bytes),
  lastActivity: date(r.last_activity),
  createdAt: new Date(r.created_at),
  status: r.status === 'suspended' ? 'suspended' : 'active',
});

@Injectable()
export class PlatformUsageService {
  constructor(private readonly db: DatabaseService) {}

  async organization(adminId: string, tenantId: string): Promise<OrgUsageDto> {
    try {
      return await this.db.withUser(adminId, async (tx) => {
        const [row] = rowsOf<UsageRaw>(
          await tx.execute(
            sql`select * from public.platform_tenant_usage(${tenantId}::uuid)`,
          ),
        );
        if (!row)
          throw notFound('Organization not found.', 'ORGANIZATION_NOT_FOUND');
        return toUsage(row);
      });
    } catch (error) {
      return mapProvisioningError(error);
    }
  }

  private fetchPage(tx: DbTx, q: UsageListQueryDto, page: number) {
    return tx
      .execute(
        sql`select * from public.platform_usage_page(
          ${q.search || null}, ${q.status === 'all' ? null : q.status}, ${`${q.sortBy}_${q.sortOrder}`}, ${q.limit}, ${(page - 1) * q.limit})`,
      )
      .then((r) => rowsOf<UsagePageRaw>(r));
  }

  /** One page of organizations with their usage; search, filter, sort and paging all happen in SQL. */
  async list(
    adminId: string,
    q: UsageListQueryDto,
  ): Promise<Paginated<OrgUsageRowDto>> {
    return this.db.withUser(adminId, async (tx) => {
      let page = q.page;
      let raw = await this.fetchPage(tx, q, page);
      if (raw.length === 0 && page > 1) {
        const first = await this.fetchPage(tx, q, 1);
        page = Math.max(1, Math.ceil(n(first[0]?.total_count) / q.limit));
        raw = page === 1 ? first : await this.fetchPage(tx, q, page);
      }
      return new Paginated(
        raw.map((r) =>
          Object.assign(toUsage(r), { id: r.id, name: r.name, slug: r.slug }),
        ),
        { page, limit: q.limit, total: n(raw[0]?.total_count) },
      );
    });
  }

  async summary(
    adminId: string,
    inactiveDays: number,
  ): Promise<UsageSummaryDto> {
    return this.db.withUser(adminId, async (tx) => {
      const [r] = rowsOf<{
        total_orgs: unknown;
        active_orgs: unknown;
        suspended_orgs: unknown;
        inactive_orgs: unknown;
        storage_total_bytes: unknown;
      }>(
        await tx.execute(
          sql`select * from public.platform_usage_summary(${inactiveDays})`,
        ),
      );
      return {
        totalOrganizations: n(r?.total_orgs),
        active: n(r?.active_orgs),
        suspended: n(r?.suspended_orgs),
        inactive: n(r?.inactive_orgs),
        storageTotalBytes: nullableN(r?.storage_total_bytes),
      };
    });
  }

  /** The least active organizations first (never-active ones lead). */
  async inactive(
    adminId: string,
    days: number,
    limit: number,
  ): Promise<InactiveOrgsDto> {
    return this.db.withUser(adminId, async (tx) => {
      const raw = rowsOf<{
        id: string;
        name: string;
        slug: string;
        status: string;
        created_at: string | Date;
        last_activity: unknown;
        total_count: unknown;
      }>(
        await tx.execute(
          sql`select * from public.platform_inactive_organizations(${days}, ${limit}, 0)`,
        ),
      );
      return {
        total: n(raw[0]?.total_count),
        rows: raw.map((r) => ({
          id: r.id,
          name: r.name,
          slug: r.slug,
          status: r.status === 'suspended' ? 'suspended' : 'active',
          createdAt: new Date(r.created_at),
          lastActivity: date(r.last_activity),
        })),
      };
    });
  }

  async newOrganizations(
    adminId: string,
    from: string,
    to: string,
  ): Promise<NewOrganizationsSeriesDto> {
    const range = resolveSeriesRange(from, to);
    return this.db.withUser(adminId, async (tx) => {
      const raw = rowsOf<{ bucket_start: string; created: unknown }>(
        await tx.execute(
          sql`select to_char(bucket_start, 'YYYY-MM-DD') as bucket_start, created from public.platform_new_organizations_series(${range.from}::date, ${range.to}::date, ${range.bucket})`,
        ),
      );
      const points = raw.map((r) => ({
        start: r.bucket_start,
        created: n(r.created),
      }));
      return {
        ...range,
        points,
        total: points.reduce((sum, p) => sum + p.created, 0),
      };
    });
  }
}
