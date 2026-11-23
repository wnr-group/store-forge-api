import { Injectable, Logger } from '@nestjs/common';
import { sql } from 'drizzle-orm';
import { DatabaseService, rowsOf } from '../../database/database.service.js';
import { NO_TENANT } from './checkout.service.js';
import { lockOrder, transitionOrder } from './order-transitions.js';
import { releaseReservations } from './stock-reservations.js';

export interface ExpiryResult {
  tenants: number;
  orders: number;
  failedTenants: number;
}

/**
 * Cleans up unpaid orders whose stock hold ran out. It is driven by a scheduler (a Vercel Cron call to the internal job
 * route), not by a timer in the process, because the API runs as short-lived serverless functions. Correctness never depends
 * on it: an expired hold already stops reserving stock the instant it expires. This job only closes the order and the hold.
 */
@Injectable()
export class ReservationExpiryService {
  private readonly logger = new Logger(ReservationExpiryService.name);

  constructor(private readonly db: DatabaseService) {}

  async expireDue(tenantLimit = 100): Promise<ExpiryResult> {
    const tenants = await this.db.withCheckout(NO_TENANT, async (tx) =>
      rowsOf<{ t: string }>(
        await tx.execute(
          sql`select public.tenants_with_expired_reservations(${tenantLimit}) as t`,
        ),
      ).map((r) => r.t),
    );
    const result: ExpiryResult = {
      tenants: tenants.length,
      orders: 0,
      failedTenants: 0,
    };
    for (const tenantId of tenants) {
      try {
        result.orders += await this.expireTenant(tenantId);
      } catch (error) {
        // One tenant's problem must not stop the others; it is retried on the next run.
        result.failedTenants += 1;
        this.logger.error(
          `reservation expiry failed for a tenant: ${error instanceof Error ? error.message : 'unknown'}`,
        );
      }
    }
    return result;
  }

  private expireTenant(tenantId: string): Promise<number> {
    return this.db.withCheckout(tenantId, async (tx) => {
      // SKIP LOCKED: a checkout or payment handling the same order right now wins, and we pick it up next time.
      const due = rowsOf<{ order_id: string }>(
        await tx.execute(sql`
          select distinct order_id from (
            select order_id from public.inventory_reservations
            where tenant_id = ${tenantId}::uuid and status = 'active' and expires_at <= now()
            order by expires_at limit 200 for update skip locked) due`),
      );
      let closed = 0;
      for (const { order_id } of due) {
        const order = await lockOrder(tx, tenantId, order_id);
        if (order.status === 'pending_payment') {
          await transitionOrder(
            tx,
            tenantId,
            order_id,
            'cancelled',
            { type: 'system', id: null },
            'Payment window expired',
          );
          closed += 1;
        }
        await releaseReservations(tx, tenantId, order_id, 'expired');
      }
      return closed;
    });
  }
}
