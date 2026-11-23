import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { sql } from 'drizzle-orm';
import { AppException, invalid, notFound } from '../../common/app.exception.js';
import type { AppConfig } from '../../config/configuration.js';
import {
  DatabaseService,
  rowsOf,
  type DbTx,
} from '../../database/database.service.js';
import { loadCatalog } from './catalog-loader.js';
import { priceLines, type RequestedLine } from './checkout-pricing.js';
import {
  CHECKOUT_ADJUSTER,
  PAYMENT_METHOD_POLICY,
  type CheckoutAdjuster,
  type PaymentMethodPolicy,
} from './checkout-hooks.js';
import type {
  CheckoutAddressDto,
  PlacedOrderDto,
  PlaceOrderDto,
  PublicOrderDto,
} from './checkout.dto.js';
import { findIndianState } from './indian-states.js';
import { cancelOrder } from './order-cancellation.js';
import { recordStatus } from './order-transitions.js';
import {
  commitReservations,
  heldQuantities,
  insertReservations,
} from './stock-reservations.js';

/** A tenant id that matches no row: used to run the two tenant-resolving lookups before a real tenant can be pinned. */
export const NO_TENANT = '00000000-0000-0000-0000-000000000000';

const IDEMPOTENCY_KEY = /^[A-Za-z0-9_-]{8,128}$/;

export const hashToken = (token: string) =>
  createHash('sha256').update(token).digest('hex');

function sqlstate(error: unknown): string | undefined {
  let current = error as { code?: unknown; cause?: unknown } | undefined;
  for (let depth = 0; depth < 5 && current; depth++) {
    if (typeof current.code === 'string' && /^[0-9A-Z]{5}$/.test(current.code))
      return current.code;
    current = current.cause as typeof current;
  }
  return undefined;
}

interface Store {
  tenantId: string;
  currency: string;
}

export interface OrderRow {
  id: string;
  order_number: number;
  status: string;
  payment_status: string;
  payment_method: string;
  fulfillment_status: string;
  currency: string;
  subtotal_minor: number;
  discount_minor: number;
  shipping_minor: number;
  cod_fee_minor: number;
  tax_minor: number;
  tax_inclusive: boolean;
  total_minor: number;
  placed_at: string | Date;
  shipping_method_name: string | null;
  shipping_zone_name: string | null;
  shipping_days_min: number | null;
  shipping_days_max: number | null;
}

const ORDER_COLUMNS = sql`id, order_number, status, payment_status, payment_method, fulfillment_status, currency,
  subtotal_minor::float8 as subtotal_minor, discount_minor::float8 as discount_minor, shipping_minor::float8 as shipping_minor,
  cod_fee_minor::float8 as cod_fee_minor, tax_minor::float8 as tax_minor, tax_inclusive, total_minor::float8 as total_minor, placed_at,
  shipping_method_name, shipping_zone_name, shipping_days_min, shipping_days_max`;

/**
 * Guest (and, later, signed-in) checkout. Everything that matters is decided here, on the server, inside ONE transaction that
 * runs as the tenant-pinned checkout role: prices come from locked catalog rows, stock is held with a reservation, the order,
 * its items, addresses and history are written together, and any failure rolls the lot back.
 */
@Injectable()
export class CheckoutService {
  constructor(
    private readonly db: DatabaseService,
    private readonly config: ConfigService<AppConfig, true>,
    @Inject(PAYMENT_METHOD_POLICY)
    private readonly payments: PaymentMethodPolicy,
    @Inject(CHECKOUT_ADJUSTER) private readonly adjuster: CheckoutAdjuster,
  ) {}

  /** Store slug -> tenant. Unknown, inactive and suspended stores are indistinguishable (not found). */
  async resolveStore(slug: string): Promise<Store> {
    const row = await this.db.withCheckout(
      NO_TENANT,
      async (tx) =>
        rowsOf<{ tenant_id: string; currency: string }>(
          await tx.execute(
            sql`select tenant_id, currency from public.get_checkout_store(${slug})`,
          ),
        )[0],
    );
    if (!row) throw notFound('Store not found.', 'STORE_NOT_FOUND');
    return { tenantId: row.tenant_id, currency: row.currency };
  }

  async placeOrder(
    slug: string,
    dto: PlaceOrderDto,
    idempotencyKey: string | undefined,
  ): Promise<PlacedOrderDto> {
    if (!idempotencyKey || !IDEMPOTENCY_KEY.test(idempotencyKey))
      throw invalid(
        'Send an Idempotency-Key header of 8 to 128 letters, numbers, dashes or underscores.',
        undefined,
        'IDEMPOTENCY_KEY_REQUIRED',
      );
    const store = await this.resolveStore(slug);

    // A repeat of a finished checkout is answered without asking any carrier anything.
    const already = await this.db.withCheckout(store.tenantId, (tx) =>
      this.replay(tx, store.tenantId, idempotencyKey),
    );
    if (already) return already;

    // Anything slow (a carrier's live price) is fetched now, while no transaction and no stock lock is held.
    const address = this.address(dto.shippingAddress, 'shippingAddress');
    const prepared = await this.adjuster.prepare?.({
      tenantId: store.tenantId,
      currency: store.currency,
      destination: {
        stateCode: address.stateCode,
        stateName: address.stateName,
        city: address.city,
        postalCode: address.postalCode,
      },
      shippingMethodId: dto.shippingMethodId ?? null,
      paymentMethod: dto.paymentMethod,
      requested: dto.lines.map((l) => ({
        productSlug: l.productSlug,
        variantId: l.variantId ?? null,
        quantity: l.quantity,
      })),
    });
    try {
      return await this.db.withCheckout(store.tenantId, (tx) =>
        this.place(tx, store, dto, idempotencyKey, prepared),
      );
    } catch (error) {
      // Two requests with the same key raced: the loser hits the unique index and returns the winner's order.
      if (
        sqlstate(error) === '23505' &&
        /orders_tenant_idempotency_key/.test(
          String((error as Error).cause ?? error),
        )
      ) {
        return this.db.withCheckout(store.tenantId, async (tx) => {
          const replay = await this.replay(tx, store.tenantId, idempotencyKey);
          if (!replay) throw error;
          return replay;
        });
      }
      throw error;
    }
  }

  /** What a shopper may read about their own order: needs the token returned when it was placed. */
  async getOrder(
    slug: string,
    orderNumber: number,
    token: string | undefined,
  ): Promise<PublicOrderDto> {
    const store = await this.resolveStore(slug);
    return this.db.withCheckout(store.tenantId, async (tx) => {
      const order = await this.findByToken(
        tx,
        store.tenantId,
        orderNumber,
        token,
      );
      return this.view(tx, store.tenantId, order, null, false);
    });
  }

  /** The shopper cancels their own order (only while the state machine allows a customer to). */
  async cancelOwnOrder(
    slug: string,
    orderNumber: number,
    token: string | undefined,
  ): Promise<PublicOrderDto> {
    const store = await this.resolveStore(slug);
    return this.db.withCheckout(store.tenantId, async (tx) => {
      const order = await this.findByToken(
        tx,
        store.tenantId,
        orderNumber,
        token,
      );
      await cancelOrder(
        tx,
        store.tenantId,
        order.id,
        { type: 'customer', id: null },
        'Cancelled by the customer',
      );
      const fresh = await this.findByToken(
        tx,
        store.tenantId,
        orderNumber,
        token,
      );
      return this.view(tx, store.tenantId, fresh, null, false);
    });
  }

  // --- internals ---------------------------------------------------------------------------------------------

  async findByToken(
    tx: DbTx,
    tenantId: string,
    orderNumber: number,
    token: string | undefined,
  ): Promise<OrderRow> {
    const row = rowsOf<OrderRow & { access_token_hash: string | null }>(
      await tx.execute(sql`
        select ${ORDER_COLUMNS}, access_token_hash from public.orders
        where tenant_id = ${tenantId}::uuid and order_number = ${orderNumber}`),
    )[0];
    const supplied = Buffer.from(hashToken(token ?? ''), 'hex');
    const stored = Buffer.from(row?.access_token_hash ?? '', 'hex');
    // Same answer for "no such order" and "wrong token": nothing to probe.
    if (
      !row ||
      stored.length !== supplied.length ||
      !timingSafeEqual(stored, supplied)
    )
      throw notFound('Order not found.', 'ORDER_NOT_FOUND');
    return row;
  }

  private async replay(
    tx: DbTx,
    tenantId: string,
    key: string,
  ): Promise<PlacedOrderDto | null> {
    const row = rowsOf<OrderRow>(
      await tx.execute(sql`
        select ${ORDER_COLUMNS} from public.orders
        where tenant_id = ${tenantId}::uuid and idempotency_key = ${key}`),
    )[0];
    return row ? this.view(tx, tenantId, row, null, true) : null;
  }

  private async place(
    tx: DbTx,
    store: Store,
    dto: PlaceOrderDto,
    key: string,
    prepared: unknown,
  ): Promise<PlacedOrderDto> {
    const { tenantId, currency } = store;
    const replayed = await this.replay(tx, tenantId, key);
    if (replayed) return replayed;

    const shipping = this.address(dto.shippingAddress, 'shippingAddress');
    let billing = shipping;
    if (dto.billingSameAsShipping === false) {
      if (!dto.billingAddress)
        throw invalid('Enter your billing address.', {
          billingAddress: 'Enter your billing address.',
        });
      billing = this.address(dto.billingAddress, 'billingAddress');
    }

    // 1. Read and LOCK the catalog rows being bought (products by id, then variants by id: one global order, no deadlocks).
    const requested: RequestedLine[] = dto.lines.map((l) => ({
      productSlug: l.productSlug,
      variantId: l.variantId ?? null,
      quantity: l.quantity,
      expectedUnitPriceMinor: l.expectedUnitPriceMinor,
    }));
    const { products, variants } = await loadCatalog(
      tx,
      tenantId,
      requested,
      true,
    );

    // 2. Price and check stock against what other unpaid orders are holding (rows are locked, so this cannot race).
    const held = await heldQuantities(
      tx,
      tenantId,
      products.map((p) => p.id),
    );
    const priced = priceLines(requested, products, variants, held);
    if (priced.issues.length > 0)
      throw new AppException(
        'CONFLICT',
        'Some items in your cart need attention.',
        {
          code: 'CHECKOUT_ISSUES',
          details: { issues: priced.issues },
        },
      );

    // 3. Shipping, tax, discounts and COD fee are decided by the server-side rules of the tenant.
    const adjustment = await this.adjuster.adjust(
      tx,
      {
        tenantId,
        lines: priced.lines,
        subtotalMinor: priced.subtotalMinor,
        destination: {
          stateCode: shipping.stateCode,
          stateName: shipping.stateName,
          city: shipping.city,
          postalCode: shipping.postalCode,
        },
        shippingMethodId: dto.shippingMethodId ?? null,
        paymentMethod: dto.paymentMethod,
        currency,
      },
      prepared,
    );
    const { codFeeMinor } = await this.payments.resolve(tx, {
      tenantId,
      method: dto.paymentMethod,
      subtotalMinor: priced.subtotalMinor,
      currency,
      shipping: adjustment.shipping
        ? { codAllowed: adjustment.shipping.codAllowed }
        : null,
    });
    const totalMinor =
      priced.subtotalMinor -
      adjustment.discountMinor +
      adjustment.shippingMinor +
      codFeeMinor +
      (adjustment.taxInclusive ? 0 : adjustment.taxMinor);
    // Razorpay cannot take less than one rupee, and a COD order must have something to collect.
    const minimumMinor = dto.paymentMethod === 'cod' ? 1 : 100;
    if (Number.isSafeInteger(totalMinor) && totalMinor < minimumMinor)
      throw invalid(
        'This order total is too low to pay for.',
        undefined,
        'ORDER_TOTAL_TOO_LOW',
      );
    if (!Number.isSafeInteger(totalMinor) || totalMinor < 0)
      throw invalid(
        'This order total is not valid.',
        undefined,
        'ORDER_TOTAL_INVALID',
      );

    // 4. Customer (created on first purchase; an existing record is never edited by an anonymous request).
    const customerId = await this.customerId(tx, tenantId, dto);

    // 5. Order number, then the order and everything that belongs to it.
    const orderNumber = rowsOf<{ last_number: number }>(
      await tx.execute(sql`
        insert into public.tenant_order_counters (tenant_id, last_number) values (${tenantId}::uuid, 1)
        on conflict (tenant_id) do update set last_number = public.tenant_order_counters.last_number + 1
        returning last_number`),
    )[0].last_number;
    const cod = dto.paymentMethod === 'cod';
    const accessToken = randomBytes(32).toString('base64url');
    const orderId = rowsOf<{ id: string }>(
      await tx.execute(sql`
        insert into public.orders (tenant_id, customer_id, order_number, status, payment_method, payment_status, currency,
          subtotal_minor, discount_minor, shipping_minor, cod_fee_minor, tax_minor, tax_inclusive, total_minor,
          customer_name, customer_email, customer_phone, idempotency_key, access_token_hash,
          shipping_method_id, shipping_method_name, shipping_zone_name, shipping_carrier_code, shipping_service_code,
          shipping_days_min, shipping_days_max, shipping_weight_grams)
        values (${tenantId}::uuid, ${customerId}::uuid, ${orderNumber}, ${cod ? 'confirmed' : 'pending_payment'},
          ${dto.paymentMethod}, ${cod ? 'pending_collection' : 'unpaid'}, ${currency},
          ${priced.subtotalMinor}, ${adjustment.discountMinor}, ${adjustment.shippingMinor}, ${codFeeMinor},
          ${adjustment.taxMinor}, ${adjustment.taxInclusive}, ${totalMinor},
          ${dto.customer.fullName}, ${dto.customer.email}, ${dto.customer.phone}, ${key}, ${hashToken(accessToken)},
          ${adjustment.shipping?.methodId ?? null}::uuid, ${adjustment.shipping?.methodName ?? null}, ${adjustment.shipping?.zoneName ?? null},
          ${adjustment.shipping?.carrierCode ?? null}, ${adjustment.shipping?.serviceCode ?? null},
          ${adjustment.shipping?.daysMin ?? null}, ${adjustment.shipping?.daysMax ?? null}, ${adjustment.shipping?.weightGrams ?? 0})
        returning id`),
    )[0].id;

    for (const l of priced.lines)
      await tx.execute(sql`
        insert into public.order_items (tenant_id, order_id, product_id, variant_id, name, sku, quantity, unit_price_minor, total_minor, weight_grams)
        values (${tenantId}::uuid, ${orderId}::uuid, ${l.productId}::uuid, ${l.variantId}::uuid, ${l.name}, ${l.sku},
          ${l.quantity}, ${l.unitPriceMinor}, ${l.totalMinor}, ${l.weightGrams})`);
    for (const [kind, a] of [
      ['shipping', shipping],
      ['billing', billing],
    ] as const)
      await tx.execute(sql`
        insert into public.order_addresses (tenant_id, order_id, kind, full_name, phone, line1, line2, city, state, state_code, postal_code, country)
        values (${tenantId}::uuid, ${orderId}::uuid, ${kind}, ${a.fullName}, ${a.phone}, ${a.line1}, ${a.line2}, ${a.city},
          ${a.stateName}, ${a.stateCode}, ${a.postalCode}, 'IN')`);
    await recordStatus(
      tx,
      tenantId,
      orderId,
      null,
      cod ? 'confirmed' : 'pending_payment',
      { type: 'customer', id: null },
      cod ? 'Cash on delivery order placed' : 'Order placed, awaiting payment',
    );

    if (cod)
      await tx.execute(sql`
        insert into public.payment_transactions (tenant_id, order_id, provider, status, amount_minor, currency)
        values (${tenantId}::uuid, ${orderId}::uuid, 'cod', 'pending_collection', ${totalMinor}, ${currency})`);

    // 6. Stock: online orders hold it until paid or expired; COD orders are final now, so the stock is taken at once.
    const expiresAt = new Date(
      Date.now() +
        this.config.get('checkout', { infer: true }).reservationMinutes *
          60_000,
    );
    await insertReservations(tx, tenantId, orderId, priced.lines, expiresAt);
    if (cod) await commitReservations(tx, tenantId, orderId, orderNumber);

    const row = rowsOf<OrderRow>(
      await tx.execute(
        sql`select ${ORDER_COLUMNS} from public.orders where id = ${orderId}::uuid`,
      ),
    )[0];
    return this.view(tx, tenantId, row, accessToken, false);
  }

  private address(a: CheckoutAddressDto, field: string) {
    const state = findIndianState(a.state);
    if (!state)
      throw invalid('Choose a valid Indian state or union territory.', {
        [`${field}.state`]: 'Choose a valid Indian state or union territory.',
      });
    return {
      fullName: a.fullName,
      phone: a.phone,
      line1: a.line1,
      line2: a.line2 ?? null,
      city: a.city,
      stateName: state.name,
      stateCode: state.code,
      postalCode: a.postalCode,
    };
  }

  private async customerId(
    tx: DbTx,
    tenantId: string,
    dto: PlaceOrderDto,
  ): Promise<string> {
    const inserted = rowsOf<{ id: string }>(
      await tx.execute(sql`
        insert into public.customers (tenant_id, email, full_name, phone)
        values (${tenantId}::uuid, ${dto.customer.email}, ${dto.customer.fullName}, ${dto.customer.phone})
        on conflict (tenant_id, lower(email)) do nothing
        returning id`),
    )[0];
    if (inserted) return inserted.id;
    return rowsOf<{ id: string }>(
      await tx.execute(sql`
        select id from public.customers where tenant_id = ${tenantId}::uuid and lower(email) = lower(${dto.customer.email})`),
    )[0].id;
  }

  /** Builds the response from the stored order, so a replay and a first call show exactly the same figures. */
  async view(
    tx: DbTx,
    tenantId: string,
    o: OrderRow,
    accessToken: string | null,
    replayed: boolean,
  ): Promise<PublicOrderDto> {
    const items = rowsOf<{
      name: string;
      sku: string | null;
      quantity: number;
      unit_price_minor: number;
      total_minor: number;
    }>(
      await tx.execute(sql`
        select name, sku, quantity, unit_price_minor::float8 as unit_price_minor, total_minor::float8 as total_minor
        from public.order_items where tenant_id = ${tenantId}::uuid and order_id = ${o.id}::uuid order by name`),
    );
    const address = rowsOf<Record<string, string | null>>(
      await tx.execute(sql`
        select full_name, phone, line1, line2, city, state, postal_code, country from public.order_addresses
        where tenant_id = ${tenantId}::uuid and order_id = ${o.id}::uuid and kind = 'shipping'`),
    )[0];
    const hold = rowsOf<{ expires_at: string | Date | null }>(
      await tx.execute(sql`
        select min(expires_at) as expires_at from public.inventory_reservations
        where tenant_id = ${tenantId}::uuid and order_id = ${o.id}::uuid and status = 'active'`),
    )[0];
    const parcels = rowsOf<{
      id: string;
      status: string;
      courier_name: string | null;
      awb: string | null;
      tracking_url: string | null;
      estimated_delivery: string | Date | null;
    }>(
      await tx.execute(sql`
        select id, status, courier_name, awb, tracking_url, estimated_delivery from public.shipments
        where tenant_id = ${tenantId}::uuid and order_id = ${o.id}::uuid and status not in ('creating', 'failed', 'cancelled')
        order by created_at, id`),
    );
    const shipments: PublicOrderDto['shipments'] = [];
    for (const p of parcels) {
      const parcelItems = rowsOf<{ name: string; quantity: number }>(
        await tx.execute(sql`
          select oi.name, si.quantity from public.shipment_items si
          join public.order_items oi on oi.tenant_id = si.tenant_id and oi.id = si.order_item_id
          where si.tenant_id = ${tenantId}::uuid and si.shipment_id = ${p.id}::uuid order by oi.name, oi.id`),
      );
      const events = rowsOf<{
        status: string;
        description: string;
        location: string | null;
        occurred_at: string | Date | null;
      }>(
        await tx.execute(sql`
          select status, description, location, occurred_at from public.shipment_events
          where tenant_id = ${tenantId}::uuid and shipment_id = ${p.id}::uuid and source <> 'owner'
          order by coalesce(occurred_at, created_at) desc, created_at desc limit 50`),
      );
      shipments.push({
        status: p.status,
        courierName: p.courier_name,
        awb: p.awb,
        trackingUrl: p.tracking_url,
        estimatedDelivery: p.estimated_delivery
          ? new Date(p.estimated_delivery)
          : null,
        items: parcelItems,
        events: events.map((e) => ({
          status: e.status,
          description: e.description,
          location: e.location,
          occurredAt: e.occurred_at ? new Date(e.occurred_at) : null,
        })),
      });
    }
    return {
      orderNumber: o.order_number,
      status: o.status,
      paymentStatus: o.payment_status,
      paymentMethod: o.payment_method,
      fulfillmentStatus: o.fulfillment_status,
      currency: o.currency,
      subtotalMinor: Number(o.subtotal_minor),
      discountMinor: Number(o.discount_minor),
      shippingMinor: Number(o.shipping_minor),
      codFeeMinor: Number(o.cod_fee_minor),
      taxMinor: Number(o.tax_minor),
      taxInclusive: o.tax_inclusive,
      totalMinor: Number(o.total_minor),
      shippingMethodName: o.shipping_method_name,
      shippingZoneName: o.shipping_zone_name,
      shippingDays:
        o.shipping_days_min !== null && o.shipping_days_max !== null
          ? { min: o.shipping_days_min, max: o.shipping_days_max }
          : null,
      placedAt: new Date(o.placed_at),
      items: items.map((i) => ({
        name: i.name,
        sku: i.sku,
        quantity: i.quantity,
        unitPriceMinor: Number(i.unit_price_minor),
        totalMinor: Number(i.total_minor),
      })),
      shippingAddress: {
        fullName: address?.full_name ?? '',
        phone: address?.phone ?? '',
        line1: address?.line1 ?? '',
        line2: address?.line2 ?? null,
        city: address?.city ?? '',
        state: address?.state ?? '',
        postalCode: address?.postal_code ?? '',
        country: address?.country ?? 'IN',
      },
      shipments,
      reservationExpiresAt: hold?.expires_at ? new Date(hold.expires_at) : null,
      accessToken,
      replayed,
    };
  }
}
