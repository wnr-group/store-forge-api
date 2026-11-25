import { Injectable, Logger } from '@nestjs/common';
import { sql } from 'drizzle-orm';
import { AppException, notFound } from '../../common/app.exception.js';
import {
  DatabaseService,
  rowsOf,
  type DbTx,
} from '../../database/database.service.js';
import type { ShipmentStatus } from '../../database/schema/shipping.js';
import { NO_TENANT } from '../orders/checkout.service.js';
import {
  CarrierError,
  type TrackingResult,
} from '../shipping/providers/shipping-provider.js';
import { carrierProblem, ShipmentCarrier } from './shipment-carrier.js';
import { syncOrderWithShipments } from './shipment-order-sync.js';
import {
  awbsInPayload,
  canMoveShipment,
  eventKey,
  isOpenShipment,
  isWithCarrier,
  safeUrl,
  shipmentStatusOf,
} from './shipment-rules.js';

export type TrackingSource = 'carrier_api' | 'carrier_webhook' | 'owner';

export interface SyncResult {
  tenants: number;
  shipments: number;
  updated: number;
  failed: number;
}

interface TrackedRow {
  id: string;
  order_id: string;
  provider_code: string;
  status: ShipmentStatus;
  awb: string | null;
  provider_order_id: string | null;
  provider_shipment_id: string | null;
  last_synced_at: string | Date | null;
}

/** A shipment opened in the last few seconds is not asked about again just because a webhook arrived. */
const WEBHOOK_MIN_AGE_SECONDS = 20;
/** How old a parcel's last check must be before the scheduled sync asks the carrier again. */
const STALE_MINUTES = 25;
const MAX_WEBHOOK_SHIPMENTS = 10;

/**
 * Keeps shipments (and through them orders) in step with what the carriers say.
 *
 * Three things start a check: the Owner pressing "refresh", a carrier webhook, and the scheduled sync. All three do the same
 * thing: ask the carrier's tracking API, with the tenant's own credentials, what the parcel's status is NOW, and record the
 * answer. A webhook body is therefore only used to find which parcel changed; whatever it claims about the status is ignored,
 * so a forged webhook can at worst trigger a harmless extra lookup.
 */
@Injectable()
export class ShipmentTrackingService {
  private readonly logger = new Logger(ShipmentTrackingService.name);

  constructor(
    private readonly db: DatabaseService,
    private readonly carrier: ShipmentCarrier,
  ) {}

  /** Asks the carrier about one parcel and records the answer. Throws a safe error when the carrier cannot be reached. */
  async refresh(
    tenantId: string,
    shipmentId: string,
    source: TrackingSource,
  ): Promise<{ changed: boolean }> {
    const row = await this.db.withCheckout(tenantId, async (tx) => {
      const r = rowsOf<TrackedRow>(
        await tx.execute(sql`
          select id, order_id, provider_code, status, awb, provider_order_id, provider_shipment_id, last_synced_at
          from public.shipments where id = ${shipmentId}::uuid and tenant_id = ${tenantId}::uuid`),
      )[0];
      if (!r) throw notFound('Shipment not found.', 'SHIPMENT_NOT_FOUND');
      return r;
    });
    if (!row.awb || !isOpenShipment(row.status) || row.status === 'creating')
      return { changed: false };

    let tracking: TrackingResult;
    try {
      const { provider, credentials } = await this.carrier.open(
        tenantId,
        row.provider_code,
        false,
      );
      tracking = await provider.trackShipment(credentials, {
        awb: row.awb,
        providerOrderId: row.provider_order_id ?? undefined,
        providerShipmentId: row.provider_shipment_id ?? undefined,
      });
    } catch (error) {
      if (error instanceof CarrierError) {
        await this.noteProblem(tenantId, shipmentId, error);
        throw carrierProblem(error);
      }
      throw error;
    }
    return this.db.withCheckout(tenantId, (tx) =>
      this.apply(tx, tenantId, shipmentId, tracking, source),
    );
  }

  /**
   * Records a tracking answer: new history entries (each once), the shipment's own status (forward only), and then the order.
   * Runs in the caller's transaction.
   */
  async apply(
    tx: DbTx,
    tenantId: string,
    shipmentId: string,
    tracking: TrackingResult,
    source: TrackingSource,
  ): Promise<{ changed: boolean }> {
    const row = rowsOf<TrackedRow & { picked_up_at: unknown }>(
      await tx.execute(sql`
        select id, order_id, provider_code, status, awb, provider_order_id, provider_shipment_id, last_synced_at, picked_up_at
        from public.shipments where id = ${shipmentId}::uuid and tenant_id = ${tenantId}::uuid for update`),
    )[0];
    if (!row) throw notFound('Shipment not found.', 'SHIPMENT_NOT_FOUND');

    // Whoever asked, the facts come from the carrier: a webhook only says where they were noticed.
    const recordedAs =
      source === 'carrier_webhook' ? 'carrier_webhook' : 'carrier_api';
    let inserted = 0;
    for (const event of tracking.events.slice(0, 200)) {
      const done = rowsOf<{ id: string }>(
        await tx.execute(sql`
          insert into public.shipment_events (tenant_id, shipment_id, event_key, status, description, location, occurred_at, source)
          values (${tenantId}::uuid, ${shipmentId}::uuid, ${eventKey(event)}, ${event.status},
            ${event.description.slice(0, 500)}, ${event.location?.slice(0, 200) ?? null}, ${event.at ? event.at.toISOString() : null}::timestamptz, ${recordedAs})
          on conflict (shipment_id, event_key) do nothing returning id`),
      );
      inserted += done.length;
    }

    const next = shipmentStatusOf(tracking.status);
    const moves = next !== null && canMoveShipment(row.status, next);
    const url = safeUrl(tracking.trackingUrl);
    await tx.execute(sql`
      update public.shipments set
        status = ${moves ? next : row.status},
        tracking_url = coalesce(${url}::text, tracking_url),
        estimated_delivery = coalesce(${tracking.estimatedDelivery ? tracking.estimatedDelivery.toISOString() : null}::timestamptz, estimated_delivery),
        picked_up_at = case when ${moves && next !== null && isWithCarrier(next)} then coalesce(picked_up_at, now()) else picked_up_at end,
        delivered_at = case when ${moves && next === 'delivered'} then now() else delivered_at end,
        cancelled_at = case when ${moves && next === 'cancelled'} then now() else cancelled_at end,
        failure_reason = null,
        last_synced_at = now(), updated_at = now()
      where id = ${shipmentId}::uuid and tenant_id = ${tenantId}::uuid`);

    if (moves)
      await syncOrderWithShipments(
        tx,
        tenantId,
        row.order_id,
        { type: 'carrier', id: null },
        `Shipment ${row.awb ?? ''}: ${next}`.trim(),
      );
    return { changed: moves || inserted > 0 };
  }

  /** Remembers, for the Owner to see, that the carrier could not be asked. The parcel's status is left alone. */
  private async noteProblem(
    tenantId: string,
    shipmentId: string,
    error: CarrierError,
  ): Promise<void> {
    try {
      await this.db.withCheckout(tenantId, (tx) =>
        tx.execute(sql`
          update public.shipments set failure_reason = ${error.message.slice(0, 300)}, updated_at = now()
          where id = ${shipmentId}::uuid and tenant_id = ${tenantId}::uuid`),
      );
    } catch {
      // Best effort only: the real error is reported to the caller.
    }
  }

  // --- the scheduled sync ----------------------------------------------------------------------------------------------

  /**
   * Refreshes parcels on the road whose last check is old, a bounded amount per run. Driven by the scheduler (a Vercel Cron call
   * to the internal job route); correctness never depends on it, because webhooks and the Owner's refresh also update parcels.
   * One carrier or tenant failing never stops the others, and a parcel that cannot be checked is simply tried again next run.
   */
  async syncDue(tenantLimit = 50, perTenant = 25): Promise<SyncResult> {
    const tenants = await this.db.withCheckout(NO_TENANT, async (tx) =>
      rowsOf<{ t: string }>(
        await tx.execute(
          sql`select public.tenants_needing_shipment_sync(${tenantLimit}, ${STALE_MINUTES}) as t`,
        ),
      ).map((r) => r.t),
    );
    const result: SyncResult = {
      tenants: tenants.length,
      shipments: 0,
      updated: 0,
      failed: 0,
    };
    for (const tenantId of tenants) {
      const due = await this.db.withCheckout(tenantId, async (tx) =>
        rowsOf<{ id: string }>(
          await tx.execute(sql`
            select id from public.shipments
            where tenant_id = ${tenantId}::uuid and awb is not null
              and status in ('created', 'picked_up', 'in_transit', 'out_for_delivery', 'undelivered', 'returning')
              and (last_synced_at is null or last_synced_at < now() - make_interval(mins => ${STALE_MINUTES}))
            order by last_synced_at nulls first limit ${perTenant}`),
        ),
      );
      for (const { id } of due) {
        result.shipments += 1;
        try {
          const { changed } = await this.refresh(tenantId, id, 'carrier_api');
          if (changed) result.updated += 1;
        } catch (error) {
          result.failed += 1;
          this.logger.warn(
            `tracking sync failed for a shipment: ${error instanceof AppException ? error.code : error instanceof Error ? error.message : 'unknown'}`,
          );
        }
      }
    }
    return result;
  }

  // --- carrier webhooks ------------------------------------------------------------------------------------------------

  /**
   * A carrier says "something changed". The payload is NOT trusted for anything but the waybill numbers it mentions: for each
   * parcel found, the carrier is asked directly (with the tenant's own credentials) and that answer is what gets recorded.
   */
  async handleWebhook(providerCode: string, body: unknown): Promise<void> {
    const awbs = awbsInPayload(body);
    if (awbs.length === 0) return;
    const found = await this.db.withCheckout(NO_TENANT, async (tx) =>
      rowsOf<{ tenant_id: string; shipment_id: string }>(
        await tx.execute(sql`
          select tenant_id, shipment_id from public.shipments_for_carrier_webhook(${providerCode}, ${pgTextArray(awbs)}::text[])`),
      ),
    );
    for (const f of found.slice(0, MAX_WEBHOOK_SHIPMENTS)) {
      try {
        const fresh = await this.db.withCheckout(
          f.tenant_id,
          async (tx) =>
            rowsOf<{ ok: boolean }>(
              await tx.execute(sql`
              select (last_synced_at is null or last_synced_at < now() - make_interval(secs => ${WEBHOOK_MIN_AGE_SECONDS})) as ok
              from public.shipments where id = ${f.shipment_id}::uuid and tenant_id = ${f.tenant_id}::uuid`),
            )[0]?.ok,
        );
        if (!fresh) continue;
        await this.refresh(f.tenant_id, f.shipment_id, 'carrier_webhook');
      } catch (error) {
        // A failed lookup is retried by the scheduled sync; the carrier is always answered "received".
        this.logger.warn(
          `carrier webhook lookup failed: ${error instanceof AppException ? error.code : 'unknown'}`,
        );
      }
    }
  }
}

/** A Postgres text[] literal from a JS array (arrays given to `sql` templates are spread into a comma list instead). */
function pgTextArray(values: string[]) {
  return `{${values.map((v) => `"${v.replaceAll('\\', '\\\\').replaceAll('"', '\\"')}"`).join(',')}}`;
}
