import { Injectable, Logger } from '@nestjs/common';
import { sql } from 'drizzle-orm';
import {
  AppException,
  conflict,
  invalid,
  notFound,
} from '../../common/app.exception.js';
import { Paginated } from '../../common/dto/api-response.dto.js';
import { offsetOf } from '../../common/dto/pagination-query.dto.js';
import type { OrgContext } from '../../common/interfaces/request-context.js';
import {
  DatabaseService,
  rowsOf,
  type DbTx,
} from '../../database/database.service.js';
import type { ShipmentStatus } from '../../database/schema/shipping.js';
import { lockOrder, type OrderActor } from '../orders/order-transitions.js';
import { CarrierSelectionService } from '../shipping/carrier-selection.service.js';
import {
  CarrierError,
  type CarrierAddress,
  type LabelResult,
  type PaymentMode,
  type ShipmentInput,
  type ShipmentResult,
} from '../shipping/providers/shipping-provider.js';
import {
  carrierProblem,
  isDefinitiveRefusal,
  ShipmentCarrier,
  type CarrierSession,
} from './shipment-carrier.js';
import { syncOrderWithShipments } from './shipment-order-sync.js';
import {
  allocateItems,
  canMoveShipment,
  carriesWholeOrder,
  isOpenShipment,
  itemsValue,
  itemsWeight,
  safeUrl,
  type Allocation,
  type OrderLine,
} from './shipment-rules.js';
import {
  CreateShipmentDto,
  ManualShipmentDto,
  ShipmentDetailDto,
  ShipmentDto,
  ShipmentLabelDto,
  ShipmentListQueryDto,
  UpdateManualShipmentDto,
} from './shipments.dto.js';

/** The order must be at one of these to hand more of it to a carrier (a part-shipped order is `shipped` while items remain). */
const SHIPPABLE = ['confirmed', 'processing', 'ready_to_ship', 'shipped'];
const MAX_LABEL_BYTES = 5 * 1024 * 1024;

interface OrderRow {
  id: string;
  order_number: number;
  status: string;
  payment_status: string;
  payment_method: string | null;
  total_minor: number;
  placed_at: string | Date;
  customer_email: string | null;
  shipping_carrier_code: string | null;
  shipping_service_code: string | null;
}

interface AddressRow {
  full_name: string;
  phone: string;
  line1: string;
  line2: string | null;
  city: string;
  state: string;
  postal_code: string;
}

interface OriginRow {
  name: string;
  phone: string;
  email: string | null;
  line1: string;
  line2: string | null;
  city: string;
  state: string;
  postal_code: string;
}

interface Plan {
  order: OrderRow;
  lines: Allocation['lines'];
  paymentMode: PaymentMode;
  codAmountMinor: number;
  declaredValueMinor: number;
  weightGrams: number;
  dims: { lengthCm: number; breadthCm: number; heightCm: number } | null;
  destination: AddressRow;
  origin: OriginRow;
}

interface ShipmentRow {
  id: string;
  order_id: string;
  order_number: number;
  status: ShipmentStatus;
  provider_code: string;
  courier_name: string | null;
  service_code: string | null;
  awb: string | null;
  provider_order_id: string | null;
  provider_shipment_id: string | null;
  tracking_url: string | null;
  estimated_delivery: string | Date | null;
  payment_mode: string;
  cod_amount_minor: number;
  declared_value_minor: number;
  weight_grams: number;
  length_cm: number | null;
  breadth_cm: number | null;
  height_cm: number | null;
  has_label: boolean;
  label_url: string | null;
  failure_reason: string | null;
  attempts: number;
  last_synced_at: string | Date | null;
  picked_up_at: string | Date | null;
  delivered_at: string | Date | null;
  created_at: string | Date;
}

const COLUMNS = sql`s.id, s.order_id, o.order_number, s.status, s.provider_code, s.courier_name, s.service_code, s.awb,
  s.provider_order_id, s.provider_shipment_id, s.tracking_url, s.estimated_delivery, s.payment_mode,
  s.cod_amount_minor::float8 as cod_amount_minor, s.declared_value_minor::float8 as declared_value_minor,
  s.weight_grams, s.length_cm, s.breadth_cm, s.height_cm, s.has_label, s.label_url, s.failure_reason, s.attempts,
  s.last_synced_at, s.picked_up_at, s.delivered_at, s.created_at`;

const FROM = sql`from public.shipments s join public.orders o on o.tenant_id = s.tenant_id and o.id = s.order_id`;

const date = (v: string | Date | null) => (v ? new Date(v) : null);

/** A plain object with the DTO's fields (so it can be spread into the detail view). */
type Plain<T> = { [K in keyof T]: T[K] };

const toDto = (r: ShipmentRow): Plain<ShipmentDto> => ({
  id: r.id,
  orderId: r.order_id,
  orderNumber: r.order_number,
  status: r.status,
  providerCode: r.provider_code,
  courierName: r.courier_name,
  serviceCode: r.service_code,
  awb: r.awb,
  trackingUrl: r.tracking_url,
  estimatedDelivery: date(r.estimated_delivery),
  paymentMode: r.payment_mode,
  codAmountMinor: Number(r.cod_amount_minor),
  declaredValueMinor: Number(r.declared_value_minor),
  weightGrams: r.weight_grams,
  hasLabel: r.has_label,
  labelUrl: r.label_url,
  failureReason: r.failure_reason,
  lastSyncedAt: date(r.last_synced_at),
  pickedUpAt: date(r.picked_up_at),
  deliveredAt: date(r.delivered_at),
  createdAt: new Date(r.created_at),
});

/**
 * Creating, cancelling and labelling shipments with the tenant's own carriers.
 *
 * Booking is done in three separate steps so that no carrier call ever happens while an order is locked and a lost answer can
 * never leave a parcel nobody knows about:
 *   1. one transaction checks the order and SAVES the shipment as `creating` (holding its items);
 *   2. the carrier is called, with no transaction open;
 *   3. one transaction records the result (waybill, courier, tracking link) and moves the order along.
 * If step 2 does not finish, the saved row says what was attempted and `retry` resumes it without booking twice.
 */
@Injectable()
export class ShipmentsService {
  private readonly logger = new Logger(ShipmentsService.name);

  constructor(
    private readonly db: DatabaseService,
    private readonly carrier: ShipmentCarrier,
    private readonly selection: CarrierSelectionService,
  ) {}

  // --- reading -------------------------------------------------------------------------------------------------------

  list(ctx: OrgContext, q: ShipmentListQueryDto) {
    const where = sql`where s.tenant_id = ${ctx.tenantId}::uuid
      ${q.status ? sql`and s.status = ${q.status}` : sql``}
      ${q.providerCode ? sql`and s.provider_code = ${q.providerCode}` : sql``}`;
    return this.db.withUser(ctx.userId, async (tx) => {
      const rows = rowsOf<ShipmentRow>(
        await tx.execute(sql`
          select ${COLUMNS} ${FROM} ${where}
          order by s.created_at ${q.sortOrder === 'asc' ? sql`asc` : sql`desc`}, s.id
          limit ${q.limit} offset ${offsetOf(q)}`),
      );
      const [{ total }] = rowsOf<{ total: number }>(
        await tx.execute(sql`select count(*)::int as total ${FROM} ${where}`),
      );
      return new Paginated(rows.map(toDto), {
        page: q.page,
        limit: q.limit,
        total,
      });
    });
  }

  listForOrder(ctx: OrgContext, orderId: string): Promise<ShipmentDto[]> {
    return this.db.withUser(ctx.userId, async (tx) => {
      const exists = rowsOf<{ id: string }>(
        await tx.execute(
          sql`select id from public.orders where id = ${orderId}::uuid and tenant_id = ${ctx.tenantId}::uuid`,
        ),
      )[0];
      if (!exists) throw notFound('Order not found.', 'ORDER_NOT_FOUND');
      return rowsOf<ShipmentRow>(
        await tx.execute(sql`
          select ${COLUMNS} ${FROM}
          where s.tenant_id = ${ctx.tenantId}::uuid and s.order_id = ${orderId}::uuid
          order by s.created_at, s.id`),
      ).map(toDto);
    });
  }

  get(ctx: OrgContext, id: string): Promise<ShipmentDetailDto> {
    return this.db.withUser(ctx.userId, (tx) =>
      this.detail(tx, ctx.tenantId, id),
    );
  }

  private async detail(
    tx: DbTx,
    tenantId: string,
    id: string,
  ): Promise<ShipmentDetailDto> {
    const row = rowsOf<ShipmentRow>(
      await tx.execute(sql`
        select ${COLUMNS} ${FROM}
        where s.tenant_id = ${tenantId}::uuid and s.id = ${id}::uuid`),
    )[0];
    if (!row) throw notFound('Shipment not found.', 'SHIPMENT_NOT_FOUND');
    const items = rowsOf<{
      order_item_id: string;
      name: string;
      sku: string | null;
      quantity: number;
    }>(
      await tx.execute(sql`
        select si.order_item_id, oi.name, oi.sku, si.quantity
        from public.shipment_items si
        join public.order_items oi on oi.tenant_id = si.tenant_id and oi.id = si.order_item_id
        where si.tenant_id = ${tenantId}::uuid and si.shipment_id = ${id}::uuid order by oi.name, oi.id`),
    );
    const events = rowsOf<{
      status: string;
      description: string;
      location: string | null;
      occurred_at: string | Date | null;
      source: string;
      created_at: string | Date;
    }>(
      await tx.execute(sql`
        select status, description, location, occurred_at, source, created_at from public.shipment_events
        where tenant_id = ${tenantId}::uuid and shipment_id = ${id}::uuid
        order by coalesce(occurred_at, created_at) desc, created_at desc limit 200`),
    );
    return {
      ...toDto(row),
      items: items.map((i) => ({
        orderItemId: i.order_item_id,
        name: i.name,
        sku: i.sku,
        quantity: i.quantity,
      })),
      events: events.map((e) => ({
        status: e.status,
        description: e.description,
        location: e.location,
        occurredAt: date(e.occurred_at),
        source: e.source,
        recordedAt: new Date(e.created_at),
      })),
    };
  }

  // --- creating ------------------------------------------------------------------------------------------------------

  async create(
    ctx: OrgContext,
    orderId: string,
    dto: CreateShipmentDto,
  ): Promise<ShipmentDetailDto> {
    // 1. A first look, to know what the parcel is and which carrier suits it. Nothing is changed.
    const first = await this.db.withCheckout(ctx.tenantId, (tx) =>
      this.plan(tx, ctx.tenantId, orderId, dto),
    );
    const choice = await this.chooseCarrier(ctx.tenantId, first, dto);
    // Fail before anything is saved when the carrier cannot be used at all (not connected, switched off, not checked).
    const { provider } = await this.carrier.open(
      ctx.tenantId,
      choice.providerCode,
      true,
    );
    if (!provider.capabilities.createShipment)
      throw conflict(
        `${provider.name} does not create shipments through its API. Book the parcel in the carrier's own dashboard.`,
        undefined,
        'CARRIER_UNSUPPORTED',
      );

    // 2. Save the shipment (holding its items) after checking everything again under the order's lock: time has passed.
    const shipmentId = await this.db.withCheckout(ctx.tenantId, async (tx) => {
      const plan = await this.plan(tx, ctx.tenantId, orderId, dto, true);
      const id = rowsOf<{ id: string }>(
        await tx.execute(sql`
          insert into public.shipments (tenant_id, order_id, provider_code, status, service_code, payment_mode, cod_amount_minor,
            declared_value_minor, weight_grams, length_cm, breadth_cm, height_cm, created_by)
          values (${ctx.tenantId}::uuid, ${orderId}::uuid, ${choice.providerCode}, 'creating', ${choice.serviceCode}, ${plan.paymentMode},
            ${plan.codAmountMinor}, ${plan.declaredValueMinor}, ${plan.weightGrams}, ${plan.dims?.lengthCm ?? null},
            ${plan.dims?.breadthCm ?? null}, ${plan.dims?.heightCm ?? null}, ${ctx.userId}::uuid)
          returning id`),
      )[0].id;
      for (const l of plan.lines)
        await tx.execute(sql`
          insert into public.shipment_items (tenant_id, shipment_id, order_item_id, quantity)
          values (${ctx.tenantId}::uuid, ${id}::uuid, ${l.line.id}::uuid, ${l.quantity})`);
      return id;
    });

    // 3. Book with the carrier.
    return this.book(ctx.tenantId, shipmentId, this.actor(ctx));
  }

  /**
   * Records a parcel the store sent with a courier of its own (no carrier integration): the provider name and tracking number the
   * owner typed. It holds the order's items like any shipment and the order follows it (ready to ship), so the customer sees the
   * courier and tracking number in their account straight away. Nothing is sent to any carrier.
   */
  async recordManual(
    ctx: OrgContext,
    orderId: string,
    dto: ManualShipmentDto,
  ): Promise<ShipmentDetailDto> {
    try {
      const id = await this.db.withCheckout(ctx.tenantId, async (tx) => {
        const plan = await this.plan(
          tx,
          ctx.tenantId,
          orderId,
          { items: dto.items } as CreateShipmentDto,
          true,
          true,
        );
        const id = rowsOf<{ id: string }>(
          await tx.execute(sql`
            insert into public.shipments (tenant_id, order_id, provider_code, status, courier_name, awb, tracking_url, estimated_delivery,
              payment_mode, cod_amount_minor, declared_value_minor, weight_grams, created_by)
            values (${ctx.tenantId}::uuid, ${orderId}::uuid, 'manual', 'created', ${dto.courierName}, ${dto.trackingNumber},
              ${dto.trackingUrl || null}, ${dto.estimatedDelivery ?? null}::timestamptz, ${plan.paymentMode}, ${plan.codAmountMinor},
              ${plan.declaredValueMinor}, ${Math.max(plan.weightGrams, 1)}, ${ctx.userId}::uuid)
            returning id`),
        )[0].id;
        for (const l of plan.lines)
          await tx.execute(sql`
            insert into public.shipment_items (tenant_id, shipment_id, order_item_id, quantity)
            values (${ctx.tenantId}::uuid, ${id}::uuid, ${l.line.id}::uuid, ${l.quantity})`);
        await this.addEvent(
          tx,
          ctx.tenantId,
          id,
          'created',
          `Handed to ${dto.courierName}, tracking number ${dto.trackingNumber}`,
          'owner',
        );
        await syncOrderWithShipments(
          tx,
          ctx.tenantId,
          orderId,
          this.actor(ctx),
          'Shipment recorded by the store',
        );
        return id;
      });
      return await this.get(ctx, id);
    } catch (error) {
      throw this.trackingTaken(error);
    }
  }

  /** Changes a hand-recorded parcel (provider, tracking number or link) or moves it forward; the order follows it. */
  async updateManual(
    ctx: OrgContext,
    id: string,
    dto: UpdateManualShipmentDto,
  ): Promise<ShipmentDetailDto> {
    const row = await this.row(ctx.tenantId, id);
    if (row.provider_code !== 'manual')
      throw conflict(
        'Only a parcel recorded by hand can be changed here. Carrier parcels follow the carrier.',
        undefined,
        'SHIPMENT_NOT_MANUAL',
      );
    if (['delivered', 'returned', 'cancelled', 'failed'].includes(row.status))
      throw conflict(
        'This parcel is finished and can no longer be changed.',
        undefined,
        'SHIPMENT_FINISHED',
      );
    if (dto.status && !canMoveShipment(row.status, dto.status))
      throw conflict(
        'A parcel can only move forward.',
        undefined,
        'SHIPMENT_STATUS_BACKWARDS',
      );
    const status = dto.status ?? null;
    try {
      await this.db.withCheckout(ctx.tenantId, async (tx) => {
        await lockOrder(tx, ctx.tenantId, row.order_id);
        await tx.execute(sql`
          update public.shipments set
            courier_name = coalesce(${dto.courierName ?? null}, courier_name),
            awb = coalesce(${dto.trackingNumber ?? null}, awb),
            tracking_url = case when ${dto.trackingUrl === undefined} then tracking_url else ${dto.trackingUrl || null} end,
            estimated_delivery = coalesce(${dto.estimatedDelivery ?? null}::timestamptz, estimated_delivery),
            status = coalesce(${status}, status),
            picked_up_at = case when ${status === 'picked_up' || status === 'in_transit'} then coalesce(picked_up_at, now()) else picked_up_at end,
            delivered_at = case when ${status === 'delivered'} then now() else delivered_at end,
            updated_at = now()
          where id = ${id}::uuid and tenant_id = ${ctx.tenantId}::uuid`);
        if (status) {
          await this.addEvent(
            tx,
            ctx.tenantId,
            id,
            status,
            `Marked ${status.replaceAll('_', ' ')} by the store`,
            'owner',
          );
          await syncOrderWithShipments(
            tx,
            ctx.tenantId,
            row.order_id,
            this.actor(ctx),
            'Shipment updated by the store',
          );
        }
      });
    } catch (error) {
      throw this.trackingTaken(error);
    }
    return this.get(ctx, id);
  }

  private trackingTaken(error: unknown): unknown {
    return /shipments_tenant_awb_key/.test(
      String((error as Error).cause ?? error),
    )
      ? conflict(
          'This tracking number is already recorded for another parcel.',
          { trackingNumber: 'This tracking number is already in use.' },
          'TRACKING_NUMBER_TAKEN',
        )
      : error;
  }

  /** Books (or resumes booking of) a saved shipment. */
  async retry(ctx: OrgContext, id: string): Promise<ShipmentDetailDto> {
    const row = await this.row(ctx.tenantId, id);
    if (row.status !== 'creating')
      throw conflict(
        'Only a shipment that has not been booked yet can be retried.',
        undefined,
        'SHIPMENT_NOT_PENDING',
      );
    return this.book(ctx.tenantId, id, this.actor(ctx));
  }

  private async book(
    tenantId: string,
    shipmentId: string,
    actor: OrderActor,
  ): Promise<ShipmentDetailDto> {
    const input = await this.db.withCheckout(tenantId, async (tx) => {
      const row = rowsOf<ShipmentRow>(
        await tx.execute(sql`
          select ${COLUMNS} ${FROM}
          where s.tenant_id = ${tenantId}::uuid and s.id = ${shipmentId}::uuid for update of s`),
      )[0];
      if (!row) throw notFound('Shipment not found.', 'SHIPMENT_NOT_FOUND');
      if (row.status !== 'creating')
        throw conflict(
          'This shipment has already been booked.',
          undefined,
          'SHIPMENT_NOT_PENDING',
        );
      await tx.execute(
        sql`update public.shipments set attempts = attempts + 1, updated_at = now() where id = ${shipmentId}::uuid and tenant_id = ${tenantId}::uuid`,
      );
      return this.bookingInput(tx, tenantId, row);
    });

    let result: ShipmentResult;
    let session: CarrierSession;
    let providerName = input.row.provider_code;
    try {
      const { provider, credentials } = await this.carrier.open(
        tenantId,
        input.row.provider_code,
        true,
      );
      providerName = provider.name;
      if (!provider.capabilities.createShipment)
        throw new CarrierError(
          'unsupported',
          `${provider.name} does not create shipments through its API.`,
        );
      result = await provider.createShipment(credentials, input.shipment);
      session = { provider, credentials };
    } catch (error) {
      throw await this.bookingFailed(tenantId, shipmentId, error, providerName);
    }

    await this.db.withCheckout(tenantId, async (tx) => {
      await tx.execute(sql`
        update public.shipments set status = 'created', awb = ${result.awb},
          courier_name = ${result.courierName?.slice(0, 120) ?? null}, service_code = coalesce(${result.serviceCode}, service_code),
          provider_order_id = coalesce(${result.providerOrderId ?? null}, provider_order_id),
          provider_shipment_id = coalesce(${result.providerShipmentId ?? null}, provider_shipment_id),
          tracking_url = ${safeUrl(result.trackingUrl)}, failure_reason = null, updated_at = now()
        where id = ${shipmentId}::uuid and tenant_id = ${tenantId}::uuid`);
      await this.addEvent(
        tx,
        tenantId,
        shipmentId,
        'created',
        `Booked with ${result.courierName ?? providerName}. Waybill ${result.awb}.`,
        'system',
      );
      await syncOrderWithShipments(
        tx,
        tenantId,
        input.row.order_id,
        actor,
        `Shipment booked (${result.awb})`,
      );
    });

    // The label is a convenience: a failure here never undoes a parcel that is already booked.
    await this.keepLabel(tenantId, shipmentId, result, session, {
      awb: result.awb,
      providerOrderId: result.providerOrderId,
      providerShipmentId: result.providerShipmentId,
    });
    return this.db.withCheckout(tenantId, (tx) =>
      this.detail(tx, tenantId, shipmentId),
    );
  }

  /** Records what a failed booking means, and returns the error to show. */
  private async bookingFailed(
    tenantId: string,
    shipmentId: string,
    error: unknown,
    providerName: string,
  ): Promise<Error> {
    if (error instanceof AppException) {
      // Nothing was sent to the carrier (it is not connected / not switched on / not checked): the shipment never existed.
      await this.markFailed(tenantId, shipmentId, error.message);
      return error;
    }
    if (!(error instanceof CarrierError)) return error as Error;
    const partial = error.options.partial;
    const definitive = isDefinitiveRefusal(error);
    const hadIds = await this.db.withCheckout(tenantId, async (tx) => {
      const r = rowsOf<{ has: boolean }>(
        await tx.execute(sql`
          update public.shipments set
            provider_order_id = coalesce(${partial?.providerOrderId ?? null}, provider_order_id),
            provider_shipment_id = coalesce(${partial?.providerShipmentId ?? null}, provider_shipment_id),
            failure_reason = ${error.message.slice(0, 300)}, updated_at = now()
          where id = ${shipmentId}::uuid and tenant_id = ${tenantId}::uuid
          returning (provider_order_id is not null or provider_shipment_id is not null) as has`),
      )[0];
      return r?.has ?? false;
    });
    if (definitive && !hadIds) {
      await this.markFailed(tenantId, shipmentId, error.message);
      const problem = carrierProblem(error);
      return new AppException(problem.kind, problem.message, {
        code: problem.code,
        details: { shipmentId },
      });
    }
    // The carrier may or may not have the parcel: keep the row so a retry can pick it up instead of booking twice.
    this.logger.warn(
      `booking with ${providerName} did not finish (${error.kind}); the shipment is kept for a retry`,
    );
    return new AppException(
      'UNAVAILABLE',
      definitive
        ? `${error.message} The shipment is saved: fix the problem and retry it.`
        : 'The carrier did not confirm the booking. The shipment is saved: retry it in a moment (it will not be booked twice).',
      { code: 'SHIPMENT_PENDING', details: { shipmentId } },
    );
  }

  private async markFailed(
    tenantId: string,
    shipmentId: string,
    reason: string,
  ): Promise<void> {
    await this.db.withCheckout(tenantId, async (tx) => {
      await tx.execute(sql`
        update public.shipments set status = 'failed', failure_reason = ${reason.slice(0, 300)}, updated_at = now()
        where id = ${shipmentId}::uuid and tenant_id = ${tenantId}::uuid and status = 'creating'`);
      await this.addEvent(
        tx,
        tenantId,
        shipmentId,
        'failed',
        reason.slice(0, 300),
        'system',
      );
    });
  }

  // --- cancelling ----------------------------------------------------------------------------------------------------

  async cancel(ctx: OrgContext, id: string): Promise<ShipmentDetailDto> {
    const row = await this.row(ctx.tenantId, id);
    if (row.status === 'creating') {
      if (row.provider_order_id || row.provider_shipment_id)
        throw conflict(
          'The carrier already has an order for this shipment. Retry it to finish booking, then cancel it.',
          undefined,
          'SHIPMENT_NEEDS_CARRIER',
        );
      await this.db.withCheckout(ctx.tenantId, async (tx) => {
        await this.cancelRecord(
          tx,
          ctx,
          row,
          'Cancelled before it was booked.',
        );
      });
      return this.get(ctx, id);
    }
    if (row.status !== 'created' || !row.awb)
      throw conflict(
        row.status === 'cancelled'
          ? 'This shipment is already cancelled.'
          : isOpenShipment(row.status)
            ? 'The carrier already has this parcel, so it can no longer be cancelled here.'
            : 'This shipment can no longer be cancelled.',
        undefined,
        'SHIPMENT_NOT_CANCELLABLE',
      );
    try {
      const { provider, credentials } = await this.carrier.open(
        ctx.tenantId,
        row.provider_code,
        false,
      );
      if (!provider.capabilities.cancelShipment)
        throw conflict(
          `${provider.name} cannot cancel through its API. Cancel the parcel in the carrier's own dashboard.`,
          undefined,
          'CARRIER_UNSUPPORTED',
        );
      const outcome = await provider.cancelShipment(credentials, {
        awb: row.awb,
        providerOrderId: row.provider_order_id ?? undefined,
        providerShipmentId: row.provider_shipment_id ?? undefined,
      });
      if (!outcome.cancelled)
        throw conflict(
          outcome.message ?? 'The carrier did not cancel this parcel.',
          undefined,
          'CARRIER_REJECTED',
        );
    } catch (error) {
      if (error instanceof CarrierError) throw carrierProblem(error);
      throw error;
    }
    await this.db.withCheckout(ctx.tenantId, async (tx) => {
      await this.cancelRecord(tx, ctx, row, 'Cancelled with the carrier.');
    });
    return this.get(ctx, id);
  }

  private async cancelRecord(
    tx: DbTx,
    ctx: OrgContext,
    row: ShipmentRow,
    note: string,
  ): Promise<void> {
    const done = rowsOf<{ id: string }>(
      await tx.execute(sql`
        update public.shipments set status = 'cancelled', cancelled_at = now(), updated_at = now()
        where id = ${row.id}::uuid and tenant_id = ${ctx.tenantId}::uuid and status in ('creating', 'created') returning id`),
    );
    if (done.length === 0) return; // the carrier moved it meanwhile: that update wins
    await this.addEvent(tx, ctx.tenantId, row.id, 'cancelled', note, 'owner');
    await syncOrderWithShipments(
      tx,
      ctx.tenantId,
      row.order_id,
      this.actor(ctx),
      'Shipment cancelled',
    );
  }

  // --- labels --------------------------------------------------------------------------------------------------------

  async label(ctx: OrgContext, id: string): Promise<ShipmentLabelDto> {
    const row = await this.row(ctx.tenantId, id);
    return {
      available: row.has_label || !!row.label_url,
      url: row.label_url,
      stored: row.has_label,
    };
  }

  /** Asks the carrier for the label again (for example when it was not ready when the parcel was booked). */
  async generateLabel(ctx: OrgContext, id: string): Promise<ShipmentLabelDto> {
    const row = await this.row(ctx.tenantId, id);
    if (
      !row.awb ||
      ![
        'created',
        'picked_up',
        'in_transit',
        'out_for_delivery',
        'undelivered',
      ].includes(row.status)
    )
      throw conflict(
        'A label can only be made for a booked parcel that is still with you or on its way.',
        undefined,
        'SHIPMENT_NO_LABEL',
      );
    let label: LabelResult;
    try {
      const { provider, credentials } = await this.carrier.open(
        ctx.tenantId,
        row.provider_code,
        false,
      );
      if (!provider.capabilities.labels)
        throw conflict(
          `${provider.name} does not provide labels through its API. Print the label from the carrier's dashboard.`,
          undefined,
          'CARRIER_UNSUPPORTED',
        );
      label = await provider.generateShippingLabel(credentials, {
        awb: row.awb,
        providerOrderId: row.provider_order_id ?? undefined,
        providerShipmentId: row.provider_shipment_id ?? undefined,
      });
    } catch (error) {
      if (error instanceof CarrierError) throw carrierProblem(error);
      throw error;
    }
    const stored = await this.storeLabel(ctx.tenantId, id, label);
    if (!stored)
      throw new AppException(
        'UNAVAILABLE',
        'The carrier has not produced a label yet. Try again in a moment.',
        { code: 'LABEL_NOT_READY' },
      );
    return this.label(ctx, id);
  }

  async labelFile(ctx: OrgContext, id: string): Promise<Buffer> {
    return this.db.withCheckout(ctx.tenantId, async (tx) => {
      const r = rowsOf<{ content: Uint8Array }>(
        await tx.execute(sql`
          select content from public.shipment_labels where shipment_id = ${id}::uuid and tenant_id = ${ctx.tenantId}::uuid`),
      )[0];
      if (!r)
        throw notFound(
          'No label file is stored for this shipment. Use the carrier link, or generate the label.',
          'LABEL_NOT_FOUND',
        );
      return Buffer.from(r.content);
    });
  }

  /** Saves what the carrier returned: a PDF is stored here, a link is kept as the carrier's. Returns whether anything was kept. */
  private async storeLabel(
    tenantId: string,
    shipmentId: string,
    label: LabelResult,
  ): Promise<boolean> {
    const url = safeUrl(label.url);
    let pdf: Buffer | null = null;
    if (label.pdfBase64) {
      const bytes = Buffer.from(label.pdfBase64, 'base64');
      if (
        bytes.length > 0 &&
        bytes.length <= MAX_LABEL_BYTES &&
        bytes.subarray(0, 4).toString('latin1') === '%PDF'
      )
        pdf = bytes;
    }
    if (!url && !pdf) return false;
    await this.db.withCheckout(tenantId, async (tx) => {
      if (pdf)
        await tx.execute(sql`
          insert into public.shipment_labels (shipment_id, tenant_id, content)
          values (${shipmentId}::uuid, ${tenantId}::uuid, ${pdf})
          on conflict (shipment_id) do update set content = excluded.content, created_at = now()`);
      await tx.execute(sql`
        update public.shipments set has_label = has_label or ${pdf !== null},
          label_url = coalesce(${url}::text, label_url), updated_at = now()
        where id = ${shipmentId}::uuid and tenant_id = ${tenantId}::uuid`);
    });
    return true;
  }

  private async keepLabel(
    tenantId: string,
    shipmentId: string,
    result: ShipmentResult,
    session: CarrierSession,
    ref: { awb: string; providerOrderId?: string; providerShipmentId?: string },
  ): Promise<void> {
    try {
      let label: LabelResult | undefined = result.label;
      if (!label && session.provider.capabilities.labels)
        label = await session.provider.generateShippingLabel(
          session.credentials,
          ref,
        );
      if (label) await this.storeLabel(tenantId, shipmentId, label);
    } catch (error) {
      this.logger.warn(
        `label for a new shipment was not stored (${error instanceof CarrierError ? error.kind : 'error'})`,
      );
    }
  }

  // --- planning ------------------------------------------------------------------------------------------------------

  /** Checks the order can ship what was asked and works out the parcel. With `lock`, the order is locked for the checks. */
  private async plan(
    tx: DbTx,
    tenantId: string,
    orderId: string,
    dto: CreateShipmentDto,
    lock = false,
    /**
     * A parcel the store records by hand never reaches a carrier, so it needs neither a parcel weight nor a pickup address (the
     * rest of the checks, and the items it holds, are the same).
     */
    manual = false,
  ): Promise<Plan> {
    if (lock) await lockOrder(tx, tenantId, orderId);
    const order = rowsOf<OrderRow>(
      await tx.execute(sql`
        select id, order_number, status, payment_status, payment_method, total_minor::float8 as total_minor, placed_at,
          customer_email, shipping_carrier_code, shipping_service_code
        from public.orders where id = ${orderId}::uuid and tenant_id = ${tenantId}::uuid`),
    )[0];
    if (!order) throw notFound('Order not found.', 'ORDER_NOT_FOUND');

    if (!SHIPPABLE.includes(order.status))
      throw conflict(
        order.status === 'pending_payment'
          ? 'This order is still waiting for payment.'
          : order.status === 'cancelled' || order.status === 'failed'
            ? 'This order was cancelled.'
            : `An order that is ${order.status.replaceAll('_', ' ')} cannot be shipped.`,
        undefined,
        'ORDER_NOT_SHIPPABLE',
      );
    const paymentMode: PaymentMode =
      order.payment_method === 'cod' ? 'cod' : 'prepaid';
    if (paymentMode === 'prepaid' && order.payment_status !== 'paid')
      throw conflict(
        'This order has not been paid, so it cannot be shipped.',
        undefined,
        'ORDER_NOT_PAID',
      );
    if (paymentMode === 'cod' && order.payment_status !== 'pending_collection')
      throw conflict(
        'This cash-on-delivery order has no cash left to collect, so it cannot be shipped.',
        undefined,
        'ORDER_NOT_PAID',
      );

    const pending = rowsOf<{ id: string }>(
      await tx.execute(sql`
        select id from public.shipments
        where tenant_id = ${tenantId}::uuid and order_id = ${orderId}::uuid and status = 'creating'`),
    )[0];
    if (pending)
      throw conflict(
        'A shipment for this order is already being booked. Finish or cancel it first.',
        { shipmentId: pending.id },
        'SHIPMENT_IN_PROGRESS',
      );

    const lines = rowsOf<{
      id: string;
      name: string;
      quantity: number;
      weight_grams: number;
      total_minor: number;
      shipped: number;
    }>(
      await tx.execute(sql`
        select oi.id, oi.name, oi.quantity, oi.weight_grams, oi.total_minor::float8 as total_minor,
          coalesce((select sum(si.quantity) from public.shipment_items si
                    join public.shipments s on s.tenant_id = si.tenant_id and s.id = si.shipment_id
                    where si.order_item_id = oi.id and s.status not in ('cancelled', 'failed')), 0)::int as shipped
        from public.order_items oi
        where oi.tenant_id = ${tenantId}::uuid and oi.order_id = ${orderId}::uuid order by oi.name, oi.id`),
    );
    const orderLines: OrderLine[] = lines.map((l) => ({
      id: l.id,
      name: l.name,
      quantity: l.quantity,
      shipped: l.shipped,
      weightGrams: l.weight_grams,
      totalMinor: Number(l.total_minor),
    }));
    const allocation = allocateItems(orderLines, dto.items);
    if (Object.keys(allocation.errors).length > 0)
      throw invalid(
        'Some of the items cannot go in this shipment.',
        allocation.errors,
        'SHIPMENT_ITEMS_INVALID',
      );
    if (
      paymentMode === 'cod' &&
      !carriesWholeOrder(orderLines, allocation.lines)
    )
      throw conflict(
        'A cash-on-delivery order ships in one parcel that carries every item, because the courier collects the whole amount.',
        undefined,
        'SHIPMENT_COD_SPLIT',
      );

    const weightGrams = dto.weightGrams ?? itemsWeight(allocation.lines);
    if (weightGrams <= 0 && !manual)
      throw invalid(
        'Enter the parcel weight.',
        {
          weightGrams:
            'Enter the parcel weight in grams (the products have no weight saved).',
        },
        'WEIGHT_REQUIRED',
      );
    const sizes = [dto.lengthCm, dto.breadthCm, dto.heightCm];
    const given = sizes.filter((v) => v !== undefined).length;
    if (given !== 0 && given !== 3)
      throw invalid(
        'Enter all three parcel sizes, or none.',
        { lengthCm: 'Enter length, breadth and height together.' },
        'DIMENSIONS_INCOMPLETE',
      );

    const destination = rowsOf<AddressRow>(
      await tx.execute(sql`
        select full_name, phone, line1, line2, city, state, postal_code from public.order_addresses
        where tenant_id = ${tenantId}::uuid and order_id = ${orderId}::uuid and kind = 'shipping'`),
    )[0];
    if (!destination)
      throw conflict(
        'This order has no delivery address.',
        undefined,
        'ORDER_NOT_SHIPPABLE',
      );
    const origin = rowsOf<OriginRow>(
      await tx.execute(sql`
        select name, phone, email, line1, line2, city, state, postal_code from public.tenant_shipping_origin
        where tenant_id = ${tenantId}::uuid`),
    )[0];
    if (!origin && !manual)
      throw invalid(
        'Set your pickup address in the shipping settings first.',
        undefined,
        'ORIGIN_MISSING',
      );

    return {
      order,
      lines: allocation.lines,
      paymentMode,
      codAmountMinor: paymentMode === 'cod' ? Number(order.total_minor) : 0,
      declaredValueMinor: itemsValue(allocation.lines),
      weightGrams,
      dims:
        given === 3
          ? {
              lengthCm: dto.lengthCm!,
              breadthCm: dto.breadthCm!,
              heightCm: dto.heightCm!,
            }
          : null,
      destination,
      // Only a carrier booking reads it, and a manual plan never reaches one.
      origin: origin as OriginRow,
    };
  }

  /** The carrier to book with: the Owner's choice, else the one priced at checkout, else what their settings pick. */
  private async chooseCarrier(
    tenantId: string,
    plan: Plan,
    dto: CreateShipmentDto,
  ): Promise<{ providerCode: string; serviceCode: string | null }> {
    if (dto.providerCode)
      return {
        providerCode: dto.providerCode,
        serviceCode: dto.serviceCode ?? null,
      };
    if (plan.order.shipping_carrier_code)
      return {
        providerCode: plan.order.shipping_carrier_code,
        serviceCode: dto.serviceCode ?? plan.order.shipping_service_code,
      };
    const r = await this.selection.choose(tenantId, {
      originPostalCode: plan.origin.postal_code,
      destinationPostalCode: plan.destination.postal_code,
      paymentMode: plan.paymentMode,
      weightGrams: plan.weightGrams,
      declaredValueMinor: plan.declaredValueMinor,
    });
    if (r.choice.candidate)
      return {
        providerCode: r.choice.candidate.providerCode,
        serviceCode: r.choice.candidate.serviceCode,
      };
    throw invalid(
      `Choose a carrier for this parcel. ${r.choice.reason}`,
      { providerCode: 'Choose a carrier.' },
      'CARRIER_REQUIRED',
    );
  }

  /** Everything the carrier needs, read from what the order saved (never from the live catalogue). */
  private async bookingInput(
    tx: DbTx,
    tenantId: string,
    row: ShipmentRow,
  ): Promise<{ row: ShipmentRow; shipment: ShipmentInput }> {
    const order = rowsOf<{
      order_number: number;
      placed_at: string | Date;
      customer_email: string | null;
    }>(
      await tx.execute(sql`
        select order_number, placed_at, customer_email from public.orders
        where id = ${row.order_id}::uuid and tenant_id = ${tenantId}::uuid`),
    )[0];
    const dest = rowsOf<AddressRow>(
      await tx.execute(sql`
        select full_name, phone, line1, line2, city, state, postal_code from public.order_addresses
        where tenant_id = ${tenantId}::uuid and order_id = ${row.order_id}::uuid and kind = 'shipping'`),
    )[0];
    const origin = rowsOf<OriginRow>(
      await tx.execute(sql`
        select name, phone, email, line1, line2, city, state, postal_code from public.tenant_shipping_origin
        where tenant_id = ${tenantId}::uuid`),
    )[0];
    if (!order || !dest)
      throw conflict(
        'This order has no delivery address.',
        undefined,
        'ORDER_NOT_SHIPPABLE',
      );
    if (!origin)
      throw invalid(
        'Set your pickup address in the shipping settings first.',
        undefined,
        'ORIGIN_MISSING',
      );
    const items = rowsOf<{
      name: string;
      sku: string | null;
      hsn_code: string | null;
      quantity: number;
      unit: number;
    }>(
      await tx.execute(sql`
        select oi.name, oi.sku, oi.hsn_code, si.quantity,
          round(oi.total_minor::numeric / oi.quantity)::float8 as unit
        from public.shipment_items si
        join public.order_items oi on oi.tenant_id = si.tenant_id and oi.id = si.order_item_id
        where si.tenant_id = ${tenantId}::uuid and si.shipment_id = ${row.id}::uuid order by oi.name, oi.id`),
    );
    const address = (
      a: AddressRow | OriginRow,
      email?: string | null,
    ): CarrierAddress => ({
      name: 'full_name' in a ? a.full_name : a.name,
      phone: a.phone,
      ...(email ? { email } : {}),
      line1: a.line1,
      ...(a.line2 ? { line2: a.line2 } : {}),
      city: a.city,
      state: a.state,
      postalCode: a.postal_code,
      country: 'IN',
    });
    const dims =
      row.length_cm && row.breadth_cm && row.height_cm
        ? {
            lengthCm: row.length_cm,
            breadthCm: row.breadth_cm,
            heightCm: row.height_cm,
          }
        : {};
    return {
      row,
      shipment: {
        // Stable for this shipment, so a resumed booking names the same order at the carrier.
        orderReference: `SF-${order.order_number}-${row.id.slice(0, 8)}`,
        orderNumber: order.order_number,
        orderDate: new Date(order.placed_at),
        paymentMode: row.payment_mode as PaymentMode,
        ...(row.payment_mode === 'cod'
          ? { codAmountMinor: Number(row.cod_amount_minor) }
          : {}),
        declaredValueMinor: Number(row.declared_value_minor),
        consignee: address(dest, order.customer_email),
        pickup: address(origin, origin.email),
        items: items.map((i) => ({
          name: i.name,
          ...(i.sku ? { sku: i.sku } : {}),
          quantity: i.quantity,
          unitPriceMinor: Number(i.unit),
          ...(i.hsn_code ? { hsnCode: i.hsn_code } : {}),
        })),
        parcel: { weightGrams: row.weight_grams, ...dims },
        ...(row.service_code ? { serviceCode: row.service_code } : {}),
        ...(row.provider_order_id || row.provider_shipment_id
          ? {
              resume: {
                ...(row.provider_order_id
                  ? { providerOrderId: row.provider_order_id }
                  : {}),
                ...(row.provider_shipment_id
                  ? { providerShipmentId: row.provider_shipment_id }
                  : {}),
              },
            }
          : {}),
      },
    };
  }

  // --- small helpers -------------------------------------------------------------------------------------------------

  private async row(tenantId: string, id: string): Promise<ShipmentRow> {
    return this.db.withCheckout(tenantId, async (tx) => {
      const r = rowsOf<ShipmentRow>(
        await tx.execute(sql`
          select ${COLUMNS} ${FROM}
          where s.tenant_id = ${tenantId}::uuid and s.id = ${id}::uuid`),
      )[0];
      if (!r) throw notFound('Shipment not found.', 'SHIPMENT_NOT_FOUND');
      return r;
    });
  }

  private async addEvent(
    tx: DbTx,
    tenantId: string,
    shipmentId: string,
    status: string,
    description: string,
    source: 'system' | 'owner',
  ): Promise<void> {
    await tx.execute(sql`
      insert into public.shipment_events (tenant_id, shipment_id, event_key, status, description, source)
      values (${tenantId}::uuid, ${shipmentId}::uuid, ${`${source}:${status}:${description}`.slice(0, 200)}, ${status}, ${description.slice(0, 500)}, ${source})
      on conflict (shipment_id, event_key) do nothing`);
  }

  private actor(ctx: OrgContext): OrderActor {
    return { type: ctx.role === 'owner' ? 'owner' : 'member', id: ctx.userId };
  }
}
