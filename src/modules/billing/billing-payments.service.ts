import { Injectable, Logger } from '@nestjs/common';
import { eq, sql } from 'drizzle-orm';
import { AppException, notFound } from '../../common/app.exception.js';
import type { OrgContext } from '../../common/interfaces/request-context.js';
import {
  DatabaseService,
  rowsOf,
  type DbTx,
} from '../../database/database.service.js';
import {
  billingInvoices,
  billingPayments,
} from '../../database/schema/index.js';
import { verifyCheckoutSignature } from '../payments/razorpay-signature.js';
import { errorChain } from '../../common/db-errors.js';
import type {
  PaymentIntentDto,
  PaymentVerifiedDto,
  VerifyPaymentDto,
} from './billing.dto.js';
import { mapBillingError } from './billing.service.js';
import { PlatformRazorpayService } from './platform-razorpay.service.js';

type Prepared = {
  invoiceId: string;
  number: string;
  tenantId: string;
  amountMinor: number;
  currency: string;
  existingOrderId: string | null;
};

const invoiceNotFound = () =>
  notFound('That invoice was not found.', 'INVOICE_NOT_FOUND');

/**
 * How a tenant Owner pays a StoreForge invoice. The browser only ever receives an order id and the PUBLIC key id; the secret stays on the
 * server. A payment counts only after the server has (1) checked Razorpay's signature on the checkout result and (2) asked Razorpay itself
 * for the payment and confirmed it is captured, for this order, in this amount. The Owner's own tenant is enforced by the database.
 */
@Injectable()
export class BillingPaymentsService {
  private readonly logger = new Logger(BillingPaymentsService.name);

  constructor(
    private readonly db: DatabaseService,
    private readonly razorpay: PlatformRazorpayService,
  ) {}

  /** Creates (or reuses) the Razorpay order for an open invoice. Calling it twice does not create two orders. */
  async startPayment(
    org: OrgContext,
    invoiceId: string,
  ): Promise<PaymentIntentDto> {
    this.razorpay.credentials(); // fail early, before touching anything, when payments are not set up

    let prepared: Prepared;
    try {
      prepared = await this.db.withUser(
        org.userId,
        async (tx) =>
          rowsOf<{ r: Prepared }>(
            await tx.execute(
              sql`select public.billing_prepare_payment(${invoiceId}::uuid) as r`,
            ),
          )[0].r,
      );
    } catch (error) {
      if (errorChain(error).includes('not_found')) throw invoiceNotFound();
      return mapBillingError(error);
    }
    // The database already checked the caller owns the invoice's tenant; this guards against an Owner of several organizations.
    if (prepared.tenantId !== org.tenantId) throw invoiceNotFound();

    let orderId = prepared.existingOrderId;
    if (!orderId) {
      // The outside call happens with no transaction open.
      const order = await this.razorpay.createOrder({
        amountMinor: prepared.amountMinor,
        currency: prepared.currency,
        receipt: prepared.number,
        notes: { invoiceId: prepared.invoiceId, tenantId: prepared.tenantId },
      });
      try {
        await this.db.withUser(org.userId, async (tx) => {
          await tx.execute(
            sql`select public.billing_attach_order(${invoiceId}::uuid, ${order.id}, ${order.amountMinor}::bigint, ${order.currency})`,
          );
        });
      } catch (error) {
        this.logger.error(
          `could not record order for invoice ${prepared.number}`,
        );
        return mapBillingError(error);
      }
      orderId = order.id;
    }
    return {
      orderId,
      keyId: this.razorpay.keyId,
      amountMinor: prepared.amountMinor,
      currency: prepared.currency,
      invoiceNumber: prepared.number,
    };
  }

  /** Confirms a checkout result. Idempotent: confirming the same payment again changes nothing. */
  async verifyPayment(
    org: OrgContext,
    v: VerifyPaymentDto,
  ): Promise<PaymentVerifiedDto> {
    this.razorpay.credentials();

    // The payment must belong to this Owner's organization (row level security) before anything is sent to Razorpay.
    const row = await this.db.withUser(org.userId, async (tx) => {
      const [r] = await tx
        .select({
          tenantId: billingPayments.tenantId,
          invoiceId: billingPayments.invoiceId,
        })
        .from(billingPayments)
        .where(eq(billingPayments.razorpayOrderId, v.razorpayOrderId));
      return r;
    });
    if (!row || row.tenantId !== org.tenantId)
      throw notFound('That payment was not found.', 'PAYMENT_NOT_FOUND');

    if (
      !verifyCheckoutSignature(
        v.razorpayOrderId,
        v.razorpayPaymentId,
        v.razorpaySignature,
        this.razorpay.keySecret(),
      )
    )
      throw new AppException(
        'VALIDATION',
        'The payment could not be verified.',
        {
          code: 'PAYMENT_SIGNATURE_INVALID',
        },
      );

    // The browser's word is not enough: ask Razorpay what really happened.
    let payment = await this.razorpay.fetchPayment(v.razorpayPaymentId);
    if (payment.orderId !== v.razorpayOrderId)
      throw new AppException(
        'VALIDATION',
        'The payment could not be verified.',
        {
          code: 'PAYMENT_SIGNATURE_INVALID',
        },
      );
    if (payment.status === 'authorized')
      payment = await this.razorpay.capturePayment(payment);
    if (payment.status !== 'captured')
      throw new AppException(
        'CONFLICT',
        'The payment has not been completed yet.',
        {
          code: 'PAYMENT_NOT_CAPTURED',
        },
      );

    try {
      return await this.db.withUser(org.userId, async (tx) => {
        const r = rowsOf<{ r: { result: string } }>(
          await tx.execute(sql`select public.billing_apply_payment(
            ${v.razorpayOrderId}, ${payment.id}, ${payment.amountMinor}::bigint, ${payment.currency}, ${payment.method},
            'captured', null, null) as r`),
        )[0].r;
        return {
          result: r.result === 'duplicate' ? 'duplicate' : 'captured',
          invoiceStatus: await this.invoiceStatus(tx, row.invoiceId),
        };
      });
    } catch (error) {
      if (errorChain(error).includes('amount_mismatch'))
        this.logger.error(`amount mismatch on order ${v.razorpayOrderId}`);
      return mapBillingError(error);
    }
  }

  private async invoiceStatus(tx: DbTx, invoiceId: string): Promise<string> {
    const [i] = await tx
      .select({ status: billingInvoices.status })
      .from(billingInvoices)
      .where(eq(billingInvoices.id, invoiceId));
    return i?.status ?? 'open';
  }
}
