import { Injectable } from '@nestjs/common';
import { sql, type SQL } from 'drizzle-orm';
import { forbidden, notFound } from '../../common/app.exception.js';
import { Paginated } from '../../common/dto/api-response.dto.js';
import {
  resolveDayRange,
  withinRange,
} from '../../common/dto/date-range-query.dto.js';
import { likeTerm, offsetOf } from '../../common/dto/pagination-query.dto.js';
import type { OrgContext } from '../../common/interfaces/request-context.js';
import {
  DatabaseService,
  rowsOf,
  type DbTx,
} from '../../database/database.service.js';
import { safeTimeZone } from '../analytics/analytics.service.js';
import { getPrimaryStoreInTx } from '../store/store.service.js';
import { CredentialsKeyError } from '../payments/credentials-key.js';
import type {
  AbandonedCartDetailDto,
  AbandonedCartDto,
  AbandonedCartListQueryDto,
  AbandonedCartSettingsDto,
  AbandonedCartSummaryDto,
  AbandonedCartSummaryQueryDto,
  SaveAbandonedCartSettingsDto,
} from './abandoned-carts.dto.js';
import { recoveryTokenFor } from './recovery-token.js';

export const DEFAULT_THRESHOLD_MINUTES = 60;
export const DEFAULT_LINK_DAYS = 14;

const notFoundError = () =>
  notFound('That cart no longer exists.', 'ABANDONED_CART_NOT_FOUND');

interface Row {
  id: string;
  email: string | null;
  customer_name: string | null;
  phone: string | null;
  items:
    | {
        name: string;
        productSlug?: string;
        variantId?: string | null;
        quantity: number;
        unitPriceMinor: number;
      }[]
    | string;
  item_count: number;
  cart_value_minor: number;
  currency: string;
  eff_status: 'active' | 'abandoned' | 'recovered' | 'expired';
  last_activity_at: string | Date;
  eff_abandoned_at: string | Date | null;
  recovered_at: string | Date | null;
  recovered_order_number: number | null;
  recovery_clicks: number;
  marketing_consent: boolean;
}

const date = (v: string | Date | null) => (v ? new Date(v) : null);

const toDto = (r: Row): AbandonedCartDto => ({
  id: r.id,
  email: r.email,
  customerName: r.customer_name,
  phone: r.phone,
  itemCount: r.item_count,
  cartValueMinor: Number(r.cart_value_minor),
  currency: r.currency,
  status: r.eff_status,
  lastActivityAt: new Date(r.last_activity_at),
  // Only a cart that counts as abandoned has an abandonment date.
  abandonedAt: r.eff_status === 'active' ? null : date(r.eff_abandoned_at),
  recoveredAt: date(r.recovered_at),
  recoveredOrderNumber: r.recovered_order_number,
  recoveryClicks: r.recovery_clicks,
  marketingConsent: r.marketing_consent,
  canContact: r.marketing_consent && !!r.email,
});

/**
 * Carts with the abandonment rules applied: a stored cart is `recovered` once its shopper bought; otherwise it is `active` until it
 * has been idle for the threshold, `abandoned` after that, and `expired` once it is older than the recovery window. Worked out
 * here, from the tenant's current settings, so a changed threshold applies to carts already waiting.
 */
/** The columns the dashboard may read (the hashes used to look carts up are not granted to anyone). */
const CART_COLUMNS = sql.raw(
  [
    'id',
    'tenant_id',
    'customer_id',
    'email',
    'phone',
    'customer_name',
    'marketing_consent',
    'items',
    'item_count',
    'cart_value_minor',
    'currency',
    'status',
    'last_activity_at',
    'abandoned_at',
    'recovered_at',
    'recovered_order_id',
    'recovery_clicks',
    'created_at',
    'updated_at',
  ]
    .map((c) => `c.${c}`)
    .join(', '),
);

const cartsSql = (tenantId: string) => sql`
  select ${CART_COLUMNS},
    case when c.status = 'recovered' then 'recovered'
         when c.last_activity_at > now() - make_interval(mins => s.threshold) then 'active'
         when c.last_activity_at <= now() - make_interval(days => s.link_days) then 'expired'
         else 'abandoned' end as eff_status,
    c.last_activity_at + make_interval(mins => s.threshold) as eff_abandoned_at,
    o.order_number as recovered_order_number,
    o.total_minor as recovered_total_minor
  from public.abandoned_carts c
  cross join (
    select coalesce((select abandonment_threshold_minutes from public.tenant_marketing_settings where tenant_id = ${tenantId}::uuid), ${DEFAULT_THRESHOLD_MINUTES}) as threshold,
           coalesce((select recovery_link_days from public.tenant_marketing_settings where tenant_id = ${tenantId}::uuid), ${DEFAULT_LINK_DAYS}) as link_days
  ) s
  left join public.orders o on o.tenant_id = c.tenant_id and o.id = c.recovered_order_id
  where c.tenant_id = ${tenantId}::uuid`;

@Injectable()
export class AbandonedCartsService {
  constructor(private readonly db: DatabaseService) {}

  private async timeZone(tx: DbTx, tenantId: string) {
    const store = await getPrimaryStoreInTx(tx, tenantId);
    return safeTimeZone(store?.timezone ?? 'UTC');
  }

  async list(
    ctx: OrgContext,
    q: AbandonedCartListQueryDto,
  ): Promise<Paginated<AbandonedCartDto>> {
    return this.db.withUser(ctx.userId, async (tx) => {
      const filters: SQL[] = [sql`true`];
      if (q.status) filters.push(sql`x.eff_status = ${q.status}`);
      if (q.search)
        filters.push(
          sql`(x.email ilike ${likeTerm(q.search)} or x.customer_name ilike ${likeTerm(q.search)})`,
        );
      if (q.from || q.to) {
        const tz = await this.timeZone(tx, ctx.tenantId);
        const range = resolveDayRange({ from: q.from, to: q.to }, tz, {
          defaultDays: 30,
          maxDays: 366,
        });
        filters.push(withinRange(sql`x.last_activity_at`, range, tz));
      }
      const where = sql.join(filters, sql` and `);
      const dir = q.sortOrder === 'asc' ? sql`asc` : sql`desc`;
      const order =
        q.sortBy === 'cartValue'
          ? sql`x.cart_value_minor ${dir}, x.last_activity_at desc`
          : sql`x.last_activity_at ${dir}`;
      const base = cartsSql(ctx.tenantId);
      const [rows, total] = await Promise.all([
        tx.execute(sql`
          select x.* from (${base}) x where ${where} order by ${order} limit ${q.limit} offset ${offsetOf(q)}`),
        tx.execute(
          sql`select count(*)::int as n from (${base}) x where ${where}`,
        ),
      ]);
      return new Paginated(rowsOf<Row>(rows).map(toDto), {
        page: q.page,
        limit: q.limit,
        total: rowsOf<{ n: number }>(total)[0].n,
      });
    });
  }

  async get(ctx: OrgContext, id: string): Promise<AbandonedCartDetailDto> {
    return this.db.withUser(ctx.userId, async (tx) => {
      const row = rowsOf<Row>(
        await tx.execute(
          sql`select x.* from (${cartsSql(ctx.tenantId)}) x where x.id = ${id}::uuid`,
        ),
      )[0];
      if (!row) throw notFoundError();
      const store = await getPrimaryStoreInTx(tx, ctx.tenantId);
      const items =
        typeof row.items === 'string'
          ? (JSON.parse(row.items) as Row['items'])
          : row.items;
      let recoveryPath: string | null = null;
      if (
        store &&
        (row.eff_status === 'active' || row.eff_status === 'abandoned')
      ) {
        try {
          recoveryPath = `/s/${store.slug}/cart?recover=${recoveryTokenFor(ctx.tenantId, row.id)}`;
        } catch (error) {
          // No master key on the server: the cart is still shown, just without a link.
          if (!(error instanceof CredentialsKeyError)) throw error;
        }
      }
      return Object.assign(toDto(row), {
        items: (items as Exclude<Row['items'], string>).map((i) => ({
          name: i.name,
          productSlug: i.productSlug,
          variantId: i.variantId ?? null,
          quantity: i.quantity,
          unitPriceMinor: Number(i.unitPriceMinor),
        })),
        recoveryPath,
      });
    });
  }

  async summary(
    ctx: OrgContext,
    q: AbandonedCartSummaryQueryDto,
  ): Promise<AbandonedCartSummaryDto> {
    return this.db.withUser(ctx.userId, async (tx) => {
      const tz = await this.timeZone(tx, ctx.tenantId);
      const range = resolveDayRange(q, tz);
      const r = rowsOf<{
        abandoned_count: number;
        abandoned_value: number;
        recovered_count: number;
        recovered_value: number;
        active_count: number;
      }>(
        await tx.execute(sql`
          select
            count(*) filter (where x.eff_status in ('abandoned', 'expired'))::int as abandoned_count,
            coalesce(sum(x.cart_value_minor) filter (where x.eff_status in ('abandoned', 'expired')), 0)::float8 as abandoned_value,
            count(*) filter (where x.eff_status = 'recovered')::int as recovered_count,
            coalesce(sum(x.recovered_total_minor) filter (where x.eff_status = 'recovered'), 0)::float8 as recovered_value,
            count(*) filter (where x.eff_status = 'active')::int as active_count
          from (${cartsSql(ctx.tenantId)}) x
          where ${withinRange(sql`x.last_activity_at`, range, tz)}`),
      )[0];
      const lost = r.abandoned_count + r.recovered_count;
      return {
        from: range.from,
        to: range.to,
        abandonedCount: r.abandoned_count,
        abandonedValueMinor: Number(r.abandoned_value),
        recoveredCount: r.recovered_count,
        recoveredValueMinor: Number(r.recovered_value),
        recoveryRatePercent:
          lost === 0 ? 0 : Math.round((r.recovered_count / lost) * 1000) / 10,
        activeCount: r.active_count,
      };
    });
  }

  async settings(ctx: OrgContext): Promise<AbandonedCartSettingsDto> {
    return this.db.withUser(ctx.userId, async (tx) => {
      const r = rowsOf<{
        abandonment_threshold_minutes: number;
        recovery_link_days: number;
        updated_at: string | Date;
      }>(
        await tx.execute(sql`
          select abandonment_threshold_minutes, recovery_link_days, updated_at
          from public.tenant_marketing_settings where tenant_id = ${ctx.tenantId}::uuid`),
      )[0];
      return r
        ? {
            configured: true,
            abandonmentThresholdMinutes: r.abandonment_threshold_minutes,
            recoveryLinkDays: r.recovery_link_days,
            updatedAt: new Date(r.updated_at),
          }
        : {
            configured: false,
            abandonmentThresholdMinutes: DEFAULT_THRESHOLD_MINUTES,
            recoveryLinkDays: DEFAULT_LINK_DAYS,
            updatedAt: null,
          };
    });
  }

  async saveSettings(
    ctx: OrgContext,
    dto: SaveAbandonedCartSettingsDto,
  ): Promise<AbandonedCartSettingsDto> {
    await this.db.withUser(ctx.userId, async (tx) => {
      await tx.execute(sql`
        insert into public.tenant_marketing_settings (tenant_id, abandonment_threshold_minutes, recovery_link_days, updated_at, updated_by)
        values (${ctx.tenantId}::uuid, ${dto.abandonmentThresholdMinutes}, ${dto.recoveryLinkDays}, now(), ${ctx.userId}::uuid)
        on conflict (tenant_id) do update set abandonment_threshold_minutes = ${dto.abandonmentThresholdMinutes},
          recovery_link_days = ${dto.recoveryLinkDays}, updated_at = now(), updated_by = ${ctx.userId}::uuid`);
    });
    return this.settings(ctx);
  }

  /** Erases a saved cart (a customer's request, or housekeeping). */
  async remove(ctx: OrgContext, id: string): Promise<void> {
    await this.db.withUser(ctx.userId, async (tx) => {
      const r = rowsOf<{ r: string }>(
        await tx.execute(
          sql`select public.delete_abandoned_cart(${ctx.tenantId}::uuid, ${id}::uuid) as r`,
        ),
      )[0].r;
      if (r === 'forbidden') throw forbidden();
      if (r !== 'ok') throw notFoundError();
    });
  }
}
