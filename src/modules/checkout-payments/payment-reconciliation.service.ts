import { Injectable, Logger } from '@nestjs/common';
import { sql } from 'drizzle-orm';
import {
  DatabaseService,
  rowsOf,
  type DbTx,
} from '../../database/database.service.js';
import { NO_TENANT } from '../orders/checkout.service.js';
import { RazorpayClient, RazorpayError } from '../payments/razorpay.client.js';
import {
  loadRazorpayAccount,
  type RazorpayAccount,
} from '../payments/razorpay-credentials.js';
import { RefundsService } from '../payments/refunds.service.js';
import { settleCapturedPayment } from './payment-settlement.js';

export interface ReconciliationResult {
  tenants: number;
  paymentsSettled: number;
  refundsChecked: number;
  failedTenants: number;
  stoppedEarly: boolean;
}

/**
 * The safety net under the browser confirmation and the webhooks. A shopper may pay and close the tab, and a webhook may be
 * lost or arrive before we can use it; this job asks Razorpay about payments and refunds that have been waiting a while and
 * brings our records in line, using the same settlement code as everything else. It is driven by a scheduler (Vercel Cron),
 * works within a time budget so one run never outlives its function, and one tenant's trouble never stops the others.
 */
@Injectable()
export class PaymentReconciliationService {
  private readonly logger = new Logger(PaymentReconciliationService.name);

  constructor(
    private readonly db: DatabaseService,
    private readonly client: RazorpayClient,
    private readonly refunds: RefundsService,
  ) {}

  async reconcile(budgetMs = 20_000): Promise<ReconciliationResult> {
    const deadline = Date.now() + budgetMs;
    const tenants = await this.db.withCheckout(NO_TENANT, async (tx) =>
      rowsOf<{ t: string }>(
        await tx.execute(
          sql`select public.tenants_needing_payment_reconciliation(50) as t`,
        ),
      ).map((r) => r.t),
    );
    const result: ReconciliationResult = {
      tenants: tenants.length,
      paymentsSettled: 0,
      refundsChecked: 0,
      failedTenants: 0,
      stoppedEarly: false,
    };
    for (const tenantId of tenants) {
      if (Date.now() > deadline) {
        result.stoppedEarly = true;
        break;
      }
      try {
        const done = await this.reconcileTenant(tenantId, deadline);
        result.paymentsSettled += done.paymentsSettled;
        result.refundsChecked += done.refundsChecked;
      } catch (error) {
        result.failedTenants += 1;
        this.logger.error({
          event: 'reconcile.tenant_failed',
          tenantId,
          name: (error as Error).name,
        });
      }
    }
    return result;
  }

  private async reconcileTenant(tenantId: string, deadline: number) {
    const { account, candidates, openRefunds } = await this.db.withCheckout(
      tenantId,
      async (tx) => {
        const account = await loadRazorpayAccount(tx, tenantId);
        return {
          account,
          candidates: await this.pendingPayments(tx, tenantId),
          openRefunds: await this.openRefunds(tx, tenantId),
        };
      },
    );
    let paymentsSettled = 0;
    let refundsChecked = 0;
    if (!account) return { paymentsSettled, refundsChecked };

    for (const c of candidates) {
      if (Date.now() > deadline) break;
      try {
        if (await this.settleFromRazorpay(tenantId, account, c))
          paymentsSettled += 1;
      } catch (error) {
        // Razorpay trouble is simply tried again on the next run.
        if (!(error instanceof RazorpayError)) throw error;
        this.logger.warn({
          event: 'reconcile.payment_lookup_failed',
          tenantId,
          kind: error.kind,
        });
      }
    }
    for (const refundId of openRefunds) {
      if (Date.now() > deadline) break;
      try {
        await this.refunds.drive(tenantId, refundId);
        refundsChecked += 1;
      } catch (error) {
        this.logger.warn({
          event: 'reconcile.refund_sync_failed',
          tenantId,
          name: (error as Error).name,
        });
      }
    }
    return { paymentsSettled, refundsChecked };
  }

  private async settleFromRazorpay(
    tenantId: string,
    account: RazorpayAccount,
    c: {
      id: string;
      razorpay_order_id: string;
      amount_minor: number;
      currency: string;
      order_status: string;
    },
  ): Promise<boolean> {
    const payments = await this.client.fetchOrderPayments(
      account,
      c.razorpay_order_id,
    );
    const fits = (p: { amountMinor: number; currency: string }) =>
      p.amountMinor === Number(c.amount_minor) && p.currency === c.currency;
    let winner = payments.find((p) => p.status === 'captured' && fits(p));
    if (!winner && c.order_status === 'pending_payment') {
      const authorized = payments.find(
        (p) => p.status === 'authorized' && fits(p),
      );
      if (authorized)
        winner = await this.client.capturePayment(
          account,
          authorized.id,
          Number(c.amount_minor),
          c.currency,
        );
    }
    if (!winner || winner.status !== 'captured') return false;
    const captured = winner;
    const outcome = await this.db.withCheckout(tenantId, (tx) =>
      settleCapturedPayment(tx, tenantId, c.id, {
        id: captured.id,
        method: captured.method,
      }),
    );
    if (outcome === 'applied')
      this.logger.log({
        event: 'reconcile.payment_settled',
        tenantId,
        razorpayOrderId: c.razorpay_order_id,
      });
    return outcome === 'applied';
  }

  private async pendingPayments(tx: DbTx, tenantId: string) {
    return rowsOf<{
      id: string;
      razorpay_order_id: string;
      amount_minor: number;
      currency: string;
      order_status: string;
    }>(
      await tx.execute(sql`
        select t.id, t.razorpay_order_id, t.amount_minor::float8 as amount_minor, t.currency, o.status as order_status
        from public.payment_transactions t join public.orders o on o.id = t.order_id and o.tenant_id = t.tenant_id
        where t.tenant_id = ${tenantId}::uuid and t.provider = 'razorpay' and t.status in ('created', 'authorized', 'failed')
          and t.updated_at < now() - interval '10 minutes' and t.created_at > now() - interval '3 days'
        order by t.updated_at limit 20`),
    );
  }

  private async openRefunds(tx: DbTx, tenantId: string): Promise<string[]> {
    return rowsOf<{ id: string }>(
      await tx.execute(sql`
        select id from public.refunds where tenant_id = ${tenantId}::uuid and status in ('pending', 'processing')
          and updated_at < now() - interval '10 minutes' order by updated_at limit 20`),
    ).map((r) => r.id);
  }
}
