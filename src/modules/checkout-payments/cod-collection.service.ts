import { Injectable } from '@nestjs/common';
import { sql } from 'drizzle-orm';
import { conflict } from '../../common/app.exception.js';
import type { OrgContext } from '../../common/interfaces/request-context.js';
import { DatabaseService } from '../../database/database.service.js';
import { lockOrder } from '../orders/order-transitions.js';

/**
 * Cash on delivery is only "paid" once the cash has actually been collected. The Owner (or a member with orders write access)
 * confirms the collection; until then the order's payment status stays `pending_collection`.
 */
@Injectable()
export class CodCollectionService {
  constructor(private readonly db: DatabaseService) {}

  /** The authorisation (`orders:manage`) was checked by the controller; the pinned role can only reach this tenant's rows. */
  collect(org: OrgContext, orderId: string): Promise<void> {
    return this.db.withCheckout(org.tenantId, async (tx) => {
      const order = await lockOrder(tx, org.tenantId, orderId);
      if (order.paymentMethod !== 'cod')
        throw conflict(
          'Only cash on delivery orders can be marked as collected.',
          undefined,
          'NOT_COD',
        );
      if (order.paymentStatus === 'collected') return; // already recorded: idempotent
      if (order.paymentStatus !== 'pending_collection')
        throw conflict(
          'There is no cash to collect for this order.',
          undefined,
          'NOTHING_TO_COLLECT',
        );
      if (!['shipped', 'out_for_delivery', 'delivered'].includes(order.status))
        throw conflict(
          'Cash can be marked as collected once the order has been handed to the carrier.',
          undefined,
          'COD_NOT_DELIVERED',
        );
      await tx.execute(sql`
        update public.payment_transactions set status = 'collected', collected_at = now(), collected_by = ${org.userId}::uuid, updated_at = now()
        where order_id = ${orderId}::uuid and tenant_id = ${org.tenantId}::uuid and provider = 'cod' and status = 'pending_collection'`);
      await tx.execute(sql`
        update public.orders set payment_status = 'collected', updated_at = now()
        where id = ${orderId}::uuid and tenant_id = ${org.tenantId}::uuid`);
    });
  }
}
