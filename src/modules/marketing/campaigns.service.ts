import { Injectable } from '@nestjs/common';
import { sql, type SQL } from 'drizzle-orm';
import { conflict, invalid, notFound } from '../../common/app.exception.js';
import { mapErrors } from '../../common/db-errors.js';
import { Paginated } from '../../common/dto/api-response.dto.js';
import { likeTerm, offsetOf } from '../../common/dto/pagination-query.dto.js';
import type { OrgContext } from '../../common/interfaces/request-context.js';
import {
  DatabaseService,
  rowsOf,
  type DbTx,
} from '../../database/database.service.js';
import { REVENUE_ORDER_STATUSES } from '../../database/schema/enums.js';
import type {
  CampaignDetailDto,
  CampaignDto,
  CampaignListQueryDto,
  CreateCampaignDto,
  UpdateCampaignDto,
} from './campaigns.dto.js';
import { campaignPhase, canMoveCampaign } from './discount-rules.js';

const revenue = sql.join(
  REVENUE_ORDER_STATUSES.map((s) => sql`${s}`),
  sql`, `,
);

const notFoundError = () =>
  notFound('That campaign no longer exists.', 'CAMPAIGN_NOT_FOUND');

interface Row {
  id: string;
  name: string;
  description: string | null;
  status: 'draft' | 'active' | 'paused' | 'completed';
  starts_at: string | Date | null;
  ends_at: string | Date | null;
  created_at: string | Date;
  updated_at: string | Date;
  discount_codes: number;
  in_use: number;
  discount_total: number;
  paid_orders: number;
  gross: number;
  net: number;
}

const date = (v: string | Date | null) => (v ? new Date(v) : null);

const toDto = (r: Row, now = new Date()): CampaignDto => {
  const window = {
    status: r.status,
    startsAt: date(r.starts_at),
    endsAt: date(r.ends_at),
  };
  return {
    id: r.id,
    name: r.name,
    description: r.description,
    status: r.status,
    phase: campaignPhase(window, now),
    startsAt: window.startsAt,
    endsAt: window.endsAt,
    performance: {
      discountCodes: Number(r.discount_codes),
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
  };
};

const unique = (ids: string[] | undefined) => [...new Set(ids ?? [])];

@Injectable()
export class CampaignsService {
  constructor(private readonly db: DatabaseService) {}

  /** Campaigns with the performance of every code that belongs to them, from the real orders that used those codes. */
  private baseQuery(tenantId: string, where: SQL) {
    return sql`
      select c.id, c.name, c.description, c.status, c.starts_at, c.ends_at, c.created_at, c.updated_at,
        (select count(*)::int from public.discount_codes d where d.tenant_id = c.tenant_id and d.campaign_id = c.id) as discount_codes,
        coalesce(u.in_use, 0)::int as in_use, coalesce(u.discount_total, 0)::float8 as discount_total,
        coalesce(u.paid_orders, 0)::int as paid_orders, coalesce(u.gross, 0)::float8 as gross, coalesce(u.net, 0)::float8 as net
      from public.promotional_campaigns c
      left join lateral (
        select count(*) filter (where o.status not in ('cancelled', 'failed')) as in_use,
               sum(r.discount_minor) filter (where o.status not in ('cancelled', 'failed')) as discount_total,
               count(*) filter (where o.status in (${revenue})) as paid_orders,
               sum(o.subtotal_minor) filter (where o.status in (${revenue})) as gross,
               sum(o.subtotal_minor - o.discount_minor) filter (where o.status in (${revenue})) as net
        from public.discount_codes d
        join public.discount_redemptions r on r.tenant_id = d.tenant_id and r.discount_id = d.id
        join public.orders o on o.tenant_id = r.tenant_id and o.id = r.order_id
        where d.tenant_id = c.tenant_id and d.campaign_id = c.id
      ) u on true
      where c.tenant_id = ${tenantId}::uuid and ${where}`;
  }

  async list(
    ctx: OrgContext,
    q: CampaignListQueryDto,
  ): Promise<Paginated<CampaignDto>> {
    return this.db.withUser(ctx.userId, async (tx) => {
      const filters: SQL[] = [sql`true`];
      if (q.search) filters.push(sql`c.name ilike ${likeTerm(q.search)}`);
      if (q.status) filters.push(sql`c.status = ${q.status}`);
      const where = sql.join(filters, sql` and `);
      const dir = q.sortOrder === 'asc' ? sql`asc` : sql`desc`;
      const order =
        q.sortBy === 'name'
          ? sql`s.name ${dir}`
          : q.sortBy === 'startsAt'
            ? sql`s.starts_at ${dir} nulls last`
            : sql`s.created_at ${dir}`;
      const base = this.baseQuery(ctx.tenantId, where);
      const [rows, total] = await Promise.all([
        tx.execute(sql`
          select s.* from (${base}) s order by ${order} limit ${q.limit} offset ${offsetOf(q)}`),
        tx.execute(sql`
          select count(*)::int as n from public.promotional_campaigns c where c.tenant_id = ${ctx.tenantId}::uuid and ${where}`),
      ]);
      const now = new Date();
      return new Paginated(
        rowsOf<Row>(rows).map((r) => toDto(r, now)),
        {
          page: q.page,
          limit: q.limit,
          total: rowsOf<{ n: number }>(total)[0].n,
        },
      );
    });
  }

  async get(ctx: OrgContext, id: string): Promise<CampaignDetailDto> {
    return this.db.withUser(ctx.userId, (tx) =>
      this.detail(tx, ctx.tenantId, id),
    );
  }

  private async detail(
    tx: DbTx,
    tenantId: string,
    id: string,
  ): Promise<CampaignDetailDto> {
    const row = rowsOf<Row>(
      await tx.execute(
        sql`select s.* from (${this.baseQuery(tenantId, sql`c.id = ${id}::uuid`)}) s`,
      ),
    )[0];
    if (!row) throw notFoundError();
    const [products, collections, discounts] = await Promise.all([
      tx.execute(sql`
        select p.id, p.name from public.campaign_targets t
        join public.products p on p.tenant_id = t.tenant_id and p.id = t.product_id
        where t.tenant_id = ${tenantId}::uuid and t.campaign_id = ${id}::uuid order by p.name`),
      tx.execute(sql`
        select c.id, c.name from public.campaign_targets t
        join public.collections c on c.tenant_id = t.tenant_id and c.id = t.collection_id
        where t.tenant_id = ${tenantId}::uuid and t.campaign_id = ${id}::uuid order by c.name`),
      tx.execute(sql`
        select id, code, is_active as "isActive" from public.discount_codes
        where tenant_id = ${tenantId}::uuid and campaign_id = ${id}::uuid order by code`),
    ]);
    return Object.assign(toDto(row), {
      products: rowsOf<{ id: string; name: string }>(products),
      collections: rowsOf<{ id: string; name: string }>(collections),
      discounts: rowsOf<{ id: string; code: string; isActive: boolean }>(
        discounts,
      ),
    });
  }

  async create(
    ctx: OrgContext,
    dto: CreateCampaignDto,
  ): Promise<CampaignDetailDto> {
    const startsAt = dto.startsAt ? new Date(dto.startsAt) : null;
    const endsAt = dto.endsAt ? new Date(dto.endsAt) : null;
    this.checkWindow(startsAt, endsAt);
    return mapErrors(() =>
      this.db.withUser(ctx.userId, async (tx) => {
        const id = rowsOf<{ id: string }>(
          await tx.execute(sql`
            insert into public.promotional_campaigns (tenant_id, name, description, status, starts_at, ends_at, created_by, updated_by, updated_at)
            values (${ctx.tenantId}::uuid, ${dto.name}, ${dto.description ?? null}, 'draft', ${startsAt}, ${endsAt},
              ${ctx.userId}::uuid, ${ctx.userId}::uuid, now())
            returning id`),
        )[0].id;
        await this.writeTargets(
          tx,
          ctx.tenantId,
          id,
          unique(dto.productIds),
          unique(dto.collectionIds),
        );
        await this.assignDiscounts(tx, ctx, id, unique(dto.discountIds));
        return this.detail(tx, ctx.tenantId, id);
      }),
    );
  }

  async update(
    ctx: OrgContext,
    id: string,
    dto: UpdateCampaignDto,
  ): Promise<CampaignDetailDto> {
    return mapErrors(() =>
      this.db.withUser(ctx.userId, async (tx) => {
        const current = await this.detail(tx, ctx.tenantId, id);
        if (current.status === 'completed')
          throw conflict(
            'A completed campaign cannot be changed.',
            undefined,
            'CAMPAIGN_COMPLETED',
          );
        const startsAt =
          dto.startsAt === undefined
            ? current.startsAt
            : dto.startsAt
              ? new Date(dto.startsAt)
              : null;
        const endsAt =
          dto.endsAt === undefined
            ? current.endsAt
            : dto.endsAt
              ? new Date(dto.endsAt)
              : null;
        this.checkWindow(startsAt, endsAt);
        await tx.execute(sql`
          update public.promotional_campaigns set name = ${dto.name ?? current.name},
            description = ${dto.description === undefined ? current.description : dto.description},
            starts_at = ${startsAt}, ends_at = ${endsAt}, updated_by = ${ctx.userId}::uuid, updated_at = now()
          where tenant_id = ${ctx.tenantId}::uuid and id = ${id}::uuid`);
        if (dto.productIds || dto.collectionIds) {
          await tx.execute(sql`
            delete from public.campaign_targets where tenant_id = ${ctx.tenantId}::uuid and campaign_id = ${id}::uuid`);
          await this.writeTargets(
            tx,
            ctx.tenantId,
            id,
            dto.productIds
              ? unique(dto.productIds)
              : current.products.map((p) => p.id),
            dto.collectionIds
              ? unique(dto.collectionIds)
              : current.collections.map((c) => c.id),
          );
        }
        if (dto.discountIds)
          await this.assignDiscounts(tx, ctx, id, unique(dto.discountIds));
        return this.detail(tx, ctx.tenantId, id);
      }),
    );
  }

  /** Activate, pause or complete. A completed campaign never restarts. */
  async setStatus(
    ctx: OrgContext,
    id: string,
    status: 'draft' | 'active' | 'paused' | 'completed',
  ): Promise<CampaignDetailDto> {
    return this.db.withUser(ctx.userId, async (tx) => {
      const current = await this.detail(tx, ctx.tenantId, id);
      if (current.status === status) return current;
      if (!canMoveCampaign(current.status as 'draft', status))
        throw conflict(
          `A ${current.status} campaign cannot become ${status}.`,
          undefined,
          'CAMPAIGN_STATUS_INVALID',
        );
      if (status === 'active' && current.endsAt && current.endsAt <= new Date())
        throw invalid(
          'This campaign has already passed its end date. Change the end date first.',
          { endsAt: 'The end date is in the past.' },
          'CAMPAIGN_ENDED',
        );
      await tx.execute(sql`
        update public.promotional_campaigns set status = ${status}, updated_by = ${ctx.userId}::uuid, updated_at = now()
        where tenant_id = ${ctx.tenantId}::uuid and id = ${id}::uuid`);
      return this.detail(tx, ctx.tenantId, id);
    });
  }

  /** Deleting a campaign keeps its codes (they just leave the campaign). */
  async remove(ctx: OrgContext, id: string): Promise<void> {
    await this.db.withUser(ctx.userId, async (tx) => {
      await this.detail(tx, ctx.tenantId, id);
      await tx.execute(sql`
        delete from public.promotional_campaigns where tenant_id = ${ctx.tenantId}::uuid and id = ${id}::uuid`);
    });
  }

  private checkWindow(startsAt: Date | null, endsAt: Date | null) {
    if (startsAt && endsAt && endsAt <= startsAt)
      throw invalid(
        'The end must be after the start.',
        { endsAt: 'The end must be after the start.' },
        'CAMPAIGN_WINDOW_INVALID',
      );
  }

  private async writeTargets(
    tx: DbTx,
    tenantId: string,
    campaignId: string,
    productIds: string[],
    collectionIds: string[],
  ) {
    for (const productId of productIds)
      await tx.execute(sql`
        insert into public.campaign_targets (tenant_id, campaign_id, product_id)
        values (${tenantId}::uuid, ${campaignId}::uuid, ${productId}::uuid)`);
    for (const collectionId of collectionIds)
      await tx.execute(sql`
        insert into public.campaign_targets (tenant_id, campaign_id, collection_id)
        values (${tenantId}::uuid, ${campaignId}::uuid, ${collectionId}::uuid)`);
  }

  /** Makes exactly `discountIds` the codes of the campaign. Every id must be one of this store's codes. */
  private async assignDiscounts(
    tx: DbTx,
    ctx: OrgContext,
    campaignId: string,
    discountIds: string[],
  ) {
    if (discountIds.length > 0) {
      const found = rowsOf<{ n: number }>(
        await tx.execute(sql`
          select count(*)::int as n from public.discount_codes
          where tenant_id = ${ctx.tenantId}::uuid and id in (${sql.join(
            discountIds.map((d) => sql`${d}::uuid`),
            sql`, `,
          )})`),
      )[0].n;
      if (found !== discountIds.length)
        throw invalid(
          'One of the selected discount codes no longer exists.',
          { discountIds: 'Choose codes from your store.' },
          'DISCOUNT_NOT_FOUND',
        );
    }
    await tx.execute(sql`
      update public.discount_codes set campaign_id = null, updated_by = ${ctx.userId}::uuid, updated_at = now()
      where tenant_id = ${ctx.tenantId}::uuid and campaign_id = ${campaignId}::uuid
        ${
          discountIds.length > 0
            ? sql`and id not in (${sql.join(
                discountIds.map((d) => sql`${d}::uuid`),
                sql`, `,
              )})`
            : sql``
        }`);
    if (discountIds.length > 0)
      await tx.execute(sql`
        update public.discount_codes set campaign_id = ${campaignId}::uuid, updated_by = ${ctx.userId}::uuid, updated_at = now()
        where tenant_id = ${ctx.tenantId}::uuid and id in (${sql.join(
          discountIds.map((d) => sql`${d}::uuid`),
          sql`, `,
        )})`);
  }
}
