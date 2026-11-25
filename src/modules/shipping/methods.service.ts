import { Injectable } from '@nestjs/common';
import { sql } from 'drizzle-orm';
import { conflict, invalid, notFound } from '../../common/app.exception.js';
import type { OrgContext } from '../../common/interfaces/request-context.js';
import {
  DatabaseService,
  rowsOf,
  type DbTx,
} from '../../database/database.service.js';
import type { MethodDto, SaveMethodDto } from './methods.dto.js';
import { ShippingProviderRegistry } from './providers/provider-registry.js';
import { tierProblems, type RateTier } from './shipping-pricing.js';

const COLUMNS = sql`m.id, m.zone_id, z.name as zone_name, m.name, m.kind, m.pricing_type, m.flat_rate_minor::float8 as flat_rate_minor,
  m.free_over_minor::float8 as free_over_minor, m.handling_minor::float8 as handling_minor, m.min_order_minor::float8 as min_order_minor,
  m.max_order_minor::float8 as max_order_minor, m.min_weight_grams, m.max_weight_grams, m.est_days_min, m.est_days_max, m.cod_allowed,
  m.carrier_code, m.sort_order, m.enabled, m.created_at, m.updated_at`;

type Row = Record<string, unknown>;
const num = (v: unknown) => (v === null || v === undefined ? null : Number(v));

/**
 * Shipping methods and their rate bands. A method belongs to one zone for life (move it by creating it again). Everything that
 * could make a method wrong is checked here, in words the Owner can act on, before it is saved: the price inputs that its pricing
 * type needs, bands that cover every value, delivery times that make sense, a carrier that can really quote prices.
 */
@Injectable()
export class MethodsService {
  constructor(
    private readonly db: DatabaseService,
    private readonly registry: ShippingProviderRegistry,
  ) {}

  list(org: OrgContext, zoneId?: string): Promise<MethodDto[]> {
    return this.db.withUser(org.userId, async (tx) => {
      const rows = rowsOf<Row>(
        await tx.execute(sql`
          select ${COLUMNS} from public.shipping_methods m join public.shipping_zones z on z.id = m.zone_id and z.tenant_id = m.tenant_id
          where m.tenant_id = ${org.tenantId}::uuid ${zoneId ? sql`and m.zone_id = ${zoneId}::uuid` : sql``}
          order by z.name, m.sort_order, m.name`),
      );
      return this.withTiers(tx, org.tenantId, rows);
    });
  }

  get(org: OrgContext, id: string): Promise<MethodDto> {
    return this.db.withUser(org.userId, (tx) =>
      this.read(tx, org.tenantId, id),
    );
  }

  async create(org: OrgContext, dto: SaveMethodDto): Promise<MethodDto> {
    const tiers = this.validate(dto);
    return this.db.withUser(org.userId, async (tx) => {
      await this.assertZone(tx, org.tenantId, dto.zoneId);
      await this.assertNameFree(tx, dto.zoneId, dto.name, null);
      const id = rowsOf<{ id: string }>(
        await tx.execute(sql`
          insert into public.shipping_methods (tenant_id, zone_id, name, kind, pricing_type, flat_rate_minor, free_over_minor, handling_minor,
            min_order_minor, max_order_minor, min_weight_grams, max_weight_grams, est_days_min, est_days_max, cod_allowed, carrier_code, sort_order, enabled)
          values (${org.tenantId}::uuid, ${dto.zoneId}::uuid, ${dto.name}, ${dto.kind ?? 'standard'}, ${dto.pricingType}, ${dto.flatRateMinor ?? 0},
            ${dto.freeOverMinor ?? null}, ${dto.handlingMinor ?? 0}, ${dto.minOrderMinor ?? 0}, ${dto.maxOrderMinor ?? null},
            ${dto.minWeightGrams ?? 0}, ${dto.maxWeightGrams ?? null}, ${dto.estimatedDaysMin ?? null}, ${dto.estimatedDaysMax ?? null},
            ${dto.codAllowed ?? true}, ${dto.carrierCode ?? null}, ${dto.sortOrder ?? 0}, ${dto.enabled ?? true})
          returning id`),
      )[0].id;
      await this.writeTiers(tx, org.tenantId, id, tiers);
      return this.read(tx, org.tenantId, id);
    });
  }

  async update(
    org: OrgContext,
    id: string,
    dto: SaveMethodDto,
  ): Promise<MethodDto> {
    const tiers = this.validate(dto);
    return this.db.withUser(org.userId, async (tx) => {
      const current = rowsOf<{ zone_id: string }>(
        await tx.execute(
          sql`select zone_id from public.shipping_methods where id = ${id}::uuid and tenant_id = ${org.tenantId}::uuid for update`,
        ),
      )[0];
      if (!current)
        throw notFound('Shipping method not found.', 'METHOD_NOT_FOUND');
      if (current.zone_id !== dto.zoneId)
        throw invalid(
          'A method cannot be moved to another zone. Create it in the new zone instead.',
          { zoneId: 'Keep the method in its zone.' },
          'METHOD_ZONE_FIXED',
        );
      await this.assertNameFree(tx, dto.zoneId, dto.name, id);
      await tx.execute(sql`
        update public.shipping_methods set name = ${dto.name}, kind = ${dto.kind ?? 'standard'}, pricing_type = ${dto.pricingType},
          flat_rate_minor = ${dto.flatRateMinor ?? 0}, free_over_minor = ${dto.freeOverMinor ?? null}, handling_minor = ${dto.handlingMinor ?? 0},
          min_order_minor = ${dto.minOrderMinor ?? 0}, max_order_minor = ${dto.maxOrderMinor ?? null}, min_weight_grams = ${dto.minWeightGrams ?? 0},
          max_weight_grams = ${dto.maxWeightGrams ?? null}, est_days_min = ${dto.estimatedDaysMin ?? null}, est_days_max = ${dto.estimatedDaysMax ?? null},
          cod_allowed = ${dto.codAllowed ?? true}, carrier_code = ${dto.carrierCode ?? null}, sort_order = ${dto.sortOrder ?? 0},
          enabled = ${dto.enabled ?? true}, updated_at = now()
        where id = ${id}::uuid and tenant_id = ${org.tenantId}::uuid`);
      await tx.execute(
        sql`delete from public.shipping_rate_tiers where method_id = ${id}::uuid and tenant_id = ${org.tenantId}::uuid`,
      );
      await this.writeTiers(tx, org.tenantId, id, tiers);
      return this.read(tx, org.tenantId, id);
    });
  }

  async remove(org: OrgContext, id: string): Promise<void> {
    await this.db.withUser(org.userId, async (tx) => {
      const removed = rowsOf(
        await tx.execute(
          sql`delete from public.shipping_methods where id = ${id}::uuid and tenant_id = ${org.tenantId}::uuid returning id`,
        ),
      );
      if (removed.length === 0)
        throw notFound('Shipping method not found.', 'METHOD_NOT_FOUND');
    });
  }

  // --- internals -------------------------------------------------------------------------------------------------------

  /** Every rule that depends only on what was submitted. Returns the bands to store (none for methods that do not use them). */
  private validate(dto: SaveMethodDto): RateTier[] {
    const errors: Record<string, string> = {};
    const banded =
      dto.pricingType === 'weight' || dto.pricingType === 'order_value';

    if (dto.pricingType === 'flat' && dto.flatRateMinor === undefined)
      errors.flatRateMinor = 'Enter the price for this method.';
    if (dto.pricingType === 'free' && dto.freeOverMinor != null)
      errors.freeOverMinor = 'A free method has no free-shipping threshold.';
    if (dto.pricingType !== 'carrier' && dto.handlingMinor)
      errors.handlingMinor =
        'Handling is only added to carrier-priced methods.';
    if (dto.pricingType !== 'carrier' && dto.carrierCode)
      errors.carrierCode = 'Only a carrier-priced method can name a carrier.';
    if (dto.pricingType === 'carrier' && dto.carrierCode) {
      if (!this.registry.has(dto.carrierCode))
        errors.carrierCode = 'That carrier is not supported.';
      else if (!this.registry.get(dto.carrierCode).capabilities.rateQuotes)
        errors.carrierCode = `${this.registry.get(dto.carrierCode).name} does not quote prices through its API, so it cannot price a method.`;
    }
    if (
      dto.maxOrderMinor != null &&
      dto.maxOrderMinor < (dto.minOrderMinor ?? 0)
    )
      errors.maxOrderMinor = 'The maximum cannot be lower than the minimum.';
    if (
      dto.maxWeightGrams != null &&
      dto.maxWeightGrams < (dto.minWeightGrams ?? 0)
    )
      errors.maxWeightGrams = 'The maximum cannot be lower than the minimum.';
    const hasMin = dto.estimatedDaysMin != null;
    const hasMax = dto.estimatedDaysMax != null;
    if (hasMin !== hasMax)
      errors.estimatedDaysMax =
        'Give both the shortest and the longest delivery time, or neither.';
    else if (hasMin && dto.estimatedDaysMin! > dto.estimatedDaysMax!)
      errors.estimatedDaysMax =
        'The longest time cannot be shorter than the shortest.';

    let tiers: RateTier[] = [];
    if (banded) {
      tiers = (dto.tiers ?? []).map((t) => ({
        from: t.from,
        to: t.to ?? null,
        rateMinor: t.rateMinor,
      }));
      const problems = tierProblems(tiers);
      if (problems.length > 0) errors.tiers = problems.join(' ');
    } else if (dto.tiers && dto.tiers.length > 0)
      errors.tiers =
        'Rate bands are only used by weight and order-value methods.';

    if (Object.keys(errors).length > 0)
      throw invalid(
        'Some shipping method settings need attention.',
        errors,
        'METHOD_INVALID',
      );
    return tiers;
  }

  private async assertZone(tx: DbTx, tenantId: string, zoneId: string) {
    const found = rowsOf(
      await tx.execute(
        sql`select 1 from public.shipping_zones where id = ${zoneId}::uuid and tenant_id = ${tenantId}::uuid`,
      ),
    );
    if (found.length === 0)
      throw invalid(
        'That zone does not exist.',
        { zoneId: 'Choose a zone from your list.' },
        'ZONE_NOT_FOUND',
      );
  }

  private async assertNameFree(
    tx: DbTx,
    zoneId: string,
    name: string,
    exceptId: string | null,
  ) {
    const taken = rowsOf(
      await tx.execute(sql`
        select 1 from public.shipping_methods where zone_id = ${zoneId}::uuid and lower(name) = lower(${name})
          ${exceptId ? sql`and id <> ${exceptId}::uuid` : sql``}`),
    );
    if (taken.length > 0)
      throw conflict(
        'This zone already has a method with that name.',
        { name: 'Choose a different name.' },
        'METHOD_NAME_TAKEN',
      );
  }

  private async writeTiers(
    tx: DbTx,
    tenantId: string,
    methodId: string,
    tiers: RateTier[],
  ) {
    for (const t of tiers)
      await tx.execute(sql`
        insert into public.shipping_rate_tiers (tenant_id, method_id, from_value, to_value, rate_minor)
        values (${tenantId}::uuid, ${methodId}::uuid, ${t.from}, ${t.to}, ${t.rateMinor})`);
  }

  private async read(
    tx: DbTx,
    tenantId: string,
    id: string,
  ): Promise<MethodDto> {
    const rows = rowsOf<Row>(
      await tx.execute(sql`
        select ${COLUMNS} from public.shipping_methods m join public.shipping_zones z on z.id = m.zone_id and z.tenant_id = m.tenant_id
        where m.id = ${id}::uuid and m.tenant_id = ${tenantId}::uuid`),
    );
    if (rows.length === 0)
      throw notFound('Shipping method not found.', 'METHOD_NOT_FOUND');
    return (await this.withTiers(tx, tenantId, rows))[0];
  }

  private async withTiers(
    tx: DbTx,
    tenantId: string,
    rows: Row[],
  ): Promise<MethodDto[]> {
    if (rows.length === 0) return [];
    const ids = sql.join(
      rows.map((r) => sql`${r.id as string}::uuid`),
      sql`, `,
    );
    const tiers = rowsOf<{
      method_id: string;
      from_value: number;
      to_value: number | null;
      rate_minor: number;
    }>(
      await tx.execute(sql`
        select method_id, from_value::float8 as from_value, to_value::float8 as to_value, rate_minor::float8 as rate_minor
        from public.shipping_rate_tiers where tenant_id = ${tenantId}::uuid and method_id in (${ids}) order by method_id, from_value`),
    );
    return rows.map((r) => ({
      id: r.id as string,
      zoneId: r.zone_id as string,
      zoneName: r.zone_name as string,
      name: r.name as string,
      kind: r.kind as string,
      pricingType: r.pricing_type as string,
      flatRateMinor: Number(r.flat_rate_minor),
      freeOverMinor: num(r.free_over_minor),
      handlingMinor: Number(r.handling_minor),
      minOrderMinor: Number(r.min_order_minor),
      maxOrderMinor: num(r.max_order_minor),
      minWeightGrams: Number(r.min_weight_grams),
      maxWeightGrams: num(r.max_weight_grams),
      estimatedDaysMin: num(r.est_days_min),
      estimatedDaysMax: num(r.est_days_max),
      codAllowed: r.cod_allowed as boolean,
      carrierCode: (r.carrier_code as string | null) ?? null,
      sortOrder: Number(r.sort_order),
      enabled: r.enabled as boolean,
      tiers: tiers
        .filter((t) => t.method_id === r.id)
        .map((t) => ({
          from: Number(t.from_value),
          to: num(t.to_value),
          rateMinor: Number(t.rate_minor),
        })),
      createdAt: new Date(r.created_at as string),
      updatedAt: new Date(r.updated_at as string),
    }));
  }
}
