import { Logger } from '@nestjs/common';
import { sql } from 'drizzle-orm';
import { AppException } from '../../common/app.exception.js';
import { rowsOf, type DbTx } from '../../database/database.service.js';
import type { ShipmentStatus } from '../../database/schema/shipping.js';
import {
  lockOrder,
  transitionOrder,
  type OrderActor,
} from '../orders/order-transitions.js';
import {
  fulfillmentStatusFor,
  orderStatusFor,
  orderSteps,
} from './shipment-rules.js';

const logger = new Logger('ShipmentOrderSync');

/**
 * Brings an order in line with its shipments: how much of it has gone out (`fulfillment_status`) and which stage it is at
 * (`status`), one step at a time so the order's history shows every stage it really passed. Runs inside the caller's
 * transaction, so a shipment change and the order change it causes either both happen or neither does.
 *
 * It only ever moves an order FORWARD. If the order cannot make a step (it was cancelled, or someone set it by hand), the order
 * is left as it is: the shipment's own record stays correct and nothing is thrown at the carrier update that triggered this.
 */
export async function syncOrderWithShipments(
  tx: DbTx,
  tenantId: string,
  orderId: string,
  actor: OrderActor,
  note: string | null,
): Promise<void> {
  const shipments = rowsOf<{ status: ShipmentStatus }>(
    await tx.execute(
      sql`select status from public.shipments where tenant_id = ${tenantId}::uuid and order_id = ${orderId}::uuid`,
    ),
  );
  const coverage = rowsOf<{ quantity: number; shipped: number }>(
    await tx.execute(sql`
      select oi.quantity,
        coalesce((select sum(si.quantity) from public.shipment_items si
                  join public.shipments s on s.tenant_id = si.tenant_id and s.id = si.shipment_id
                  where si.order_item_id = oi.id and s.status not in ('cancelled', 'failed')), 0)::int as shipped
      from public.order_items oi
      where oi.tenant_id = ${tenantId}::uuid and oi.order_id = ${orderId}::uuid`),
  );
  const fullyCovered =
    coverage.length > 0 && coverage.every((c) => c.shipped >= c.quantity);
  const anyCovered = coverage.some((c) => c.shipped > 0);

  await tx.execute(sql`
    update public.orders set fulfillment_status = ${fulfillmentStatusFor(shipments, fullyCovered, anyCovered)}, updated_at = now()
    where id = ${orderId}::uuid and tenant_id = ${tenantId}::uuid`);

  const target = orderStatusFor(shipments, fullyCovered);
  if (!target) return;
  const order = await lockOrder(tx, tenantId, orderId);
  for (const step of orderSteps(order.status, target)) {
    try {
      await transitionOrder(
        tx,
        tenantId,
        orderId,
        step,
        // Booking is the Owner's doing; every later step is the carrier's.
        step === 'processing' || step === 'ready_to_ship'
          ? actor
          : { type: 'carrier', id: null },
        note ?? undefined,
      );
    } catch (error) {
      if (error instanceof AppException && error.kind === 'CONFLICT') {
        logger.warn(
          `an order stayed at its status while its shipment moved on (${error.code})`,
        );
        return;
      }
      throw error;
    }
  }
}
