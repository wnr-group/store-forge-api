import { Injectable } from '@nestjs/common';
import { sql } from 'drizzle-orm';
import {
  DatabaseService,
  rowsOf,
  type DbTx,
} from '../../database/database.service.js';
import { INDIAN_STATES } from '../orders/indian-states.js';
import { chooseCarrier } from './carrier-selection.js';
import { CarrierSelectionService } from './carrier-selection.service.js';
import { normalizeCity } from './shipping-areas.js';
import {
  chargeFor,
  eligibility,
  type CartFacts,
  type PricedMethod,
  type RateTier,
} from './shipping-pricing.js';

export interface Destination {
  stateCode: string;
  city?: string | null;
  postalCode: string;
}

export interface QuoteRequest {
  destination: Destination;
  /** The items subtotal as the SERVER priced it. */
  subtotalMinor: number;
  /** The total shipping weight as the server worked it out. 0 = unknown. */
  weightGrams: number;
  /** The shopper's payment method, when known: carriers price (and serve) cash on delivery differently. */
  paymentMethod?: 'razorpay' | 'cod';
}

export interface CarrierPrice {
  amountMinor: number;
  days: number | null;
  carrierCode: string;
  carrierName: string;
  serviceCode: string;
  serviceName: string;
  estimate: boolean;
}

export interface ShippingOption {
  methodId: string;
  name: string;
  kind: 'standard' | 'express';
  pricingType: string;
  chargeMinor: number;
  free: boolean;
  estimatedDays: { min: number; max: number } | null;
  /** Whether cash on delivery may be used with this delivery option (the zone AND the method must allow it). */
  codAllowed: boolean;
  carrier: {
    code: string;
    name: string;
    serviceCode: string;
    serviceName: string;
    estimate: boolean;
  } | null;
  /** Kept for the order: the exact figures the option was priced from. */
  carrierQuote: CarrierPrice | null;
}

export interface ShippingQuote {
  /** The organization has set up shipping zones. When false there is nothing to charge or enforce. */
  configured: boolean;
  deliverable: boolean;
  zone: { id: string; name: string; codAllowed: boolean } | null;
  options: ShippingOption[];
  unavailable: { methodId: string; name: string; reason: string }[];
  reason: string | null;
}

export interface LoadedShipping {
  configured: boolean;
  zone: {
    id: string;
    name: string;
    enabled: boolean;
    codAllowed: boolean;
  } | null;
  methods: PricedMethod[];
  originPostalCode: string | null;
}

export const stateNameOf = (code: string): string =>
  INDIAN_STATES.find((s) => s.code === code)?.name ?? code;

/**
 * Works out what delivery a cart can have: which zone the address falls in, which of the zone's methods the cart is eligible for,
 * and what each costs. It is split so that a database transaction is never held open while a carrier is asked for a price:
 *   `load`   reads the zone, methods and tiers (inside the caller's transaction);
 *   `carrierPrices`  asks the carriers (no transaction);
 *   `assemble`  combines them into the answer (pure).
 * `options` runs all three for callers that are not in a transaction (storefront, dashboard preview).
 */
@Injectable()
export class ShippingQuoteService {
  constructor(
    private readonly db: DatabaseService,
    private readonly selection: CarrierSelectionService,
  ) {}

  async options(tenantId: string, req: QuoteRequest): Promise<ShippingQuote> {
    const loaded = await this.db.withCheckout(tenantId, (tx) =>
      this.load(tx, tenantId, req.destination),
    );
    const prices = await this.carrierPrices(tenantId, loaded, req);
    return this.assemble(loaded, req, prices);
  }

  /** The zone for an address, its enabled methods with their rate bands, and the pickup PIN code (for carrier lanes). */
  async load(
    tx: DbTx,
    tenantId: string,
    dest: Destination,
  ): Promise<LoadedShipping> {
    const configured = rowsOf<{ x: boolean }>(
      await tx.execute(
        sql`select exists (select 1 from public.shipping_zones where tenant_id = ${tenantId}::uuid) as x`,
      ),
    )[0].x;
    if (!configured)
      return {
        configured: false,
        zone: null,
        methods: [],
        originPostalCode: null,
      };

    // The most specific area wins, whether or not its zone is switched on: a zone that is off means "not served", not "ask a wider zone".
    const city = dest.city ? normalizeCity(dest.city) : null;
    const zone = rowsOf<{
      id: string;
      name: string;
      enabled: boolean;
      cod_allowed: boolean;
    }>(
      await tx.execute(sql`
        select z.id, z.name, z.enabled, z.cod_allowed
        from public.shipping_zone_areas a
        join public.shipping_zones z on z.id = a.zone_id and z.tenant_id = a.tenant_id
        where a.tenant_id = ${tenantId}::uuid and (
          (a.kind = 'postal_code' and a.postal_code = ${dest.postalCode})
          or (a.kind = 'postal_range' and ${dest.postalCode} between a.postal_from and a.postal_to)
          or (a.kind = 'city' and a.state_code = ${dest.stateCode} and a.city = ${city})
          or (a.kind = 'state' and a.state_code = ${dest.stateCode})
          or a.kind = 'country')
        order by case a.kind when 'postal_code' then 1 when 'postal_range' then 2 when 'city' then 3 when 'state' then 4 else 5 end
        limit 1`),
    )[0];
    const origin = rowsOf<{ postal_code: string }>(
      await tx.execute(
        sql`select postal_code from public.tenant_shipping_origin where tenant_id = ${tenantId}::uuid`,
      ),
    )[0];
    if (!zone)
      return {
        configured,
        zone: null,
        methods: [],
        originPostalCode: origin?.postal_code ?? null,
      };
    const resolved = {
      id: zone.id,
      name: zone.name,
      enabled: zone.enabled,
      codAllowed: zone.cod_allowed,
    };
    if (!zone.enabled)
      return {
        configured,
        zone: resolved,
        methods: [],
        originPostalCode: origin?.postal_code ?? null,
      };

    const methods = rowsOf<Record<string, unknown>>(
      await tx.execute(sql`
        select id, name, kind, pricing_type, flat_rate_minor::float8 as flat_rate_minor, free_over_minor::float8 as free_over_minor,
          handling_minor::float8 as handling_minor, min_order_minor::float8 as min_order_minor, max_order_minor::float8 as max_order_minor,
          min_weight_grams, max_weight_grams, est_days_min, est_days_max, cod_allowed, carrier_code
        from public.shipping_methods
        where tenant_id = ${tenantId}::uuid and zone_id = ${zone.id}::uuid and enabled
        order by sort_order, name`),
    );
    const tiers = rowsOf<{
      method_id: string;
      from_value: number;
      to_value: number | null;
      rate_minor: number;
    }>(
      await tx.execute(sql`
        select t.method_id, t.from_value::float8 as from_value, t.to_value::float8 as to_value, t.rate_minor::float8 as rate_minor
        from public.shipping_rate_tiers t join public.shipping_methods m on m.id = t.method_id and m.tenant_id = t.tenant_id
        where t.tenant_id = ${tenantId}::uuid and m.zone_id = ${zone.id}::uuid and m.enabled order by t.method_id, t.from_value`),
    );
    const num = (v: unknown) =>
      v === null || v === undefined ? null : Number(v);
    return {
      configured,
      zone: resolved,
      originPostalCode: origin?.postal_code ?? null,
      methods: methods.map((m): PricedMethod => ({
        id: m.id as string,
        name: m.name as string,
        kind: m.kind as 'standard' | 'express',
        pricingType: m.pricing_type as PricedMethod['pricingType'],
        flatRateMinor: Number(m.flat_rate_minor),
        freeOverMinor: num(m.free_over_minor),
        handlingMinor: Number(m.handling_minor),
        minOrderMinor: Number(m.min_order_minor),
        maxOrderMinor: num(m.max_order_minor),
        minWeightGrams: Number(m.min_weight_grams),
        maxWeightGrams: num(m.max_weight_grams),
        estDaysMin: num(m.est_days_min),
        estDaysMax: num(m.est_days_max),
        codAllowed: m.cod_allowed as boolean,
        carrierCode: (m.carrier_code as string | null) ?? null,
        tiers: tiers
          .filter((t) => t.method_id === m.id)
          .map((t): RateTier => ({
            from: Number(t.from_value),
            to: num(t.to_value),
            rateMinor: Number(t.rate_minor),
          })),
      })),
    };
  }

  /** Live prices for the carrier-priced methods that need one. Never inside a database transaction. */
  async carrierPrices(
    tenantId: string,
    loaded: LoadedShipping,
    req: QuoteRequest,
  ): Promise<Map<string, CarrierPrice>> {
    const cart: CartFacts = {
      subtotalMinor: req.subtotalMinor,
      weightGrams: req.weightGrams,
    };
    const needed = loaded.methods.filter(
      (m) =>
        m.pricingType === 'carrier' &&
        eligibility(m, cart).ok &&
        !(m.freeOverMinor !== null && req.subtotalMinor >= m.freeOverMinor),
    );
    const prices = new Map<string, CarrierPrice>();
    if (needed.length === 0 || !loaded.originPostalCode) return prices;

    const lane = {
      originPostalCode: loaded.originPostalCode,
      destinationPostalCode: req.destination.postalCode,
      paymentMode:
        req.paymentMethod === 'cod' ? ('cod' as const) : ('prepaid' as const),
      weightGrams: req.weightGrams,
      declaredValueMinor: req.subtotalMinor,
    };
    // One question per distinct carrier restriction, not one per method.
    const answers = new Map<
      string,
      Awaited<ReturnType<CarrierSelectionService['options']>>
    >();
    for (const m of needed) {
      const key = m.carrierCode ?? '*';
      if (!answers.has(key))
        answers.set(
          key,
          await this.selection.options(tenantId, lane, m.carrierCode),
        );
      const options = answers.get(key)!;
      // Pricing always follows the tenant's strategy, even if fulfilment is chosen by hand: the shopper needs a price either way.
      const choice = chooseCarrier(
        options.candidates,
        options.strategy,
        'automatic',
        options.defaultCarrier,
      );
      if (choice.candidate)
        prices.set(m.id, {
          amountMinor: choice.candidate.amountMinor,
          days: choice.candidate.estimatedDeliveryDays,
          carrierCode: choice.candidate.providerCode,
          carrierName: choice.candidate.providerName,
          serviceCode: choice.candidate.serviceCode,
          serviceName: choice.candidate.serviceName,
          estimate: choice.candidate.estimate,
        });
    }
    return prices;
  }

  assemble(
    loaded: LoadedShipping,
    req: QuoteRequest,
    prices: ReadonlyMap<string, CarrierPrice>,
  ): ShippingQuote {
    if (!loaded.configured)
      return {
        configured: false,
        deliverable: true,
        zone: null,
        options: [],
        unavailable: [],
        reason: null,
      };
    if (!loaded.zone || !loaded.zone.enabled)
      return {
        configured: true,
        deliverable: false,
        zone: null,
        options: [],
        unavailable: [],
        reason: 'We do not deliver to this address.',
      };

    const cart: CartFacts = {
      subtotalMinor: req.subtotalMinor,
      weightGrams: req.weightGrams,
    };
    const options: ShippingOption[] = [];
    const unavailable: ShippingQuote['unavailable'] = [];
    for (const m of loaded.methods) {
      const fit = eligibility(m, cart);
      if (!fit.ok) {
        unavailable.push({ methodId: m.id, name: m.name, reason: fit.reason });
        continue;
      }
      const price = prices.get(m.id) ?? null;
      const charge = chargeFor(m, cart, price?.amountMinor ?? null);
      if (!charge.ok) {
        unavailable.push({
          methodId: m.id,
          name: m.name,
          reason:
            m.pricingType === 'carrier' && !loaded.originPostalCode
              ? 'The shop has not set its pickup address yet.'
              : charge.reason,
        });
        continue;
      }
      const days =
        m.pricingType === 'carrier' && price?.days != null
          ? { min: price.days, max: price.days }
          : m.estDaysMin !== null && m.estDaysMax !== null
            ? { min: m.estDaysMin, max: m.estDaysMax }
            : null;
      const usedCarrier =
        m.pricingType === 'carrier' && !charge.free ? price : null;
      options.push({
        methodId: m.id,
        name: m.name,
        kind: m.kind,
        pricingType: m.pricingType,
        chargeMinor: charge.chargeMinor,
        free: charge.free,
        estimatedDays: days,
        codAllowed: loaded.zone.codAllowed && m.codAllowed,
        carrier: usedCarrier
          ? {
              code: usedCarrier.carrierCode,
              name: usedCarrier.carrierName,
              serviceCode: usedCarrier.serviceCode,
              serviceName: usedCarrier.serviceName,
              estimate: usedCarrier.estimate,
            }
          : null,
        carrierQuote: usedCarrier,
      });
    }
    return {
      configured: true,
      deliverable: options.length > 0,
      zone: {
        id: loaded.zone.id,
        name: loaded.zone.name,
        codAllowed: loaded.zone.codAllowed,
      },
      options,
      unavailable,
      reason:
        options.length > 0
          ? null
          : 'No delivery option is available for this order.',
    };
  }
}
