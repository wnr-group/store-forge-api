import { Injectable } from '@nestjs/common';
import type { DbTx } from '../../database/database.service.js';
import type { OrderPaymentMethod } from '../../database/schema/enums.js';
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
