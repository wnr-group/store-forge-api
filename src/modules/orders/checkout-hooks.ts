import { Injectable } from '@nestjs/common';
import type { DbTx } from '../../database/database.service.js';
import type { OrderPaymentMethod } from '../../database/schema/enums.js';
import type { TaxedLine } from '../tax/gst.js';
import type { PricedLine, RequestedLine } from './checkout-pricing.js';

/**
 * Seams the checkout asks about things other modules own. The payment policy is implemented by the payments module (the
 * tenant's own Razorpay and COD settings); the adjuster by shipping (and, in the tax phase, tax).
 */

export interface PaymentPolicyInput {
  tenantId: string;
  method: OrderPaymentMethod;
  subtotalMinor: number;
  currency: string;
  /** The delivery option chosen for the order, when the organization uses shipping zones. */
  shipping?: { codAllowed: boolean } | null;
}

export interface PaymentMethodPolicy {
  /** Throws a conflict when `method` is not available to this tenant for this order; returns the COD fee otherwise. */
  resolve(
    tx: DbTx,
    input: PaymentPolicyInput,
  ): Promise<{ codFeeMinor: number }>;
}
export const PAYMENT_METHOD_POLICY = Symbol('PAYMENT_METHOD_POLICY');

/** Where the order is going, as the zone rules need it. */
export interface CheckoutDestination {
  stateCode: string;
  stateName: string;
  city: string;
  postalCode: string;
}

/** What shipping was chosen and priced; saved on the order exactly as it was. */
export interface ShippingSnapshot {
  methodId: string;
  methodName: string;
  zoneId: string;
  zoneName: string;
  carrierCode: string | null;
  serviceCode: string | null;
  daysMin: number | null;
  daysMax: number | null;
  weightGrams: number;
  /** Whether the zone AND the method allow cash on delivery. */
  codAllowed: boolean;
}

/** What the checkout can say about the cart BEFORE its database transaction opens, so the adjuster may call outside services. */
export interface PrepareInput {
  tenantId: string;
  currency: string;
  destination: CheckoutDestination;
  shippingMethodId: string | null;
  paymentMethod: OrderPaymentMethod;
  requested: readonly RequestedLine[];
}

export interface CheckoutAdjustmentInput {
  tenantId: string;
  lines: readonly PricedLine[];
  subtotalMinor: number;
  destination: CheckoutDestination;
  shippingMethodId: string | null;
  paymentMethod: OrderPaymentMethod;
  currency: string;
}

export interface CheckoutAdjustment {
  discountMinor: number;
  shippingMinor: number;
  taxMinor: number;
  taxInclusive: boolean;
  /** Present when the organization uses shipping zones. */
  shipping?: ShippingSnapshot | null;
}

export interface CheckoutAdjuster {
  /**
   * Optional, may call outside services (carrier prices). It runs with no database transaction open and returns whatever
   * `adjust` needs; `adjust` must work, and fail safely, without it.
   */
  prepare?(input: PrepareInput): Promise<unknown>;
  /** Runs inside the order transaction: database work only. */
  adjust(
    tx: DbTx,
    input: CheckoutAdjustmentInput,
    prepared?: unknown,
  ): Promise<CheckoutAdjustment>;
}
export const CHECKOUT_ADJUSTER = Symbol('CHECKOUT_ADJUSTER');

/** Adds nothing: the total is the subtotal. Used where shipping and tax are not part of what is being tested. */
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

/** What the tax calculator is given: the priced cart and every charge on top of it. */
export interface CheckoutTaxInput {
  tenantId: string;
  lines: readonly PricedLine[];
  discountMinor: number;
  shippingMinor: number;
  codFeeMinor: number;
  destination: CheckoutDestination;
}

/** The tax of an order, line by line, ready to be saved with it. Item lines are matched to cart lines by `itemKey`. */
export interface CheckoutTaxResult {
  regime: 'none' | 'intra' | 'inter';
  stateTaxKind: 'sgst' | 'utgst';
  /** The prices already contain the tax, so it is not added to the total. */
  inclusive: boolean;
  sellerGstin: string | null;
  sellerStateCode: string | null;
  supplyStateCode: string | null;
  cgstMinor: number;
  sgstMinor: number;
  igstMinor: number;
  taxMinor: number;
  lines: (TaxedLine & { itemKey: string | null })[];
}

/** Implemented by the tax module from the tenant's own GST settings and the products' own rates. */
export interface CheckoutTaxCalculator {
  compute(tx: DbTx, input: CheckoutTaxInput): Promise<CheckoutTaxResult>;
}
export const CHECKOUT_TAX = Symbol('CHECKOUT_TAX');

/** The key that ties a priced cart line to its tax line. */
export const itemKeyOf = (l: Pick<PricedLine, 'productId' | 'variantId'>) =>
  `${l.productId}:${l.variantId ?? '-'}`;

/** What the discount module is asked about a cart. `customerEmail` is null while the shopper has not given one (a quote). */
export interface CheckoutDiscountInput {
  tenantId: string;
  code: string;
  lines: readonly PricedLine[];
  customerEmail: string | null;
}

export type CheckoutDiscountResult =
  | {
      ok: true;
      discountId: string;
      code: string;
      discountMinor: number;
      eligibleSubtotalMinor: number;
    }
  | {
      ok: false;
      reason: string;
      message: string;
      minSubtotalMinor?: number;
    };

/** Implemented by the marketing module from the tenant's own discount codes. Without it a code is simply not accepted. */
export interface CheckoutDiscounts {
  /** Decides whether the code applies to this cart and for how much. Reads only; the redemption is recorded by `redeem`. */
  resolve(
    tx: DbTx,
    input: CheckoutDiscountInput,
  ): Promise<CheckoutDiscountResult>;
  /** Records the use inside the order transaction, under a lock; returns a refusal reason, or null when recorded. */
  redeem(
    tx: DbTx,
    input: {
      tenantId: string;
      discountId: string;
      orderId: string;
      customerEmail: string;
      discountMinor: number;
    },
  ): Promise<{ reason: string; message: string } | null>;
}
export const CHECKOUT_DISCOUNTS = Symbol('CHECKOUT_DISCOUNTS');

/** An order was placed; the cart it came from (by the browser's cart id and/or the shopper's email) can stop being tracked. */
export interface CartConversion {
  tenantId: string;
  orderNumber: number;
  cartKey: string | null;
  email: string;
}

/** Implemented by the marketing module. It must never throw: tracking is not allowed to cost a sale. */
export interface CheckoutCartTracker {
  converted(conversion: CartConversion): Promise<void>;
}
export const CHECKOUT_CART_TRACKER = Symbol('CHECKOUT_CART_TRACKER');
