import { sql } from 'drizzle-orm';
import { conflict, notFound } from '../../common/app.exception.js';
import { rowsOf, type DbTx } from '../../database/database.service.js';
import type { OrderStatus } from '../../database/schema/enums.js';
import {
  assertTransition,
  InvalidTransitionError,
  type StatusActor,
} from './order-state.js';

export interface OrderActor {
  type: StatusActor;
  /** The signed-in user for owner/member actors, otherwise null. */
  id: string | null;
}

export interface LockedOrder {
  id: string;
  orderNumber: number;
  status: OrderStatus;
  paymentStatus: string;
  paymentMethod: string | null;
}

/** Locks one order of the tenant (FOR UPDATE) so concurrent status changes serialise. */
export async function lockOrder(
  tx: DbTx,
  tenantId: string,
  orderId: string,
): Promise<LockedOrder> {
  const row = rowsOf<{
    id: string;
    order_number: number;
    status: OrderStatus;
    payment_status: string;
    payment_method: string | null;
  }>(
    await tx.execute(sql`
      select id, order_number, status, payment_status, payment_method
      from public.orders
      where id = ${orderId}::uuid and tenant_id = ${tenantId}::uuid
      for update`),
  )[0];
  if (!row) throw notFound('Order not found.', 'ORDER_NOT_FOUND');
  return {
    id: row.id,
    orderNumber: row.order_number,
    status: row.status,
    paymentStatus: row.payment_status,
    paymentMethod: row.payment_method,
  };
}

/** Appends a status-history row. Also used for the first row of a new order (`from` = null). */
export async function recordStatus(
  tx: DbTx,
  tenantId: string,
  orderId: string,
  from: OrderStatus | null,
  to: OrderStatus,
  actor: OrderActor,
  note?: string,
): Promise<void> {
  await tx.execute(sql`
    insert into public.order_status_history (tenant_id, order_id, from_status, to_status, actor_type, actor_id, note)
    values (${tenantId}::uuid, ${orderId}::uuid, ${from}, ${to}, ${actor.type}, ${actor.id}::uuid, ${note ?? null})`);
}

/**
 * Moves an order to `to` if the state machine allows it for this actor, and records who did it. The caller owns the
 * transaction, so a failure anywhere after this call rolls the status change back as well.
 */
export async function transitionOrder(
  tx: DbTx,
  tenantId: string,
  orderId: string,
  to: OrderStatus,
  actor: OrderActor,
  note?: string,
): Promise<{ order: LockedOrder; from: OrderStatus }> {
  const order = await lockOrder(tx, tenantId, orderId);
  try {
    assertTransition(order.status, to, actor.type);
  } catch (error) {
    if (error instanceof InvalidTransitionError)
      throw conflict(error.message, undefined, 'ORDER_INVALID_TRANSITION');
    throw error;
  }
  await tx.execute(sql`
    update public.orders set status = ${to}, updated_at = now(),
      cancelled_at = case when ${to} = 'cancelled' then now() else cancelled_at end,
      cancel_reason = case when ${to} = 'cancelled' then ${note ?? null} else cancel_reason end
    where id = ${orderId}::uuid and tenant_id = ${tenantId}::uuid`);
  await recordStatus(tx, tenantId, orderId, order.status, to, actor, note);
  return { order: { ...order, status: to }, from: order.status };
}

/**
 * An order with a parcel still in the carrier's hands (or being booked) follows that parcel: its status is set by the shipment, and
 * it cannot be cancelled or moved by hand underneath it. Cancel the shipment first (only possible before pickup).
 */
export async function assertNoOpenShipment(
  tx: DbTx,
  tenantId: string,
  orderId: string,
): Promise<void> {
  const open = rowsOf<{ id: string }>(
    await tx.execute(sql`
      select id from public.shipments
      where tenant_id = ${tenantId}::uuid and order_id = ${orderId}::uuid
        and status in ('creating', 'created', 'picked_up', 'in_transit', 'out_for_delivery', 'undelivered', 'returning')
      limit 1`),
  )[0];
  if (open)
    throw conflict(
      'This order has a shipment in progress, so its status follows the carrier. Cancel the shipment first if it has not been picked up.',
      undefined,
      'ORDER_HAS_SHIPMENT',
    );
}
