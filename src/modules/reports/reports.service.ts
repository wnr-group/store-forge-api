import { Injectable } from '@nestjs/common';
import { sql, type SQL } from 'drizzle-orm';
import { notFound } from '../../common/app.exception.js';
import { Paginated } from '../../common/dto/api-response.dto.js';
import {
  resolveDayRange,
  withinRange,
  type DayRange,
} from '../../common/dto/date-range-query.dto.js';
import { likeTerm, offsetOf } from '../../common/dto/pagination-query.dto.js';
import type { OrgContext } from '../../common/interfaces/request-context.js';
import {
  DatabaseService,
  rowsOf,
  type DbTx,
} from '../../database/database.service.js';
import { REVENUE_ORDER_STATUSES } from '../../database/schema/enums.js';
import { safeTimeZone } from '../analytics/analytics.service.js';
import { getPrimaryStoreInTx } from '../store/store.service.js';
import type {
  CustomerHistoryDto,
  CustomerHistoryQueryDto,
  CustomerReportQueryDto,
  CustomerSummaryDto,
  ProductPerformanceDto,
  ProductReportQueryDto,
  ReportInterval,
  SalesComparisonDto,
  SalesFiguresDto,
  SalesPointDto,
  SalesQueryDto,
  SalesReportDto,
  TopCustomerDto,
  TopCustomerQueryDto,
} from './reports.dto.js';

/** The orders every sales figure is made of: see `SalesFiguresDto`. */
const revenue = sql.join(
  REVENUE_ORDER_STATUSES.map((s) => sql`${s}`),
  sql`, `,
);

const MAX_DAYS: Record<ReportInterval, number> = {
  day: 366,
  week: 1096,
  month: 1096,
};
const STEP: Record<ReportInterval, string> = {
  day: '1 day',
  week: '1 week',
  month: '1 month',
};
const DAY_MS = 86_400_000;

const pct = (now: number, before: number): number | null =>
  before === 0 ? null : Math.round(((now - before) / before) * 1000) / 10;
const round1 = (n: number) => Math.round(n * 10) / 10;

interface FigureRow {
  orders: number;
  gross: number;
  discounts: number;
  refunds: number;
  fees: number;
  tax: number;
  total: number;
}

const emptyRow = (): FigureRow => ({
  orders: 0,
  gross: 0,
  discounts: 0,
  refunds: 0,
  fees: 0,
  tax: 0,
  total: 0,
});

/** One place where the identities between the figures are written down. */
export function figuresOf(r: FigureRow): SalesFiguresDto {
  const orders = Number(r.orders);
  const gross = Number(r.gross);
  const discounts = Number(r.discounts);
  const refunds = Number(r.refunds);
  const total = Number(r.total);
  return {
    orders,
    grossSalesMinor: gross,
    discountsMinor: discounts,
    refundsMinor: refunds,
    netSalesMinor: gross - discounts - refunds,
    shippingAndFeesMinor: Number(r.fees),
    taxMinor: Number(r.tax),
    totalSalesMinor: total,
    netRevenueMinor: total - refunds,
    averageOrderValueMinor: orders > 0 ? Math.round(total / orders) : 0,
  };
}

export const sumRows = (rows: readonly FigureRow[]): FigureRow =>
  rows.reduce<FigureRow>((a, r) => {
    a.orders += Number(r.orders);
    a.gross += Number(r.gross);
    a.discounts += Number(r.discounts);
    a.refunds += Number(r.refunds);
    a.fees += Number(r.fees);
    a.tax += Number(r.tax);
    a.total += Number(r.total);
    return a;
  }, emptyRow());

const CHANGE_KEYS = [
  'orders',
  'grossSalesMinor',
  'discountsMinor',
  'refundsMinor',
  'netSalesMinor',
  'totalSalesMinor',
  'netRevenueMinor',
  'averageOrderValueMinor',
] as const;

export function compare(
  now: SalesFiguresDto,
  before: SalesFiguresDto,
): Record<string, number | null> {
  return Object.fromEntries(
    CHANGE_KEYS.map((k) => [k, pct(now[k], before[k])]),
  );
}

/** The period of equal length that ends the day before `range` starts. */
export function previousRange(range: DayRange): DayRange {
  const start = new Date(`${range.from}T00:00:00Z`).getTime();
  return {
    from: new Date(start - range.days * DAY_MS).toISOString().slice(0, 10),
    to: new Date(start - DAY_MS).toISOString().slice(0, 10),
    days: range.days,
  };
}

@Injectable()
export class ReportsService {
  constructor(private readonly db: DatabaseService) {}

  private async store(tx: DbTx, tenantId: string) {
    const store = await getPrimaryStoreInTx(tx, tenantId);
    if (!store)
      throw notFound(
        'This workspace does not have a store.',
        'STORE_NOT_FOUND',
      );
    return { tz: safeTimeZone(store.timezone), currency: store.currency };
  }

  // --- Sales and revenue -------------------------------------------------------------------------------------------------

  /** One row per day, week or month of the range, with no gaps. Refunds follow the period of their order. */
  private async series(
    tx: DbTx,
    tenantId: string,
    range: DayRange,
    tz: string,
    interval: ReportInterval,
  ) {
    const bucket = (col: SQL) =>
      sql`date_trunc(${interval}, (${col} at time zone ${tz})::date)::date`;
    const rows = rowsOf<FigureRow & { period: string }>(
      await tx.execute(sql`
        with periods as (
          select to_char(g::date, 'YYYY-MM-DD') as period, g::date as bucket
          from generate_series(date_trunc(${interval}, ${range.from}::date)::date, ${range.to}::date, ${STEP[interval]}::interval) g
        ),
        counted as (
          select o.id, o.placed_at, o.subtotal_minor, o.discount_minor, o.shipping_minor + o.cod_fee_minor as fees,
                 o.tax_minor, o.total_minor
          from public.orders o
          where o.tenant_id = ${tenantId}::uuid and o.status in (${revenue})
            and ${withinRange(sql`o.placed_at`, range, tz)}
        ),
        sales as (
          select ${bucket(sql`c.placed_at`)} as bucket, count(*)::int as orders, sum(c.subtotal_minor)::float8 as gross,
                 sum(c.discount_minor)::float8 as discounts, sum(c.fees)::float8 as fees, sum(c.tax_minor)::float8 as tax,
                 sum(c.total_minor)::float8 as total
          from counted c group by 1
        ),
        refunded as (
          select ${bucket(sql`c.placed_at`)} as bucket, sum(r.refunded_minor)::float8 as refunds
          from public.order_refund_totals(${tenantId}::uuid) r join counted c on c.id = r.order_id group by 1
        )
        select p.period, coalesce(s.orders, 0)::int as orders, coalesce(s.gross, 0)::float8 as gross,
               coalesce(s.discounts, 0)::float8 as discounts, coalesce(f.refunds, 0)::float8 as refunds,
               coalesce(s.fees, 0)::float8 as fees, coalesce(s.tax, 0)::float8 as tax, coalesce(s.total, 0)::float8 as total
        from periods p left join sales s on s.bucket = p.bucket left join refunded f on f.bucket = p.bucket
        order by p.bucket`),
    );
    return rows;
  }

  /** Totals only, for the comparison period (no series, so no limit on how it is cut). */
  private async totals(
    tx: DbTx,
    tenantId: string,
    range: DayRange,
    tz: string,
  ): Promise<SalesFiguresDto> {
    const r = rowsOf<FigureRow>(
      await tx.execute(sql`
        select count(*)::int as orders, coalesce(sum(o.subtotal_minor), 0)::float8 as gross,
               coalesce(sum(o.discount_minor), 0)::float8 as discounts,
               coalesce(sum(o.shipping_minor + o.cod_fee_minor), 0)::float8 as fees,
               coalesce(sum(o.tax_minor), 0)::float8 as tax, coalesce(sum(o.total_minor), 0)::float8 as total,
               coalesce((select sum(r.refunded_minor) from public.order_refund_totals(${tenantId}::uuid) r
                         join public.orders ro on ro.id = r.order_id and ro.tenant_id = ${tenantId}::uuid
                         where ro.status in (${revenue}) and ${withinRange(sql`ro.placed_at`, range, tz)}), 0)::float8 as refunds
        from public.orders o
        where o.tenant_id = ${tenantId}::uuid and o.status in (${revenue}) and ${withinRange(sql`o.placed_at`, range, tz)}`),
    )[0];
    return figuresOf(r);
  }

  async sales(ctx: OrgContext, q: SalesQueryDto): Promise<SalesReportDto> {
    return this.db.withUser(ctx.userId, async (tx) => {
      const { tz, currency } = await this.store(tx, ctx.tenantId);
      const range = resolveDayRange(q, tz, {
        defaultDays: 30,
        maxDays: MAX_DAYS[q.interval],
      });
      const prev = previousRange(range);
      const [rows, previous] = await Promise.all([
        this.series(tx, ctx.tenantId, range, tz, q.interval),
        this.totals(tx, ctx.tenantId, prev, tz),
      ]);
      const series: SalesPointDto[] = rows.map((r) =>
        Object.assign(figuresOf(r), { period: r.period }),
      );
      const totals = figuresOf(sumRows(rows));
      const previousDto: SalesComparisonDto = {
        from: prev.from,
        to: prev.to,
        figures: previous,
        changePercent: compare(totals, previous),
      };
      return {
        from: range.from,
        to: range.to,
        interval: q.interval,
        currency,
        timeZone: tz,
        totals,
        previous: previousDto,
        series,
      };
    });
  }

  // --- Products ----------------------------------------------------------------------------------------------------------

  async products(
    ctx: OrgContext,
    q: ProductReportQueryDto,
  ): Promise<Paginated<ProductPerformanceDto>> {
    return this.db.withUser(ctx.userId, async (tx) => {
      const { tz } = await this.store(tx, ctx.tenantId);
      const range = resolveDayRange(q, tz);
      const dir = q.sortOrder === 'asc' ? sql`asc` : sql`desc`;
      const key =
        q.sortBy === 'revenue'
          ? sql`revenue`
          : q.sortBy === 'orders'
            ? sql`orders`
            : sql`units`;
      const search = q.search
        ? sql`and (p.name ilike ${likeTerm(q.search)} or p.slug ilike ${likeTerm(q.search)})`
        : sql``;
      // Products that sold, plus every active product (so the worst performers include the ones nobody bought).
      const base = sql`
        with sold as (
          select i.product_id, sum(i.quantity)::int as units, sum(i.total_minor)::float8 as revenue,
                 count(distinct i.order_id)::int as orders
          from public.order_items i join public.orders o on o.tenant_id = i.tenant_id and o.id = i.order_id
          where i.tenant_id = ${ctx.tenantId}::uuid and i.product_id is not null and o.status in (${revenue})
            and ${withinRange(sql`o.placed_at`, range, tz)}
          group by i.product_id
        )
        select p.id, p.name, p.slug, p.status, coalesce(s.units, 0)::int as units, coalesce(s.revenue, 0)::float8 as revenue,
               coalesce(s.orders, 0)::int as orders
        from public.products p left join sold s on s.product_id = p.id
        where p.tenant_id = ${ctx.tenantId}::uuid and (p.status = 'active' or s.product_id is not null) ${search}`;
      const [rows, total] = await Promise.all([
        tx.execute(sql`
          select * from (${base}) x order by ${key} ${dir}, revenue ${dir}, name asc, id asc
          limit ${q.limit} offset ${offsetOf(q)}`),
        tx.execute(sql`select count(*)::int as n from (${base}) x`),
      ]);
      return new Paginated(
        rowsOf<{
          id: string;
          name: string;
          slug: string;
          status: string;
          units: number;
          revenue: number;
          orders: number;
        }>(rows).map((r) => ({
          productId: r.id,
          name: r.name,
          slug: r.slug,
          status: r.status,
          unitsSold: r.units,
          revenueMinor: Number(r.revenue),
          orders: r.orders,
          conversionRatePercent: null,
        })),
        {
          page: q.page,
          limit: q.limit,
          total: rowsOf<{ n: number }>(total)[0].n,
        },
      );
    });
  }

  // --- Customers ---------------------------------------------------------------------------------------------------------

  async customerSummary(
    ctx: OrgContext,
    q: CustomerReportQueryDto,
  ): Promise<CustomerSummaryDto> {
    return this.db.withUser(ctx.userId, async (tx) => {
      const { tz } = await this.store(tx, ctx.tenantId);
      const range = resolveDayRange(q, tz);
      const inRange = withinRange(sql`o.placed_at`, range, tz);
      const before = sql`o.placed_at < (${range.from}::date)::timestamp at time zone ${tz}`;
      const r = rowsOf<{
        total_customers: number;
        new_customers: number;
        buyers: number;
        returning: number;
        orders_in_range: number;
        spend_in_range: number;
        ever: number;
        repeat: number;
      }>(
        await tx.execute(sql`
          with per as (
            select o.customer_id,
                   count(*) filter (where ${inRange})::int as in_range,
                   coalesce(sum(o.total_minor) filter (where ${inRange}), 0)::float8 as spend,
                   count(*) filter (where ${before})::int as prior,
                   count(*)::int as everything
            from public.orders o
            where o.tenant_id = ${ctx.tenantId}::uuid and o.customer_id is not null and o.status in (${revenue})
            group by o.customer_id
          )
          select
            (select count(*)::int from public.customers where tenant_id = ${ctx.tenantId}::uuid) as total_customers,
            (select count(*)::int from public.customers c where c.tenant_id = ${ctx.tenantId}::uuid
               and ${withinRange(sql`c.created_at`, range, tz)}) as new_customers,
            count(*) filter (where in_range > 0)::int as buyers,
            count(*) filter (where in_range > 0 and prior > 0)::int as returning,
            coalesce(sum(in_range), 0)::int as orders_in_range,
            coalesce(sum(spend), 0)::float8 as spend_in_range,
            count(*)::int as ever,
            count(*) filter (where everything >= 2)::int as repeat
          from per`),
      )[0];
      return {
        from: range.from,
        to: range.to,
        totalCustomers: r.total_customers,
        newCustomers: r.new_customers,
        buyers: r.buyers,
        firstTimeBuyers: r.buyers - r.returning,
        returningCustomers: r.returning,
        repeatPurchaseRatePercent:
          r.ever === 0 ? 0 : round1((r.repeat / r.ever) * 100),
        averageOrdersPerBuyer:
          r.buyers === 0 ? 0 : round1(r.orders_in_range / r.buyers),
        averageSpendPerBuyerMinor:
          r.buyers === 0 ? 0 : Math.round(Number(r.spend_in_range) / r.buyers),
        averageOrderValueMinor:
          r.orders_in_range === 0
            ? 0
            : Math.round(Number(r.spend_in_range) / r.orders_in_range),
      };
    });
  }

  async topCustomers(
    ctx: OrgContext,
    q: TopCustomerQueryDto,
  ): Promise<Paginated<TopCustomerDto>> {
    return this.db.withUser(ctx.userId, async (tx) => {
      const { tz } = await this.store(tx, ctx.tenantId);
      const range = resolveDayRange(q, tz);
      const dir = q.sortOrder === 'asc' ? sql`asc` : sql`desc`;
      const key = q.sortBy === 'orders' ? sql`orders` : sql`revenue`;
      const search = q.search
        ? sql`and (c.full_name ilike ${likeTerm(q.search)} or c.email ilike ${likeTerm(q.search)})`
        : sql``;
      const base = sql`
        select c.id, c.full_name, c.email, count(*)::int as orders, sum(o.total_minor)::float8 as revenue, max(o.placed_at) as last_order_at
        from public.customers c join public.orders o on o.tenant_id = c.tenant_id and o.customer_id = c.id
        where c.tenant_id = ${ctx.tenantId}::uuid and o.status in (${revenue}) and ${withinRange(sql`o.placed_at`, range, tz)} ${search}
        group by c.id, c.full_name, c.email`;
      const [rows, total] = await Promise.all([
        tx.execute(sql`
          select * from (${base}) x order by ${key} ${dir}, revenue ${dir}, id asc limit ${q.limit} offset ${offsetOf(q)}`),
        tx.execute(sql`select count(*)::int as n from (${base}) x`),
      ]);
      return new Paginated(
        rowsOf<{
          id: string;
          full_name: string;
          email: string;
          orders: number;
          revenue: number;
          last_order_at: string | Date;
        }>(rows).map((r) => ({
          customerId: r.id,
          fullName: r.full_name,
          email: r.email,
          orders: r.orders,
          revenueMinor: Number(r.revenue),
          lastOrderAt: new Date(r.last_order_at),
        })),
        {
          page: q.page,
          limit: q.limit,
          total: rowsOf<{ n: number }>(total)[0].n,
        },
      );
    });
  }

  async customerHistory(
    ctx: OrgContext,
    id: string,
    q: CustomerHistoryQueryDto,
  ): Promise<CustomerHistoryDto> {
    return this.db.withUser(ctx.userId, async (tx) => {
      const c = rowsOf<{
        id: string;
        full_name: string;
        email: string;
        lifetime_orders: number;
        lifetime_revenue: number;
        first_order_at: string | Date | null;
        last_order_at: string | Date | null;
        total_orders: number;
      }>(
        await tx.execute(sql`
          select c.id, c.full_name, c.email,
            (select count(*)::int from public.orders o where o.tenant_id = c.tenant_id and o.customer_id = c.id and o.status in (${revenue})) as lifetime_orders,
            (select coalesce(sum(o.total_minor), 0)::float8 from public.orders o where o.tenant_id = c.tenant_id and o.customer_id = c.id and o.status in (${revenue})) as lifetime_revenue,
            (select min(o.placed_at) from public.orders o where o.tenant_id = c.tenant_id and o.customer_id = c.id and o.status in (${revenue})) as first_order_at,
            (select max(o.placed_at) from public.orders o where o.tenant_id = c.tenant_id and o.customer_id = c.id and o.status in (${revenue})) as last_order_at,
            (select count(*)::int from public.orders o where o.tenant_id = c.tenant_id and o.customer_id = c.id) as total_orders
          from public.customers c where c.tenant_id = ${ctx.tenantId}::uuid and c.id = ${id}::uuid`),
      )[0];
      if (!c)
        throw notFound('That customer no longer exists.', 'CUSTOMER_NOT_FOUND');
      const orders = rowsOf<{
        id: string;
        order_number: number;
        status: string;
        payment_status: string;
        item_count: number;
        discount_minor: number;
        total_minor: number;
        placed_at: string | Date;
      }>(
        await tx.execute(sql`
          select o.id, o.order_number, o.status, o.payment_status, o.discount_minor::float8 as discount_minor,
                 o.total_minor::float8 as total_minor, o.placed_at,
                 coalesce((select sum(i.quantity) from public.order_items i where i.tenant_id = o.tenant_id and i.order_id = o.id), 0)::int as item_count
          from public.orders o where o.tenant_id = ${ctx.tenantId}::uuid and o.customer_id = ${id}::uuid
          order by o.placed_at desc, o.id desc limit ${q.limit} offset ${offsetOf(q)}`),
      );
      const counted = new Set<string>(REVENUE_ORDER_STATUSES);
      return {
        customerId: c.id,
        fullName: c.full_name,
        email: c.email,
        lifetimeOrders: c.lifetime_orders,
        lifetimeRevenueMinor: Number(c.lifetime_revenue),
        averageOrderValueMinor:
          c.lifetime_orders === 0
            ? 0
            : Math.round(Number(c.lifetime_revenue) / c.lifetime_orders),
        firstOrderAt: c.first_order_at ? new Date(c.first_order_at) : null,
        lastOrderAt: c.last_order_at ? new Date(c.last_order_at) : null,
        orders: orders.map((o) => ({
          id: o.id,
          orderNumber: o.order_number,
          status: o.status,
          paymentStatus: o.payment_status,
          itemCount: o.item_count,
          discountMinor: Number(o.discount_minor),
          totalMinor: Number(o.total_minor),
          countsAsSale: counted.has(o.status),
          placedAt: new Date(o.placed_at),
        })),
        page: q.page,
        limit: q.limit,
        totalOrders: c.total_orders,
      };
    });
  }
}
