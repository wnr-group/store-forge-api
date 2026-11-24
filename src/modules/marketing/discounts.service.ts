import { Injectable } from '@nestjs/common';
import { sql, type SQL } from 'drizzle-orm';
import { conflict, invalid, notFound } from '../../common/app.exception.js';
import { mapErrors } from '../../common/db-errors.js';
import { Paginated } from '../../common/dto/api-response.dto.js';
import { pageWithTotal, WINDOW_TOTAL } from '../../common/db-paging.js';
import { likeTerm, offsetOf } from '../../common/dto/pagination-query.dto.js';
import type { OrgContext } from '../../common/interfaces/request-context.js';
import {
  DatabaseService,
  rowsOf,
  type DbTx,
} from '../../database/database.service.js';
import { REVENUE_ORDER_STATUSES } from '../../database/schema/enums.js';
import { normalizeCode } from './discount-rules.js';
import type {
  CreateDiscountDto,
  DiscountDetailDto,
  DiscountDto,
  DiscountListQueryDto,
  UpdateDiscountDto,
} from './discounts.dto.js';

const revenue = sql.join(
  REVENUE_ORDER_STATUSES.map((s) => sql`${s}`),
  sql`, `,
);

const notFoundError = () =>
  notFound('That discount code no longer exists.', 'DISCOUNT_NOT_FOUND');

/**
 * The statuses of a code, decided in SQL so lists can be filtered and paged by them. The same rules as `discountStatus` in
 * discount-rules.ts (kept in step by the tests): disabled, scheduled, expired, exhausted, held by an inactive campaign, active.
 */
const STATUS_SQL = sql`case
  when not b.is_active then 'disabled'
  when b.starts_at is not null and b.starts_at > now() then 'scheduled'
  when b.expires_at is not null and b.expires_at <= now() then 'expired'
  when b.usage_limit is not null and b.in_use >= b.usage_limit then 'exhausted'
  when b.campaign_status is not null and not (
    b.campaign_status = 'active'
    and (b.campaign_starts_at is null or b.campaign_starts_at <= now())
    and (b.campaign_ends_at is null or b.campaign_ends_at > now())) then 'campaign_inactive'
  else 'active' end`;

interface Row {
  id: string;
  code: string;
  description: string | null;
  kind: string;
  value: number;
  min_subtotal_minor: number;
  max_discount_minor: number | null;
  starts_at: string | Date | null;
  expires_at: string | Date | null;
  usage_limit: number | null;
  per_customer_limit: number | null;
  applies_to: string;
  is_active: boolean;
  campaign_id: string | null;
  campaign_name: string | null;
  created_at: string | Date;
  updated_at: string | Date;
  in_use: number;
  discount_total: number;
  paid_orders: number;
  gross: number;
  net: number;
  status: string;
}

const date = (v: string | Date | null) => (v ? new Date(v) : null);

const toDto = (r: Row): DiscountDto => ({
  id: r.id,
  code: r.code,
  description: r.description,
  kind: r.kind,
  value: Number(r.value),
  minSubtotalMinor: Number(r.min_subtotal_minor),
  maxDiscountMinor:
    r.max_discount_minor === null ? null : Number(r.max_discount_minor),
  startsAt: date(r.starts_at),
  expiresAt: date(r.expires_at),
  usageLimit: r.usage_limit,
  perCustomerLimit: r.per_customer_limit,
  appliesTo: r.applies_to,
  isActive: r.is_active,
  status: r.status,
  campaignId: r.campaign_id,
  campaignName: r.campaign_name,
  performance: {
    redemptions: Number(r.in_use),
    discountTotalMinor: Number(r.discount_total),
    grossSalesMinor: Number(r.gross),
    netSalesMinor: Number(r.net),
    averageOrderMinor:
      Number(r.paid_orders) > 0
        ? Math.round(Number(r.net) / Number(r.paid_orders))
        : 0,
  },
  createdAt: new Date(r.created_at),
  updatedAt: new Date(r.updated_at),
});

/** The fields a code is made of once a request is applied to what is stored; checked as a whole before anything is written. */
interface Shape {
  kind: string;
  value: number;
  minSubtotalMinor: number;
  maxDiscountMinor: number | null;
  startsAt: Date | null;
  expiresAt: Date | null;
  usageLimit: number | null;
  perCustomerLimit: number | null;
  appliesTo: string;
  productIds: string[];
  collectionIds: string[];
  campaignId: string | null;
  isActive: boolean;
  description: string | null;
}

function checkShape(s: Shape): void {
  const problems: Record<string, string> = {};
  if (s.kind === 'percentage' && s.value > 10_000)
    problems.value = 'A percentage cannot be more than 100%.';
  if (s.kind === 'fixed' && s.maxDiscountMinor !== null)
    problems.maxDiscountMinor =
      'A maximum discount only makes sense for a percentage.';
  if (s.startsAt && s.expiresAt && s.expiresAt <= s.startsAt)
    problems.expiresAt = 'The expiry must be after the start.';
  if (s.appliesTo === 'products' && s.productIds.length === 0)
    problems.productIds = 'Choose at least one product.';
  if (s.appliesTo === 'collections' && s.collectionIds.length === 0)
    problems.collectionIds = 'Choose at least one collection.';
  if (Object.keys(problems).length > 0)
    throw invalid(
      'Please fix the highlighted fields.',
      problems,
      'DISCOUNT_INVALID',
    );
}

const unique = (ids: string[] | undefined) => [...new Set(ids ?? [])];
const optionalDate = (v: string | null | undefined, current: Date | null) =>
  v === undefined ? current : v === null ? null : new Date(v);

@Injectable()
export class DiscountsService {
  constructor(private readonly db: DatabaseService) {}

  /** The codes of the organization with their use. Everything is computed from the real orders that used them. */
  private baseQuery(tenantId: string, where: SQL) {
    return sql`
      select b.*, ${STATUS_SQL} as status from (
        select d.id, d.code, d.description, d.kind, d.value::float8 as value, d.min_subtotal_minor::float8 as min_subtotal_minor,
          d.max_discount_minor::float8 as max_discount_minor, d.starts_at, d.expires_at, d.usage_limit, d.per_customer_limit,
          d.applies_to, d.is_active, d.campaign_id, d.created_at, d.updated_at,
          c.name as campaign_name, c.status as campaign_status, c.starts_at as campaign_starts_at, c.ends_at as campaign_ends_at,
          coalesce(u.in_use, 0)::int as in_use, coalesce(u.discount_total, 0)::float8 as discount_total,
          coalesce(u.paid_orders, 0)::int as paid_orders, coalesce(u.gross, 0)::float8 as gross, coalesce(u.net, 0)::float8 as net
        from public.discount_codes d
        left join public.promotional_campaigns c on c.tenant_id = d.tenant_id and c.id = d.campaign_id
        left join lateral (
          select count(*) filter (where o.status not in ('cancelled', 'failed')) as in_use,
                 sum(r.discount_minor) filter (where o.status not in ('cancelled', 'failed')) as discount_total,
                 count(*) filter (where o.status in (${revenue})) as paid_orders,
                 sum(o.subtotal_minor) filter (where o.status in (${revenue})) as gross,
                 sum(o.subtotal_minor - o.discount_minor) filter (where o.status in (${revenue})) as net
          from public.discount_redemptions r
          join public.orders o on o.tenant_id = r.tenant_id and o.id = r.order_id
          where r.tenant_id = d.tenant_id and r.discount_id = d.id
        ) u on true
        where d.tenant_id = ${tenantId}::uuid and ${where}
      ) b`;
  }

  async list(
    ctx: OrgContext,
    q: DiscountListQueryDto,
  ): Promise<Paginated<DiscountDto>> {
    return this.db.withUser(ctx.userId, async (tx) => {
      const filters: SQL[] = [sql`true`];
      if (q.search)
        filters.push(
          sql`(d.code ilike ${likeTerm(q.search)} or d.description ilike ${likeTerm(q.search)})`,
        );
      if (q.campaignId)
        filters.push(sql`d.campaign_id = ${q.campaignId}::uuid`);
      const where = sql.join(filters, sql` and `);
      const base = this.baseQuery(ctx.tenantId, where);
      const statusFilter = q.status ? sql`where s.status = ${q.status}` : sql``;
      const dir = q.sortOrder === 'asc' ? sql`asc` : sql`desc`;
      const order =
        q.sortBy === 'code'
          ? sql`s.code ${dir}`
          : q.sortBy === 'redemptions'
            ? sql`s.in_use ${dir}, s.created_at desc`
            : sql`s.created_at ${dir}`;
      // A status filter needs every code's use worked out before the page can be cut, so there one evaluation (with the total riding
      // along) is cheapest. Without it only the page's own codes need their figures, and a separate count skips them entirely.
      if (q.status) {
        const { rows, total } = await pageWithTotal<
          Row & { total_rows: number }
        >(
          tx,
          sql`
            select s.*, ${WINDOW_TOTAL} from (${base}) s ${statusFilter}
            order by ${order} limit ${q.limit} offset ${offsetOf(q)}`,
          q.page,
          sql`select count(*)::int as n from (${base}) s ${statusFilter}`,
        );
        return new Paginated(rows.map(toDto), {
          page: q.page,
          limit: q.limit,
          total,
        });
      }
      const [rows, total] = await Promise.all([
        tx.execute(sql`
          select s.* from (${base}) s
          order by ${order} limit ${q.limit} offset ${offsetOf(q)}`),
        tx.execute(sql`select count(*)::int as n from (${base}) s`),
      ]);
      return new Paginated(rowsOf<Row>(rows).map(toDto), {
        page: q.page,
        limit: q.limit,
        total: rowsOf<{ n: number }>(total)[0].n,
      });
    });
  }

  async get(ctx: OrgContext, id: string): Promise<DiscountDetailDto> {
    return this.db.withUser(ctx.userId, (tx) =>
      this.detail(tx, ctx.tenantId, id),
    );
  }

  private async detail(
    tx: DbTx,
    tenantId: string,
    id: string,
  ): Promise<DiscountDetailDto> {
    const row = rowsOf<Row>(
      await tx.execute(
        sql`select s.* from (${this.baseQuery(tenantId, sql`d.id = ${id}::uuid`)}) s`,
      ),
    )[0];
    if (!row) throw notFoundError();
    const [products, collections] = await Promise.all([
      tx.execute(sql`
        select p.id, p.name from public.discount_code_targets t
        join public.products p on p.tenant_id = t.tenant_id and p.id = t.product_id
        where t.tenant_id = ${tenantId}::uuid and t.discount_id = ${id}::uuid order by p.name`),
      tx.execute(sql`
        select c.id, c.name from public.discount_code_targets t
        join public.collections c on c.tenant_id = t.tenant_id and c.id = t.collection_id
        where t.tenant_id = ${tenantId}::uuid and t.discount_id = ${id}::uuid order by c.name`),
    ]);
    return Object.assign(toDto(row), {
      products: rowsOf<{ id: string; name: string }>(products),
      collections: rowsOf<{ id: string; name: string }>(collections),
    });
  }

  async create(
    ctx: OrgContext,
    dto: CreateDiscountDto,
  ): Promise<DiscountDetailDto> {
    const shape: Shape = {
      kind: dto.kind,
      value: dto.value,
      minSubtotalMinor: dto.minSubtotalMinor ?? 0,
      maxDiscountMinor: dto.maxDiscountMinor ?? null,
      startsAt: optionalDate(dto.startsAt, null),
      expiresAt: optionalDate(dto.expiresAt, null),
      usageLimit: dto.usageLimit ?? null,
      perCustomerLimit: dto.perCustomerLimit ?? null,
      appliesTo: dto.appliesTo ?? 'all',
      productIds: unique(dto.productIds),
      collectionIds: unique(dto.collectionIds),
      campaignId: dto.campaignId ?? null,
      isActive: dto.isActive ?? true,
      description: dto.description ?? null,
    };
    checkShape(shape);
    const code = normalizeCode(dto.code);
    return mapErrors(() =>
      this.db.withUser(ctx.userId, async (tx) => {
        const id = rowsOf<{ id: string }>(
          await tx.execute(sql`
            insert into public.discount_codes (tenant_id, campaign_id, code, description, kind, value, min_subtotal_minor,
              max_discount_minor, starts_at, expires_at, usage_limit, per_customer_limit, applies_to, is_active,
              created_by, updated_by, updated_at)
            values (${ctx.tenantId}::uuid, ${shape.campaignId}::uuid, ${code}, ${shape.description}, ${shape.kind}, ${shape.value},
              ${shape.minSubtotalMinor}, ${shape.maxDiscountMinor}, ${shape.startsAt}, ${shape.expiresAt}, ${shape.usageLimit},
              ${shape.perCustomerLimit}, ${shape.appliesTo}, ${shape.isActive}, ${ctx.userId}::uuid, ${ctx.userId}::uuid, now())
            returning id`),
        )[0].id;
        await this.writeTargets(tx, ctx.tenantId, id, shape);
        return this.detail(tx, ctx.tenantId, id);
      }),
    );
  }

  async update(
    ctx: OrgContext,
    id: string,
    dto: UpdateDiscountDto,
  ): Promise<DiscountDetailDto> {
    return mapErrors(() =>
      this.db.withUser(ctx.userId, async (tx) => {
        const current = await this.detail(tx, ctx.tenantId, id);
        const appliesTo = dto.appliesTo ?? current.appliesTo;
        const shape: Shape = {
          kind: dto.kind ?? current.kind,
          value: dto.value ?? current.value,
          minSubtotalMinor: dto.minSubtotalMinor ?? current.minSubtotalMinor,
          maxDiscountMinor:
            dto.maxDiscountMinor === undefined
              ? current.maxDiscountMinor
              : dto.maxDiscountMinor,
          startsAt: optionalDate(dto.startsAt, current.startsAt),
          expiresAt: optionalDate(dto.expiresAt, current.expiresAt),
          usageLimit:
            dto.usageLimit === undefined ? current.usageLimit : dto.usageLimit,
          perCustomerLimit:
            dto.perCustomerLimit === undefined
              ? current.perCustomerLimit
              : dto.perCustomerLimit,
          appliesTo,
          productIds: dto.productIds
            ? unique(dto.productIds)
            : current.products.map((p) => p.id),
          collectionIds: dto.collectionIds
            ? unique(dto.collectionIds)
            : current.collections.map((c) => c.id),
          campaignId:
            dto.campaignId === undefined ? current.campaignId : dto.campaignId,
          isActive: dto.isActive ?? current.isActive,
          description:
            dto.description === undefined
              ? current.description
              : dto.description,
        };
        // Targets that no longer apply are dropped rather than kept dormant.
        if (appliesTo !== 'products') shape.productIds = [];
        if (appliesTo !== 'collections') shape.collectionIds = [];
        checkShape(shape);
        await tx.execute(sql`
          update public.discount_codes set campaign_id = ${shape.campaignId}::uuid, description = ${shape.description},
            kind = ${shape.kind}, value = ${shape.value}, min_subtotal_minor = ${shape.minSubtotalMinor},
            max_discount_minor = ${shape.maxDiscountMinor}, starts_at = ${shape.startsAt}, expires_at = ${shape.expiresAt},
            usage_limit = ${shape.usageLimit}, per_customer_limit = ${shape.perCustomerLimit}, applies_to = ${shape.appliesTo},
            is_active = ${shape.isActive}, updated_by = ${ctx.userId}::uuid, updated_at = now()
          where tenant_id = ${ctx.tenantId}::uuid and id = ${id}::uuid`);
        await tx.execute(sql`
          delete from public.discount_code_targets where tenant_id = ${ctx.tenantId}::uuid and discount_id = ${id}::uuid`);
        await this.writeTargets(tx, ctx.tenantId, id, shape);
        return this.detail(tx, ctx.tenantId, id);
      }),
    );
  }

  /** A code that has been used is part of order history: it can be switched off but not deleted. */
  async remove(ctx: OrgContext, id: string): Promise<void> {
    await this.db.withUser(ctx.userId, async (tx) => {
      await this.detail(tx, ctx.tenantId, id);
      const used = rowsOf<{ n: number }>(
        await tx.execute(sql`
          select count(*)::int as n from public.discount_redemptions
          where tenant_id = ${ctx.tenantId}::uuid and discount_id = ${id}::uuid`),
      )[0].n;
      if (used > 0)
        throw conflict(
          'This code has been used on orders, so it cannot be deleted. Disable it instead.',
          undefined,
          'DISCOUNT_HAS_USE',
        );
      await tx.execute(sql`
        delete from public.discount_codes where tenant_id = ${ctx.tenantId}::uuid and id = ${id}::uuid`);
    });
  }

  private async writeTargets(
    tx: DbTx,
    tenantId: string,
    discountId: string,
    shape: Pick<Shape, 'productIds' | 'collectionIds'>,
  ) {
    for (const productId of shape.productIds)
      await tx.execute(sql`
        insert into public.discount_code_targets (tenant_id, discount_id, product_id)
        values (${tenantId}::uuid, ${discountId}::uuid, ${productId}::uuid)`);
    for (const collectionId of shape.collectionIds)
      await tx.execute(sql`
        insert into public.discount_code_targets (tenant_id, discount_id, collection_id)
        values (${tenantId}::uuid, ${discountId}::uuid, ${collectionId}::uuid)`);
  }
}
