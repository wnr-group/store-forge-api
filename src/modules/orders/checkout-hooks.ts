import { Injectable } from '@nestjs/common';
import type { DbTx } from '../../database/database.service.js';
import type { OrderPaymentMethod } from '../../database/schema/enums.js';
import type { PricedLine } from './checkout-pricing.js';

/**
 * Seams the checkout asks about things other modules own. The payment policy is implemented by the payments module (the
 * tenant's own Razorpay and COD settings); the adjuster adds nothing until shipping and tax are configured.
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
