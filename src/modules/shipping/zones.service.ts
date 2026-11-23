import { Injectable } from '@nestjs/common';
import { sql } from 'drizzle-orm';
import { conflict, notFound } from '../../common/app.exception.js';
import type { OrgContext } from '../../common/interfaces/request-context.js';
import {
  DatabaseService,
  rowsOf,
  type DbTx,
} from '../../database/database.service.js';
import { expandAreas, findConflicts, type AreaRow } from './shipping-areas.js';
import { stateNameOf } from './shipping-quote.service.js';
import type {
  SaveZoneDto,
  ZoneAreaSummaryDto,
  ZoneAreasOutDto,
  ZoneDetailDto,
  ZoneDto,
} from './zones.dto.js';

interface AreaDbRow {
  zone_id: string;
  kind: AreaRow['kind'];
  state_code: string | null;
  city: string | null;
  postal_code: string | null;
  postal_from: string | null;
  postal_to: string | null;
}

const toArea = (r: AreaDbRow): AreaRow => ({
  kind: r.kind,
  stateCode: r.state_code,
  city: r.city,
  postalCode: r.postal_code,
  postalFrom: r.postal_from,
  postalTo: r.postal_to,
});

const summarise = (areas: AreaRow[]): ZoneAreaSummaryDto => ({
  country: areas.some((a) => a.kind === 'country'),
  states: areas.filter((a) => a.kind === 'state').length,
  cities: areas.filter((a) => a.kind === 'city').length,
  postalCodes: areas.filter((a) => a.kind === 'postal_code').length,
  postalRanges: areas.filter((a) => a.kind === 'postal_range').length,
});

const detail = (areas: AreaRow[]): ZoneAreasOutDto => ({
  country: areas.some((a) => a.kind === 'country'),
  states: areas
    .filter((a) => a.kind === 'state')
    .map((a) => ({ code: a.stateCode!, name: stateNameOf(a.stateCode!) })),
  cities: areas
    .filter((a) => a.kind === 'city')
    .map((a) => ({
      stateCode: a.stateCode!,
      state: stateNameOf(a.stateCode!),
      city: a.city!,
    })),
  postalCodes: areas
    .filter((a) => a.kind === 'postal_code')
    .map((a) => a.postalCode!)
    .sort(),
  postalRanges: areas
    .filter((a) => a.kind === 'postal_range')
    .map((a) => ({ from: a.postalFrom!, to: a.postalTo! }))
    .sort((x, y) => x.from.localeCompare(y.from)),
});

/** Insert in chunks: one statement with thousands of rows would exceed the driver's parameter limit. */
const CHUNK = 400;

/**
 * Shipping zones. Reads and writes run as the signed-in user (row level security applies on top of the `shipping:*` guards).
 * Every write takes a per-organization lock first, so two edits at once cannot each pass the conflict check and then together
 * create an overlap.
 */
@Injectable()
export class ZonesService {
  constructor(private readonly db: DatabaseService) {}

  list(org: OrgContext): Promise<ZoneDto[]> {
    return this.db.withUser(org.userId, async (tx) => {
      const zones = rowsOf<Record<string, unknown>>(
        await tx.execute(sql`
          select z.id, z.name, z.enabled, z.cod_allowed, z.created_at, z.updated_at,
            (select count(*)::int from public.shipping_methods m where m.zone_id = z.id) as method_count
          from public.shipping_zones z where z.tenant_id = ${org.tenantId}::uuid order by z.name`),
      );
      const areas = await this.areasOf(tx, org.tenantId);
      return zones.map((z) => ({
        ...this.base(z),
        areaSummary: summarise(areas.get(z.id as string) ?? []),
      }));
    });
  }

  get(org: OrgContext, id: string): Promise<ZoneDetailDto> {
    return this.db.withUser(org.userId, (tx) =>
      this.read(tx, org.tenantId, id),
    );
  }

  async create(org: OrgContext, dto: SaveZoneDto): Promise<ZoneDetailDto> {
    const areas = expandAreas(dto.areas);
    return this.db.withUser(org.userId, async (tx) => {
      await this.lock(tx, org.tenantId);
      await this.assertNameFree(tx, org.tenantId, dto.name, null);
      await this.assertNoConflicts(tx, org.tenantId, null, areas);
      const id = rowsOf<{ id: string }>(
        await tx.execute(sql`
          insert into public.shipping_zones (tenant_id, name, enabled, cod_allowed)
          values (${org.tenantId}::uuid, ${dto.name}, ${dto.enabled ?? true}, ${dto.codAllowed ?? true}) returning id`),
      )[0].id;
      await this.writeAreas(tx, org.tenantId, id, areas);
      return this.read(tx, org.tenantId, id);
    });
  }

  async update(
    org: OrgContext,
    id: string,
    dto: SaveZoneDto,
  ): Promise<ZoneDetailDto> {
    const areas = expandAreas(dto.areas);
    return this.db.withUser(org.userId, async (tx) => {
      await this.lock(tx, org.tenantId);
      await this.assertExists(tx, org.tenantId, id);
      await this.assertNameFree(tx, org.tenantId, dto.name, id);
      await this.assertNoConflicts(tx, org.tenantId, id, areas);
      await tx.execute(sql`
        update public.shipping_zones set name = ${dto.name}, enabled = ${dto.enabled ?? true}, cod_allowed = ${dto.codAllowed ?? true}, updated_at = now()
        where id = ${id}::uuid and tenant_id = ${org.tenantId}::uuid`);
      await tx.execute(
        sql`delete from public.shipping_zone_areas where zone_id = ${id}::uuid and tenant_id = ${org.tenantId}::uuid`,
      );
      await this.writeAreas(tx, org.tenantId, id, areas);
      return this.read(tx, org.tenantId, id);
    });
  }

  /** Deletes the zone with its areas, methods and rate bands. Orders already placed keep their own copy of what was charged. */
  async remove(org: OrgContext, id: string): Promise<void> {
    await this.db.withUser(org.userId, async (tx) => {
      await this.lock(tx, org.tenantId);
      const removed = rowsOf(
        await tx.execute(
          sql`delete from public.shipping_zones where id = ${id}::uuid and tenant_id = ${org.tenantId}::uuid returning id`,
        ),
      );
      if (removed.length === 0)
        throw notFound('Zone not found.', 'ZONE_NOT_FOUND');
    });
  }

  // --- internals -------------------------------------------------------------------------------------------------------

  private lock(tx: DbTx, tenantId: string) {
    return tx.execute(
      sql`select pg_advisory_xact_lock(hashtextextended(${`shipping-zones:${tenantId}`}, 0))`,
    );
  }

  private async assertExists(tx: DbTx, tenantId: string, id: string) {
    const found = rowsOf(
      await tx.execute(
        sql`select 1 from public.shipping_zones where id = ${id}::uuid and tenant_id = ${tenantId}::uuid`,
      ),
    );
    if (found.length === 0) throw notFound('Zone not found.', 'ZONE_NOT_FOUND');
  }

  private async assertNameFree(
    tx: DbTx,
    tenantId: string,
    name: string,
    exceptId: string | null,
  ) {
    const taken = rowsOf(
      await tx.execute(sql`
        select 1 from public.shipping_zones where tenant_id = ${tenantId}::uuid and lower(name) = lower(${name})
          ${exceptId ? sql`and id <> ${exceptId}::uuid` : sql``}`),
    );
    if (taken.length > 0)
      throw conflict(
        'Another zone already has that name.',
        { name: 'Choose a different name.' },
        'ZONE_NAME_TAKEN',
      );
  }

  private async assertNoConflicts(
    tx: DbTx,
    tenantId: string,
    exceptId: string | null,
    areas: AreaRow[],
  ) {
    const others = rowsOf<AreaDbRow & { zone_name: string }>(
      await tx.execute(sql`
        select a.zone_id, z.name as zone_name, a.kind, a.state_code, a.city, a.postal_code, a.postal_from, a.postal_to
        from public.shipping_zone_areas a join public.shipping_zones z on z.id = a.zone_id and z.tenant_id = a.tenant_id
        where a.tenant_id = ${tenantId}::uuid ${exceptId ? sql`and a.zone_id <> ${exceptId}::uuid` : sql``}`),
    );
    const byZone = new Map<string, { zoneName: string; areas: AreaRow[] }>();
    for (const r of others) {
      const entry = byZone.get(r.zone_id) ?? {
        zoneName: r.zone_name,
        areas: [],
      };
      entry.areas.push(toArea(r));
      byZone.set(r.zone_id, entry);
    }
    const found = findConflicts(areas, [...byZone.values()], stateNameOf);
    if (found.length > 0)
      throw conflict(
        'Another zone already covers part of this one.',
        {
          areas:
            found.slice(0, 5).join(' ') +
            (found.length > 5 ? ` (and ${found.length - 5} more)` : ''),
        },
        'ZONE_CONFLICT',
      );
  }

  private async writeAreas(
    tx: DbTx,
    tenantId: string,
    zoneId: string,
    areas: AreaRow[],
  ) {
    for (let i = 0; i < areas.length; i += CHUNK) {
      const values = areas
        .slice(i, i + CHUNK)
        .map(
          (a) =>
            sql`(${tenantId}::uuid, ${zoneId}::uuid, ${a.kind}, ${a.stateCode}, ${a.city}, ${a.postalCode}, ${a.postalFrom}, ${a.postalTo})`,
        );
      await tx.execute(sql`
        insert into public.shipping_zone_areas (tenant_id, zone_id, kind, state_code, city, postal_code, postal_from, postal_to)
        values ${sql.join(values, sql`, `)}`);
    }
  }

  private async areasOf(
    tx: DbTx,
    tenantId: string,
    zoneId?: string,
  ): Promise<Map<string, AreaRow[]>> {
    const rows = rowsOf<AreaDbRow>(
      await tx.execute(sql`
        select zone_id, kind, state_code, city, postal_code, postal_from, postal_to from public.shipping_zone_areas
        where tenant_id = ${tenantId}::uuid ${zoneId ? sql`and zone_id = ${zoneId}::uuid` : sql``}`),
    );
    const byZone = new Map<string, AreaRow[]>();
    for (const r of rows)
      byZone.set(r.zone_id, [...(byZone.get(r.zone_id) ?? []), toArea(r)]);
    return byZone;
  }

  private base(z: Record<string, unknown>) {
    return {
      id: z.id as string,
      name: z.name as string,
      enabled: z.enabled as boolean,
      codAllowed: z.cod_allowed as boolean,
      methodCount: Number(z.method_count ?? 0),
      createdAt: new Date(z.created_at as string),
      updatedAt: new Date(z.updated_at as string),
    };
  }

  private async read(
    tx: DbTx,
    tenantId: string,
    id: string,
  ): Promise<ZoneDetailDto> {
    const z = rowsOf<Record<string, unknown>>(
      await tx.execute(sql`
        select z.id, z.name, z.enabled, z.cod_allowed, z.created_at, z.updated_at,
          (select count(*)::int from public.shipping_methods m where m.zone_id = z.id) as method_count
        from public.shipping_zones z where z.id = ${id}::uuid and z.tenant_id = ${tenantId}::uuid`),
    )[0];
    if (!z) throw notFound('Zone not found.', 'ZONE_NOT_FOUND');
    const areas = (await this.areasOf(tx, tenantId, id)).get(id) ?? [];
    return {
      ...this.base(z),
      areaSummary: summarise(areas),
      areas: detail(areas),
    };
  }
}
