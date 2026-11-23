import { Injectable, Logger } from '@nestjs/common';
import { sql } from 'drizzle-orm';
import { AppException, conflict, invalid } from '../../common/app.exception.js';
import {
  DatabaseService,
  rowsOf,
  type DbTx,
} from '../../database/database.service.js';
import type { PublicOrderDto } from '../orders/checkout.dto.js';
import { CheckoutService, type OrderRow } from '../orders/checkout.service.js';
import {
  RazorpayClient,
  RazorpayError,
  type RazorpayPayment,
} from '../payments/razorpay.client.js';
import {
  loadRazorpayAccount,
  type RazorpayAccount,
} from '../payments/razorpay-credentials.js';
import { verifyCheckoutSignature } from '../payments/razorpay-signature.js';
import { PAYMENTS_UNAVAILABLE_MESSAGE } from '../payments/payments.service.js';
import { settleCapturedPayment } from './payment-settlement.js';
import type {
  RazorpaySessionDto,
  ReportRazorpayFailureDto,
  VerifyRazorpayPaymentDto,
} from './checkout-payments.dto.js';

interface TxRow {
  id: string;
  status: string;
  razorpay_order_id: string;
  razorpay_payment_id: string | null;
}

function sqlstate(error: unknown): string | undefined {
  let current = error as { code?: unknown; cause?: unknown } | undefined;
  for (let depth = 0; depth < 5 && current; depth++) {
    if (typeof current.code === 'string' && /^[0-9A-Z]{5}$/.test(current.code))
      return current.code;
    current = current.cause as typeof current;
  }
  return undefined;
}

/**
 * The online payment flow, in the order it happens:
 *   1. createPayment: a Razorpay order is created for the amount the SERVER computed. Calling it again reuses it.
 *   2. The shopper pays in Razorpay Checkout.
 *   3. verify: the browser's three values are checked (signature) AND Razorpay is asked directly about the payment (amount,
 *      order, status). Only then does money state change. Nothing the browser says is enough on its own.
 *
 * No database transaction is ever held open across a call to Razorpay: each step reads (and locks) what it needs, commits,
 * calls out, then applies the result in a fresh transaction that re-checks the state.
 */
@Injectable()
export class RazorpayPaymentsService {
  private readonly logger = new Logger(RazorpayPaymentsService.name);

  constructor(
    private readonly db: DatabaseService,
    private readonly checkout: CheckoutService,
    private readonly client: RazorpayClient,
  ) {}

  async createPayment(
    slug: string,
    orderNumber: number,
    token: string | undefined,
  ): Promise<RazorpaySessionDto> {
    const store = await this.checkout.resolveStore(slug);
    const { order, account, existing, customer } = await this.db.withCheckout(
      store.tenantId,
      async (tx) => {
        const order = await this.checkout.findByToken(
          tx,
          store.tenantId,
          orderNumber,
          token,
        );
        if (
          order.payment_method !== 'razorpay' ||
          order.status !== 'pending_payment'
        )
          throw conflict(
            'This order cannot be paid online.',
            undefined,
            'ORDER_NOT_PAYABLE',
          );
        await this.assertHoldIsLive(tx, store.tenantId, order.id);
        const existing = await this.transactionOf(
          tx,
          store.tenantId,
          order.id,
          true,
        );
        if (existing?.status === 'captured' || order.payment_status === 'paid')
          throw conflict(
            'This order has already been paid.',
            undefined,
            'ALREADY_PAID',
          );
        const account = await this.account(tx, store.tenantId, {
          mustBeEnabled: true,
        });
        if (existing)
          await tx.execute(
            sql`update public.payment_transactions set attempts = attempts + 1, updated_at = now() where id = ${existing.id}::uuid`,
          );
        const customer = rowsOf<{
          name: string | null;
          email: string | null;
          phone: string | null;
        }>(
          await tx.execute(sql`
            select customer_name as name, customer_email as email, customer_phone as phone
            from public.orders where id = ${order.id}::uuid`),
        )[0];
        return { order, account, existing, customer };
      },
    );
    const session = (razorpayOrderId: string): RazorpaySessionDto => ({
      keyId: account.keyId,
      razorpayOrderId,
      amountMinor: Number(order.total_minor),
      currency: order.currency,
      orderNumber: order.order_number,
      customer: {
        name: customer?.name ?? '',
        email: customer?.email ?? '',
        contact: customer?.phone ?? '',
      },
    });
    // A Razorpay order can take several payment attempts, so a retry after a failure reuses it.
    if (existing) return session(existing.razorpay_order_id);

    const created = await this.call(() =>
      this.client.createOrder(account, {
        amountMinor: Number(order.total_minor),
        currency: order.currency,
        receipt: `SF-${order.order_number}`,
        notes: { orderNumber: String(order.order_number), store: slug },
      }),
    );
    if (
      created.amountMinor !== Number(order.total_minor) ||
      created.currency !== order.currency
    )
      throw new AppException(
        'UNAVAILABLE',
        'Online payment is temporarily unavailable.',
        {
          code: 'PAYMENT_PROVIDER_UNAVAILABLE',
        },
      );
    try {
      await this.db.withCheckout(store.tenantId, (tx) =>
        tx.execute(sql`
          insert into public.payment_transactions (tenant_id, order_id, provider, status, amount_minor, currency, razorpay_order_id, attempts)
          values (${store.tenantId}::uuid, ${order.id}::uuid, 'razorpay', 'created', ${Number(order.total_minor)}, ${order.currency}, ${created.id}, 1)`),
      );
    } catch (error) {
      // A concurrent call created its Razorpay order first: use that one. Ours stays unpaid at Razorpay and is harmless.
      if (sqlstate(error) !== '23505') throw error;
      const winner = await this.db.withCheckout(store.tenantId, (tx) =>
        this.transactionOf(tx, store.tenantId, order.id, false),
      );
      if (!winner) throw error;
      return session(winner.razorpay_order_id);
    }
    return session(created.id);
  }

  async verifyPayment(
    slug: string,
    orderNumber: number,
    token: string | undefined,
    dto: VerifyRazorpayPaymentDto,
  ): Promise<PublicOrderDto> {
    const store = await this.checkout.resolveStore(slug);
    const { order, row, account } = await this.open(
      store.tenantId,
      orderNumber,
      token,
      dto.razorpay_order_id,
    );

    // 1. The browser's values must carry a valid signature made with this tenant's own secret.
    if (
      !verifyCheckoutSignature(
        dto.razorpay_order_id,
        dto.razorpay_payment_id,
        dto.razorpay_signature,
        account.keySecret,
      )
    ) {
      this.logger.warn({
        event: 'payment.signature_invalid',
        tenantId: store.tenantId,
        orderNumber,
      });
      throw invalid(
        'We could not verify this payment.',
        undefined,
        'PAYMENT_SIGNATURE_INVALID',
      );
    }
    if (
      row.status === 'captured' &&
      row.razorpay_payment_id === dto.razorpay_payment_id
    )
      return this.show(store.tenantId, orderNumber, token);

    // 2. Ask Razorpay itself. The signature proves the browser holds Razorpay's answer, not that the payment is what we expect.
    let payment = await this.call(() =>
      this.client.fetchPayment(account, dto.razorpay_payment_id),
    );
    this.assertMatches(payment, dto.razorpay_order_id, order);
    if (payment.status === 'authorized') {
      // Only an order that can still be fulfilled is captured; an uncaptured authorisation is released by Razorpay.
      if (order.status !== 'pending_payment')
        throw conflict(
          'This order can no longer be paid.',
          undefined,
          'ORDER_NOT_PAYABLE',
        );
      payment = await this.call(() =>
        this.client.capturePayment(
          account,
          payment.id,
          Number(order.total_minor),
          order.currency,
        ),
      );
      this.assertMatches(payment, dto.razorpay_order_id, order);
    }
    if (payment.status === 'failed') {
      await this.recordFailure(store.tenantId, row.id, payment);
      throw conflict(
        'The payment did not go through. You can try again.',
        undefined,
        'PAYMENT_FAILED',
      );
    }
    if (payment.status !== 'captured')
      throw conflict(
        'The payment is still being processed.',
        undefined,
        'PAYMENT_PENDING',
      );

    // 3. Money is confirmed: apply it in one transaction.
    await this.db.withCheckout(store.tenantId, (tx) =>
      settleCapturedPayment(tx, store.tenantId, row.id, payment).catch(
        (error) => {
          if (sqlstate(error) === '23505')
            throw conflict(
              'This payment has already been used.',
              undefined,
              'DUPLICATE_PAYMENT',
            );
          throw error;
        },
      ),
    );
    this.logger.log({
      event: 'payment.captured',
      tenantId: store.tenantId,
      orderNumber,
      razorpayPaymentId: payment.id,
    });
    return this.show(store.tenantId, orderNumber, token);
  }

  /** The browser says a payment failed. Razorpay is asked; only what Razorpay answers is recorded. */
  async reportFailure(
    slug: string,
    orderNumber: number,
    token: string | undefined,
    dto: ReportRazorpayFailureDto,
  ): Promise<PublicOrderDto> {
    const store = await this.checkout.resolveStore(slug);
    const { order, row, account } = await this.open(
      store.tenantId,
      orderNumber,
      token,
      dto.razorpay_order_id,
    );
    const payment = await this.call(() =>
      this.client.fetchPayment(account, dto.razorpay_payment_id),
    );
    this.assertMatches(payment, dto.razorpay_order_id, order);
    if (payment.status !== 'failed')
      throw conflict(
        'That payment has not failed.',
        undefined,
        'PAYMENT_NOT_FAILED',
      );
    await this.recordFailure(store.tenantId, row.id, payment);
    return this.show(store.tenantId, orderNumber, token);
  }

  // --- internals ---------------------------------------------------------------------------------------------

  /** Reads the order, its Razorpay transaction and the account in one short transaction. */
  private open(
    tenantId: string,
    orderNumber: number,
    token: string | undefined,
    razorpayOrderId: string,
  ) {
    return this.db.withCheckout(tenantId, async (tx) => {
      const order = await this.checkout.findByToken(
        tx,
        tenantId,
        orderNumber,
        token,
      );
      const row = await this.transactionOf(tx, tenantId, order.id, false);
      if (order.payment_method !== 'razorpay' || !row)
        throw conflict(
          'No online payment was started for this order.',
          undefined,
          'NO_PAYMENT_STARTED',
        );
      if (row.razorpay_order_id !== razorpayOrderId)
        throw invalid(
          'These payment details do not belong to this order.',
          undefined,
          'PAYMENT_MISMATCH',
        );
      // A shopper who already paid must still be able to finish even if the Owner switched Razorpay off meanwhile.
      const account = await this.account(tx, tenantId, {
        mustBeEnabled: false,
      });
      return { order, row, account };
    });
  }

  private async transactionOf(
    tx: DbTx,
    tenantId: string,
    orderId: string,
    lock: boolean,
  ): Promise<TxRow | undefined> {
    return rowsOf<TxRow>(
      await tx.execute(sql`
        select id, status, razorpay_order_id, razorpay_payment_id from public.payment_transactions
        where tenant_id = ${tenantId}::uuid and order_id = ${orderId}::uuid and provider = 'razorpay'
        ${lock ? sql`for update` : sql``}`),
    )[0];
  }

  private async account(
    tx: DbTx,
    tenantId: string,
    opts: { mustBeEnabled: boolean },
  ): Promise<RazorpayAccount> {
    let account: RazorpayAccount | null;
    try {
      account = await loadRazorpayAccount(tx, tenantId);
    } catch (error) {
      this.logger.error({
        event: 'payment.credentials_unreadable',
        tenantId,
        name: (error as Error).name,
      });
      throw new AppException('UNAVAILABLE', PAYMENTS_UNAVAILABLE_MESSAGE, {
        code: 'PAYMENTS_UNAVAILABLE',
      });
    }
    if (
      !account ||
      (opts.mustBeEnabled && !(account.enabled && account.verified))
    )
      throw conflict(
        'Online payment is not available for this store.',
        undefined,
        'PAYMENT_METHOD_UNAVAILABLE',
      );
    return account;
  }

  private async assertHoldIsLive(tx: DbTx, tenantId: string, orderId: string) {
    const r = rowsOf<{ total: number; live: number }>(
      await tx.execute(sql`
        select count(*)::int as total, count(*) filter (where status = 'active' and expires_at > now())::int as live
        from public.inventory_reservations where tenant_id = ${tenantId}::uuid and order_id = ${orderId}::uuid`),
    )[0];
    if (r.total > 0 && r.live === 0)
      throw conflict(
        'The time to pay for this order has run out. Please place the order again.',
        undefined,
        'ORDER_EXPIRED',
      );
  }

  private assertMatches(
    payment: RazorpayPayment,
    razorpayOrderId: string,
    order: OrderRow,
  ) {
    if (
      payment.orderId !== razorpayOrderId ||
      payment.amountMinor !== Number(order.total_minor) ||
      payment.currency !== order.currency
    ) {
      this.logger.warn({
        event: 'payment.mismatch',
        orderNumber: order.order_number,
      });
      throw invalid(
        'These payment details do not match this order.',
        undefined,
        'PAYMENT_MISMATCH',
      );
    }
  }

  private async recordFailure(
    tenantId: string,
    rowId: string,
    payment: RazorpayPayment,
  ) {
    await this.db.withCheckout(tenantId, (tx) =>
      tx.execute(sql`
        update public.payment_transactions set status = 'failed', method = ${payment.method},
          failure_code = ${payment.errorCode?.slice(0, 100) ?? null}, failure_description = ${payment.errorDescription?.slice(0, 500) ?? null},
          updated_at = now()
        where id = ${rowId}::uuid and tenant_id = ${tenantId}::uuid and status in ('created', 'failed')`),
    );
  }

  private show(
    tenantId: string,
    orderNumber: number,
    token: string | undefined,
  ): Promise<PublicOrderDto> {
    return this.db.withCheckout(tenantId, async (tx) =>
      this.checkout.view(
        tx,
        tenantId,
        await this.checkout.findByToken(tx, tenantId, orderNumber, token),
        null,
        false,
      ),
    );
  }

  /** Razorpay failures become safe, generic errors for the shopper; details stay in the log. */
  private async call<T>(work: () => Promise<T>): Promise<T> {
    try {
      return await work();
    } catch (error) {
      if (!(error instanceof RazorpayError)) throw error;
      this.logger.warn({
        event: 'razorpay.call_failed',
        kind: error.kind,
        status: error.status,
        code: error.code,
      });
      if (error.kind === 'rejected')
        throw conflict(
          'The payment provider could not process this request.',
          undefined,
          'PAYMENT_PROVIDER_REJECTED',
        );
      throw new AppException(
        'UNAVAILABLE',
        'Online payment is temporarily unavailable. Please try again shortly.',
        {
          code: 'PAYMENT_PROVIDER_UNAVAILABLE',
        },
      );
    }
  }
}
