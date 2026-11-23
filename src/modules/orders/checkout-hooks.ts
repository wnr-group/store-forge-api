import { Injectable } from '@nestjs/common';
import { AppException } from '../../common/app.exception.js';
import type { DbTx } from '../../database/database.service.js';
import type { OrderPaymentMethod } from '../../database/schema/enums.js';
import type { PricedLine } from './checkout-pricing.js';

/**
 * Seams the checkout asks about things other modules own. Each has a safe default that does NOT invent behaviour:
 * the payment policy refuses every method until the payments module registers the real rules (Razorpay and COD
 * configuration), and the adjuster adds nothing until shipping and tax are configured.
 */

export interface PaymentPolicyInput {
  tenantId: string;
  method: OrderPaymentMethod;
  subtotalMinor: number;
  currency: string;
}

export interface PaymentMethodPolicy {
  /** Throws a conflict when `method` is not available to this tenant for this order; returns the COD fee otherwise. */
  resolve(
    tx: DbTx,
    input: PaymentPolicyInput,
  ): Promise<{ codFeeMinor: number }>;
}
export const PAYMENT_METHOD_POLICY = Symbol('PAYMENT_METHOD_POLICY');

@Injectable()
export class UnconfiguredPaymentPolicy implements PaymentMethodPolicy {
  resolve(): Promise<{ codFeeMinor: number }> {
    return Promise.reject(
      new AppException(
        'CONFLICT',
        'This store is not accepting orders yet. Please try again later.',
        { code: 'PAYMENT_METHOD_UNAVAILABLE' },
      ),
    );
  }
}

export interface CheckoutAdjustmentInput {
  tenantId: string;
  lines: readonly PricedLine[];
  subtotalMinor: number;
  shippingState: string;
  shippingPostalCode: string;
  currency: string;
}

export interface CheckoutAdjustment {
  discountMinor: number;
  shippingMinor: number;
  taxMinor: number;
  taxInclusive: boolean;
}

export interface CheckoutAdjuster {
  adjust(tx: DbTx, input: CheckoutAdjustmentInput): Promise<CheckoutAdjustment>;
}
export const CHECKOUT_ADJUSTER = Symbol('CHECKOUT_ADJUSTER');

/** Until shipping zones and tax rules exist for a tenant there is nothing to add: the total is the subtotal. */
@Injectable()
export class NoAdjustments implements CheckoutAdjuster {
  adjust(): Promise<CheckoutAdjustment> {
    return Promise.resolve({
      discountMinor: 0,
      shippingMinor: 0,
      taxMinor: 0,
      taxInclusive: false,
    });
  }
}
