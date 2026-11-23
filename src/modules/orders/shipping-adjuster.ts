import { Injectable } from '@nestjs/common';
import { AppException, invalid } from '../../common/app.exception.js';
import { DatabaseService, type DbTx } from '../../database/database.service.js';
import {
  ShippingQuoteService,
  type CarrierPrice,
  type Destination,
  type ShippingQuote,
} from '../shipping/shipping-quote.service.js';
import { loadCatalog } from './catalog-loader.js';
import { cartWeightGrams, priceLines } from './checkout-pricing.js';
import type {
  CheckoutAdjuster,
  CheckoutAdjustment,
  CheckoutAdjustmentInput,
  CheckoutDestination,
  PrepareInput,
} from './checkout-hooks.js';

/** Live carrier prices fetched before the transaction, with the weight they were priced for. */
export interface PreparedShipping {
  weightGrams: number;
  prices: Map<string, CarrierPrice>;
}

const toDestination = (d: CheckoutDestination): Destination => ({
  stateCode: d.stateCode,
  city: d.city,
  postalCode: d.postalCode,
});

/**
 * Shipping at checkout. When an organization has shipping zones, every order must be deliverable and must use one of the delivery
 * options its cart is offered; the charge, the delivery estimate and the carrier are recorded on the order as priced. The charge is
 * always the one the server works out here: nothing the browser says about price is used, only WHICH option was chosen.
 * An organization with no zones at all is unaffected (no shipping charge, nothing to choose).
 */
@Injectable()
export class ShippingAdjuster implements CheckoutAdjuster {
  constructor(
    private readonly db: DatabaseService,
    private readonly quotes: ShippingQuoteService,
  ) {}

  /** Fetches carrier prices (the only slow, outside call) before any order lock is taken. */
  async prepare(input: PrepareInput): Promise<PreparedShipping | null> {
    if (!input.shippingMethodId) return null;
    const { loaded, catalog } = await this.db.withCheckout(
      input.tenantId,
      async (tx) => ({
        loaded: await this.quotes.load(
          tx,
          input.tenantId,
          toDestination(input.destination),
        ),
        catalog: await loadCatalog(tx, input.tenantId, input.requested, false),
      }),
    );
    const chosen = loaded.methods.find((m) => m.id === input.shippingMethodId);
    if (!chosen || chosen.pricingType !== 'carrier') return null;
    // Stock is not this step's business (the order transaction decides that): price what was asked for.
    const priced = priceLines(
      input.requested,
      catalog.products,
      catalog.variants,
      new Map(),
    );
    if (priced.lines.length === 0) return null;
    const weightGrams = cartWeightGrams(priced.lines);
    const prices = await this.quotes.carrierPrices(input.tenantId, loaded, {
      destination: toDestination(input.destination),
      subtotalMinor: priced.subtotalMinor,
      weightGrams,
      paymentMethod: input.paymentMethod,
    });
    return { weightGrams, prices };
  }

  async adjust(
    tx: DbTx,
    input: CheckoutAdjustmentInput,
    prepared?: unknown,
  ): Promise<CheckoutAdjustment> {
    const none: CheckoutAdjustment = {
      discountMinor: 0,
      shippingMinor: 0,
      taxMinor: 0,
      taxInclusive: false,
      shipping: null,
    };
    const loaded = await this.quotes.load(
      tx,
      input.tenantId,
      toDestination(input.destination),
    );
    if (!loaded.configured) return none;

    const weightGrams = cartWeightGrams(input.lines);
    // A live price is only good for the weight it was asked for.
    const usable = prepared as PreparedShipping | null | undefined;
    const prices =
      usable && usable.weightGrams === weightGrams
        ? usable.prices
        : new Map<string, CarrierPrice>();
    const quote = this.quotes.assemble(
      loaded,
      {
        destination: toDestination(input.destination),
        subtotalMinor: input.subtotalMinor,
        weightGrams,
        paymentMethod: input.paymentMethod,
      },
      prices,
    );

    if (!quote.deliverable)
      throw new AppException(
        'CONFLICT',
        quote.reason ?? 'We do not deliver to this address.',
        {
          code: 'NOT_DELIVERABLE',
          details: { unavailable: quote.unavailable },
        },
      );
    if (!input.shippingMethodId)
      throw invalid(
        'Choose a delivery option.',
        { shippingMethodId: 'Choose a delivery option.' },
        'SHIPPING_METHOD_REQUIRED',
      );
    const option = quote.options.find(
      (o) => o.methodId === input.shippingMethodId,
    );
    if (!option) throw this.unavailable(quote);

    return {
      discountMinor: 0,
      shippingMinor: option.chargeMinor,
      taxMinor: 0,
      taxInclusive: false,
      shipping: {
        methodId: option.methodId,
        methodName: option.name,
        zoneId: quote.zone!.id,
        zoneName: quote.zone!.name,
        carrierCode: option.carrier?.code ?? null,
        serviceCode: option.carrier?.serviceCode ?? null,
        daysMin: option.estimatedDays?.min ?? null,
        daysMax: option.estimatedDays?.max ?? null,
        weightGrams,
        codAllowed: option.codAllowed,
      },
    };
  }

  /** The chosen option is not one the cart is offered: say which ones are, so the shopper can pick again. */
  private unavailable(quote: ShippingQuote) {
    return new AppException(
      'CONFLICT',
      'That delivery option is not available for this order. Please choose another.',
      {
        code: 'SHIPPING_METHOD_UNAVAILABLE',
        details: {
          available: quote.options.map((o) => ({
            methodId: o.methodId,
            name: o.name,
            chargeMinor: o.chargeMinor,
          })),
        },
      },
    );
  }
}
