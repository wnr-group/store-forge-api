import { Injectable } from '@nestjs/common';
import { sql } from 'drizzle-orm';
import { invalid, notFound } from '../../common/app.exception.js';
import { Paginated } from '../../common/dto/api-response.dto.js';
import { likeTerm, offsetOf } from '../../common/dto/pagination-query.dto.js';
import type { OrgContext } from '../../common/interfaces/request-context.js';
import {
  DatabaseService,
  rowsOf,
  type DbTx,
} from '../../database/database.service.js';
import type { OrderStatus } from '../../database/schema/enums.js';
import { loadOrderTax } from '../tax/order-tax.js';
import { cancelOrder } from './order-cancellation.js';
import { nextStatuses } from './order-state.js';
import {
  assertNoOpenShipment,
  transitionOrder,
  type OrderActor,
} from './order-transitions.js';
import type {
  CancelOrderDto,
  OrderDetailDto,
  OrderListQueryDto,
  UpdateOrderStatusDto,
} from './orders.dto.js';

const SUMMARY = sql`id, order_number, status, payment_status, payment_method, fulfillment_status, customer_name, customer_email,
  currency, total_minor::float8 as total_minor, placed_at`;

const toSummary = (r: Record<string, unknown>) => ({
  id: r.id as string,
  orderNumber: r.order_number as number,
  status: r.status as string,
  paymentStatus: r.payment_status as string,
  paymentMethod: (r.payment_method as string | null) ?? null,
  fulfillmentStatus: r.fulfillment_status as string,
  customerName: (r.customer_name as string | null) ?? null,
  customerEmail: (r.customer_email as string | null) ?? null,
  currency: r.currency as string,
  totalMinor: Number(r.total_minor),
  placedAt: new Date(r.placed_at as string),
});

/**
 * Owner / team-member order management. Reads run as the signed-in user, so row level security applies on top of the
 * `orders:view` permission. Changes (status moves, cancellations) are authorised by `orders:manage` in the controller and
 * then run as the tenant-pinned checkout role for the caller's own organization, because they also move stock.
 */
@Injectable()
export class OrdersService {
  constructor(private readonly db: DatabaseService) {}

  list(ctx: OrgContext, q: OrderListQueryDto) {
    const term = q.search ? likeTerm(q.search) : null;
    const where = sql`where tenant_id = ${ctx.tenantId}::uuid
      ${q.status ? sql`and status = ${q.status}` : sql``}
      ${q.paymentStatus ? sql`and payment_status = ${q.paymentStatus}` : sql``}
      ${q.paymentMethod ? sql`and payment_method = ${q.paymentMethod}` : sql``}
      ${term ? sql`and (order_number::text ilike ${term} or customer_name ilike ${term} or customer_email ilike ${term})` : sql``}`;
    return this.db.withUser(ctx.userId, async (tx) => {
      const rows = rowsOf<Record<string, unknown>>(
        await tx.execute(sql`
          select ${SUMMARY} from public.orders ${where}
          order by placed_at ${q.sortOrder === 'asc' ? sql`asc` : sql`desc`}, id
          limit ${q.limit} offset ${offsetOf(q)}`),
      );
      const [{ total }] = rowsOf<{ total: number }>(
        await tx.execute(
          sql`select count(*)::int as total from public.orders ${where}`,
        ),
      );
      return new Paginated(rows.map(toSummary), {
        page: q.page,
        limit: q.limit,
        total,
      });
    });
  }

  get(ctx: OrgContext, id: string): Promise<OrderDetailDto> {
    return this.db.withUser(ctx.userId, (tx) =>
      this.detail(tx, ctx.tenantId, id),
    );
  }

  async updateStatus(
    ctx: OrgContext,
    id: string,
    dto: UpdateOrderStatusDto,
  ): Promise<OrderDetailDto> {
    if (dto.status === 'cancelled')
      throw invalid(
        'Use the cancel action to cancel an order.',
        { status: 'Use the cancel action to cancel an order.' },
        'USE_CANCEL',
      );
    const actor = this.actor(ctx);
    await this.db.withCheckout(ctx.tenantId, async (tx) => {
      await assertNoOpenShipment(tx, ctx.tenantId, id);
      await transitionOrder(tx, ctx.tenantId, id, dto.status, actor, dto.note);
    });
    return this.get(ctx, id);
  }

  async cancel(
    ctx: OrgContext,
    id: string,
    dto: CancelOrderDto,
  ): Promise<OrderDetailDto> {
    await this.db.withCheckout(ctx.tenantId, (tx) =>
      cancelOrder(tx, ctx.tenantId, id, this.actor(ctx), dto.reason),
    );
    return this.get(ctx, id);
  }

  private actor(ctx: OrgContext): OrderActor {
    return { type: ctx.role === 'owner' ? 'owner' : 'member', id: ctx.userId };
  }

  private async detail(
    tx: DbTx,
    tenantId: string,
    id: string,
  ): Promise<OrderDetailDto> {
    const o = rowsOf<Record<string, unknown>>(
      await tx.execute(sql`
        select ${SUMMARY}, subtotal_minor::float8 as subtotal_minor, discount_minor::float8 as discount_minor,
          shipping_minor::float8 as shipping_minor, cod_fee_minor::float8 as cod_fee_minor, tax_minor::float8 as tax_minor,
          tax_inclusive, customer_phone, cancel_reason, shipping_method_name, shipping_zone_name,
          shipping_carrier_code, shipping_service_code, shipping_days_min, shipping_days_max, shipping_weight_grams
        from public.orders where tenant_id = ${tenantId}::uuid and id = ${id}::uuid`),
    )[0];
    if (!o) throw notFound('Order not found.', 'ORDER_NOT_FOUND');
    const items = rowsOf<Record<string, unknown>>(
      await tx.execute(sql`
        select name, sku, quantity, unit_price_minor::float8 as unit_price_minor, total_minor::float8 as total_minor
        from public.order_items where tenant_id = ${tenantId}::uuid and order_id = ${id}::uuid order by name`),
    );
    const addresses = rowsOf<Record<string, string | null>>(
      await tx.execute(sql`
        select kind, full_name, phone, line1, line2, city, state, postal_code, country from public.order_addresses
        where tenant_id = ${tenantId}::uuid and order_id = ${id}::uuid`),
    );
    const history = rowsOf<Record<string, unknown>>(
      await tx.execute(sql`
        select from_status, to_status, actor_type, note, created_at from public.order_status_history
        where tenant_id = ${tenantId}::uuid and order_id = ${id}::uuid order by created_at, id`),
    );
    const address = (kind: string) => {
      const a = addresses.find((x) => x.kind === kind);
      return a
        ? {
            fullName: a.full_name ?? '',
            phone: a.phone ?? '',
            line1: a.line1 ?? '',
            line2: a.line2 ?? null,
            city: a.city ?? '',
            state: a.state ?? '',
            postalCode: a.postal_code ?? '',
            country: a.country ?? 'IN',
          }
        : null;
    };
    return {
      ...toSummary(o),
      subtotalMinor: Number(o.subtotal_minor),
      discountMinor: Number(o.discount_minor),
      shippingMinor: Number(o.shipping_minor),
      codFeeMinor: Number(o.cod_fee_minor),
      taxMinor: Number(o.tax_minor),
      taxInclusive: o.tax_inclusive as boolean,
      customerPhone: (o.customer_phone as string | null) ?? null,
      cancelReason: (o.cancel_reason as string | null) ?? null,
      shippingMethodName: (o.shipping_method_name as string | null) ?? null,
      shippingZoneName: (o.shipping_zone_name as string | null) ?? null,
      shippingCarrierCode: (o.shipping_carrier_code as string | null) ?? null,
      shippingServiceCode: (o.shipping_service_code as string | null) ?? null,
      shippingDays:
        o.shipping_days_min !== null && o.shipping_days_max !== null
          ? {
              min: Number(o.shipping_days_min),
              max: Number(o.shipping_days_max),
            }
          : null,
      shippingWeightGrams: Number(o.shipping_weight_grams ?? 0),
      tax: await loadOrderTax(tx, tenantId, id),
      items: items.map((i) => ({
        name: i.name as string,
        sku: (i.sku as string | null) ?? null,
        quantity: i.quantity as number,
        unitPriceMinor: Number(i.unit_price_minor),
        totalMinor: Number(i.total_minor),
      })),
      shippingAddress: address('shipping'),
      billingAddress: address('billing'),
      history: history.map((h) => ({
        fromStatus: (h.from_status as string | null) ?? null,
        toStatus: h.to_status as string,
        actorType: h.actor_type as string,
        note: (h.note as string | null) ?? null,
        createdAt: new Date(h.created_at as string),
      })),
      nextStatuses: [...nextStatuses(o.status as OrderStatus)],
    };
  }
}
