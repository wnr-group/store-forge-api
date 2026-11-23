import { Injectable } from '@nestjs/common';
import { sql } from 'drizzle-orm';
import { invalid } from '../../common/app.exception.js';
import type { OrgContext } from '../../common/interfaces/request-context.js';
import { DatabaseService, rowsOf } from '../../database/database.service.js';
import { findIndianState } from '../orders/indian-states.js';
import { CarrierSelectionService } from './carrier-selection.service.js';
import type {
  CarrierComparisonDto,
  CarrierComparisonResultDto,
  OriginDto,
  PreviewDto,
  SaveOriginDto,
  ShippingQuoteDto,
} from './shipping-tools.dto.js';
import {
  ShippingQuoteService,
  type Destination,
  type ShippingQuote,
} from './shipping-quote.service.js';

const EMPTY_ORIGIN: OriginDto = {
  configured: false,
  name: null,
  phone: null,
  email: null,
  line1: null,
  line2: null,
  city: null,
  state: null,
  postalCode: null,
  updatedAt: null,
};

/** Turns an address as typed into the codes the zones use, or explains what is wrong. */
export function destinationOf(
  a: { state: string; city?: string | null; postalCode: string },
  field = 'state',
): Destination {
  const state = findIndianState(a.state);
  if (!state)
    throw invalid('Choose a valid Indian state or union territory.', {
      [field]: 'Choose a valid Indian state or union territory.',
    });
  return {
    stateCode: state.code,
    city: a.city ?? null,
    postalCode: a.postalCode,
  };
}

/** Public shape of a quote: the internal carrier figures stay inside. */
export function publicQuote(q: ShippingQuote): ShippingQuoteDto {
  return {
    configured: q.configured,
    deliverable: q.deliverable,
    zone: q.zone,
    options: q.options.map(({ carrierQuote: _internal, ...option }) => option),
    unavailable: q.unavailable,
    reason: q.reason,
  };
}

/** The Owner's shipping origin, and the "what would this order get?" tools of the dashboard. */
@Injectable()
export class ShippingToolsService {
  constructor(
    private readonly db: DatabaseService,
    private readonly quotes: ShippingQuoteService,
    private readonly selection: CarrierSelectionService,
  ) {}

  origin(org: OrgContext): Promise<OriginDto> {
    return this.db.withUser(org.userId, async (tx) => {
      const r = rowsOf<Record<string, string | null>>(
        await tx.execute(sql`
          select name, phone, email, line1, line2, city, state, postal_code, updated_at from public.tenant_shipping_origin
          where tenant_id = ${org.tenantId}::uuid`),
      )[0];
      if (!r) return EMPTY_ORIGIN;
      return {
        configured: true,
        name: r.name,
        phone: r.phone,
        email: r.email,
        line1: r.line1,
        line2: r.line2,
        city: r.city,
        state: r.state,
        postalCode: r.postal_code,
        updatedAt: new Date(r.updated_at as string),
      };
    });
  }

  async saveOrigin(org: OrgContext, dto: SaveOriginDto): Promise<OriginDto> {
    const state = findIndianState(dto.state);
    if (!state)
      throw invalid('Choose a valid Indian state or union territory.', {
        state: 'Choose a valid Indian state or union territory.',
      });
    await this.db.withUser(org.userId, (tx) =>
      tx.execute(sql`
        insert into public.tenant_shipping_origin (tenant_id, name, phone, email, line1, line2, city, state, state_code, postal_code, updated_at, updated_by)
        values (${org.tenantId}::uuid, ${dto.name}, ${dto.phone}, ${dto.email ?? null}, ${dto.line1}, ${dto.line2 ?? null}, ${dto.city},
          ${state.name}, ${state.code}, ${dto.postalCode}, now(), ${org.userId}::uuid)
        on conflict (tenant_id) do update set name = ${dto.name}, phone = ${dto.phone}, email = ${dto.email ?? null}, line1 = ${dto.line1},
          line2 = ${dto.line2 ?? null}, city = ${dto.city}, state = ${state.name}, state_code = ${state.code}, postal_code = ${dto.postalCode},
          updated_at = now(), updated_by = ${org.userId}::uuid`),
    );
    return this.origin(org);
  }

  /** What an address, cart value and weight would be offered, exactly as a shopper would see it. */
  async preview(org: OrgContext, dto: PreviewDto): Promise<ShippingQuoteDto> {
    const q = await this.quotes.options(org.tenantId, {
      destination: destinationOf(dto.destination, 'destination.state'),
      subtotalMinor: dto.subtotalMinor,
      weightGrams: dto.weightGrams,
      paymentMethod: dto.paymentMethod,
    });
    return publicQuote(q);
  }

  /** Every connected carrier's answer for one parcel, and what the selection settings would choose. Calls the carriers. */
  async compare(
    org: OrgContext,
    dto: CarrierComparisonDto,
  ): Promise<CarrierComparisonResultDto> {
    const origin = await this.origin(org);
    if (!origin.configured)
      throw invalid(
        'Save your pickup address first: carriers need to know where parcels start.',
        { origin: 'Save your pickup address first.' },
        'ORIGIN_MISSING',
      );
    const result = await this.selection.choose(org.tenantId, {
      originPostalCode: origin.postalCode!,
      destinationPostalCode: dto.destinationPostalCode,
      paymentMode: dto.paymentMode,
      weightGrams: dto.weightGrams,
      declaredValueMinor: dto.declaredValueMinor ?? 0,
    });
    return {
      candidates: result.candidates,
      skipped: result.skipped,
      strategy: result.strategy,
      mode: result.mode,
      defaultCarrier: result.defaultCarrier,
      choice: result.choice,
    };
  }
}
