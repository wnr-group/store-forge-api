import { sql } from 'drizzle-orm';
import { conflict } from '../../common/app.exception.js';
import { rowsOf, type DbTx } from '../../database/database.service.js';
import { stockKey, type PricedLine } from './checkout-pricing.js';

/**
 * Stock reservations. On-hand stock stays in `products.quantity` / `product_variants.quantity`; a reservation only HOLDS
 * units for an unpaid order. Available = on hand - active, unexpired reservations. An expired reservation stops holding
 * stock the moment it expires, so correctness never depends on the cleanup job having run.
 *
 * Every function runs inside the caller's transaction and as the tenant-pinned checkout role. Writers lock the stock row
 * FOR UPDATE before they read what is held, so two checkouts for the last unit serialise instead of both succeeding.
 */

/** Units held by active, unexpired reservations, keyed by `stockKey(productId, variantId)`. */
export async function heldQuantities(
  tx: DbTx,
  tenantId: string,
  productIds: readonly string[],
  excludeOrderId?: string,
): Promise<Map<string, number>> {
  const held = new Map<string, number>();
  if (productIds.length === 0) return held;
  const ids = sql.join(
    productIds.map((id) => sql`${id}::uuid`),
    sql`, `,
  );
  const rows = rowsOf<{
    product_id: string;
    variant_id: string | null;
    held: number;
  }>(
    await tx.execute(sql`
      select product_id, variant_id, sum(quantity)::int as held
      from public.inventory_reservations
      where tenant_id = ${tenantId}::uuid and status = 'active' and expires_at > now()
        and product_id in (${ids})
        ${excludeOrderId ? sql`and order_id <> ${excludeOrderId}::uuid` : sql``}
      group by product_id, variant_id`),
  );
  for (const r of rows) held.set(stockKey(r.product_id, r.variant_id), r.held);
  return held;
}

/** Records the holds for a new order. The caller already locked the stock rows and validated availability. */
export async function insertReservations(
  tx: DbTx,
  tenantId: string,
  orderId: string,
  lines: readonly PricedLine[],
  expiresAt: Date,
): Promise<void> {
  for (const line of lines) {
    if (!line.trackInventory) continue;
    await tx.execute(sql`
      insert into public.inventory_reservations (tenant_id, order_id, product_id, variant_id, quantity, expires_at)
      values (${tenantId}::uuid, ${orderId}::uuid, ${line.productId}::uuid, ${line.variantId}::uuid, ${line.quantity},
        ${expiresAt.toISOString()}::timestamptz)`);
  }
}

interface ReservationRow {
  id: string;
  product_id: string;
  variant_id: string | null;
  quantity: number;
}

async function reservationsOf(
  tx: DbTx,
  tenantId: string,
  orderId: string,
  status: 'active' | 'committed',
): Promise<ReservationRow[]> {
  // product_id then variant_id: one global order, so two transactions touching the same rows cannot deadlock.
  return rowsOf<ReservationRow>(
    await tx.execute(sql`
      select id, product_id, variant_id, quantity
      from public.inventory_reservations
      where tenant_id = ${tenantId}::uuid and order_id = ${orderId}::uuid and status = ${status}
      order by product_id, variant_id nulls first
      for update`),
  );
}

async function ledger(
  tx: DbTx,
  tenantId: string,
  r: ReservationRow,
  delta: number,
  quantityAfter: number,
  reason: 'sale' | 'return',
  note: string,
) {
  await tx.execute(sql`
    insert into public.inventory_adjustments (tenant_id, product_id, variant_id, delta, quantity_after, reason, note)
    values (${tenantId}::uuid, ${r.product_id}::uuid, ${r.variant_id}::uuid, ${delta}, ${quantityAfter}, ${reason}, ${note})`);
}

/**
 * Turns an order's active reservations into real sales: stock goes down, the movement is written to the inventory
 * ledger, and the reservation is closed as `committed`. Fails (and the caller's transaction rolls back) if the stock is no
 * longer there, which can only happen when a payment arrives after the reservation had expired and the units were taken.
 */
export async function commitReservations(
  tx: DbTx,
  tenantId: string,
  orderId: string,
  orderNumber: number,
): Promise<void> {
  for (const r of await reservationsOf(tx, tenantId, orderId, 'active')) {
    const table = r.variant_id
      ? sql`public.product_variants`
      : sql`public.products`;
    const idColumn = r.variant_id ?? r.product_id;
    // Lock the stock row, then see what other unpaid orders still hold before taking units out of it.
    const stock = rowsOf<{ quantity: number }>(
      await tx.execute(sql`
        select quantity from ${table} where id = ${idColumn}::uuid and tenant_id = ${tenantId}::uuid for update`),
    )[0];
    const others = rowsOf<{ held: number }>(
      await tx.execute(sql`
        select coalesce(sum(quantity), 0)::int as held from public.inventory_reservations
        where tenant_id = ${tenantId}::uuid and status = 'active' and expires_at > now()
          and product_id = ${r.product_id}::uuid and variant_id is not distinct from ${r.variant_id}::uuid
          and order_id <> ${orderId}::uuid`),
    )[0];
    if (!stock || stock.quantity - (others?.held ?? 0) < r.quantity)
      throw conflict(
        'Some items are no longer in stock.',
        undefined,
        'RESERVATION_LOST',
      );
    const after = stock.quantity - r.quantity;
    await tx.execute(sql`
      update ${table} set quantity = ${after}, updated_at = now()
      where id = ${idColumn}::uuid and tenant_id = ${tenantId}::uuid`);
    await ledger(
      tx,
      tenantId,
      r,
      -r.quantity,
      after,
      'sale',
      `Order #${orderNumber}`,
    );
    await tx.execute(sql`
      update public.inventory_reservations set status = 'committed', resolved_at = now() where id = ${r.id}::uuid`);
  }
}

/** Gives held stock back without ever having taken it (payment failed, order cancelled early, or the hold expired). */
export async function releaseReservations(
  tx: DbTx,
  tenantId: string,
  orderId: string,
  as: 'released' | 'expired' = 'released',
): Promise<number> {
  const rows = rowsOf<{ id: string }>(
    await tx.execute(sql`
      update public.inventory_reservations set status = ${as}, resolved_at = now()
      where tenant_id = ${tenantId}::uuid and order_id = ${orderId}::uuid and status = 'active'
      returning id`),
  );
  return rows.length;
}

/** Puts units that were already sold back on the shelf (a cancelled order that had been committed). */
export async function restockCommitted(
  tx: DbTx,
  tenantId: string,
  orderId: string,
  orderNumber: number,
): Promise<void> {
  for (const r of await reservationsOf(tx, tenantId, orderId, 'committed')) {
    const table = r.variant_id
      ? sql`public.product_variants`
      : sql`public.products`;
    const idColumn = r.variant_id ?? r.product_id;
    const updated = rowsOf<{ quantity: number }>(
      await tx.execute(sql`
        update ${table} set quantity = quantity + ${r.quantity}, updated_at = now()
        where id = ${idColumn}::uuid and tenant_id = ${tenantId}::uuid returning quantity`),
    )[0];
    // The product or variant may have been deleted since the sale; then there is no shelf to return units to.
    if (updated)
      await ledger(
        tx,
        tenantId,
        r,
        r.quantity,
        updated.quantity,
        'return',
        `Order #${orderNumber} cancelled`,
      );
    await tx.execute(sql`
      update public.inventory_reservations set status = 'restocked', resolved_at = now() where id = ${r.id}::uuid`);
  }
}
