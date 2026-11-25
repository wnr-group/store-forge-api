import { Injectable } from '@nestjs/common';
import { sql } from 'drizzle-orm';
import { AppException } from '../../common/app.exception.js';
import { rowsOf, type DbTx } from '../../database/database.service.js';
import type {
  PaymentMethodPolicy,
  PaymentPolicyInput,
} from '../orders/checkout-hooks.js';

/** Razorpay does not process less than one rupee. */
export const MIN_ONLINE_AMOUNT_MINOR = 100;

interface CodRow {
  enabled: boolean;
  min_order_minor: number;
  max_order_minor: number | null;
  fee_minor: number;
}

export interface PaymentMethodOptions {
  razorpay: { available: boolean };
  cod: {
    available: boolean;
    feeMinor: number;
    /** Why COD is not offered for this order value, in words a shopper can read. */
    reason: string | null;
  };
}

const unavailable = (message: string, code = 'PAYMENT_METHOD_UNAVAILABLE') =>
  new AppException('CONFLICT', message, { code });

/**
 * Decides which payment methods a tenant offers, from the tenant's own settings. Runs as the tenant-pinned checkout role, so
 * it can only see this tenant's rows, and it never touches the credentials (only a yes/no function).
 * "Order value" for the COD limits is the items subtotal; shipping zones and methods join the rules in the shipping phase.
 */
@Injectable()
export class PaymentMethodsPolicy implements PaymentMethodPolicy {
  async options(
    tx: DbTx,
    tenantId: string,
    subtotalMinor: number,
  ): Promise<PaymentMethodOptions> {
    const razorpay = rowsOf<{ ok: boolean }>(
      await tx.execute(
        sql`select public.razorpay_accepts_payments(${tenantId}::uuid) as ok`,
      ),
    )[0]?.ok;
    const cod = rowsOf<CodRow>(
      await tx.execute(sql`
        select enabled, min_order_minor::float8 as min_order_minor, max_order_minor::float8 as max_order_minor,
          fee_minor::float8 as fee_minor
        from public.tenant_cod_config where tenant_id = ${tenantId}::uuid`),
    )[0];
    let reason: string | null = null;
    if (!cod?.enabled) reason = 'Cash on delivery is not available.';
    else if (subtotalMinor < Number(cod.min_order_minor))
      reason = 'Your order is below the minimum for cash on delivery.';
    else if (
      cod.max_order_minor !== null &&
      subtotalMinor > Number(cod.max_order_minor)
    )
      reason = 'Your order is above the maximum for cash on delivery.';
    return {
      razorpay: { available: razorpay === true },
      cod: {
        available: reason === null,
        feeMinor: cod ? Number(cod.fee_minor) : 0,
        reason,
      },
    };
  }

  async resolve(
    tx: DbTx,
    input: PaymentPolicyInput,
  ): Promise<{ codFeeMinor: number }> {
    const options = await this.options(tx, input.tenantId, input.subtotalMinor);
    if (input.method === 'razorpay') {
      if (!options.razorpay.available)
        throw unavailable('Online payment is not available for this store.');
      return { codFeeMinor: 0 };
    }
    // The delivery zone or method may not allow cash on delivery at all (some areas cannot collect cash).
    if (input.shipping && !input.shipping.codAllowed)
      throw unavailable(
        'Cash on delivery is not available for this delivery option or area.',
        'COD_NOT_AVAILABLE',
      );
    if (!options.cod.available)
      throw unavailable(
        options.cod.reason ?? 'Cash on delivery is not available.',
        'COD_NOT_AVAILABLE',
      );
    return { codFeeMinor: options.cod.feeMinor };
  }
}
