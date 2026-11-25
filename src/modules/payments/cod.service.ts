import { Injectable } from '@nestjs/common';
import { sql } from 'drizzle-orm';
import { invalid } from '../../common/app.exception.js';
import type { OrgContext } from '../../common/interfaces/request-context.js';
import {
  DatabaseService,
  rowsOf,
  type DbTx,
} from '../../database/database.service.js';
import type { CodSettingsDto, SaveCodSettingsDto } from './cod.dto.js';

/** Owner-only Cash on Delivery settings. Runs as the signed-in user, so row level security applies on top of the guard. */
@Injectable()
export class CodService {
  constructor(private readonly db: DatabaseService) {}

  get(org: OrgContext): Promise<CodSettingsDto> {
    return this.db.withUser(org.userId, (tx) => this.read(tx, org.tenantId));
  }

  async save(
    org: OrgContext,
    dto: SaveCodSettingsDto,
  ): Promise<CodSettingsDto> {
    const max = dto.maxOrderMinor ?? null;
    if (max !== null && max < dto.minOrderMinor)
      throw invalid('The maximum cannot be lower than the minimum.', {
        maxOrderMinor: 'The maximum cannot be lower than the minimum.',
      });
    return this.db.withUser(org.userId, async (tx) => {
      await tx.execute(sql`
        insert into public.tenant_cod_config (tenant_id, enabled, min_order_minor, max_order_minor, fee_minor, updated_at, updated_by)
        values (${org.tenantId}::uuid, ${dto.enabled}, ${dto.minOrderMinor}, ${max}, ${dto.feeMinor}, now(), ${org.userId}::uuid)
        on conflict (tenant_id) do update set enabled = ${dto.enabled}, min_order_minor = ${dto.minOrderMinor},
          max_order_minor = ${max}, fee_minor = ${dto.feeMinor}, updated_at = now(), updated_by = ${org.userId}::uuid`);
      return this.read(tx, org.tenantId);
    });
  }

  private async read(tx: DbTx, tenantId: string): Promise<CodSettingsDto> {
    const row = rowsOf<{
      enabled: boolean;
      min_order_minor: number;
      max_order_minor: number | null;
      fee_minor: number;
      updated_at: string;
    }>(
      await tx.execute(sql`
        select enabled, min_order_minor::float8 as min_order_minor, max_order_minor::float8 as max_order_minor,
          fee_minor::float8 as fee_minor, updated_at
        from public.tenant_cod_config where tenant_id = ${tenantId}::uuid`),
    )[0];
    if (!row)
      return {
        configured: false,
        enabled: false,
        minOrderMinor: 0,
        maxOrderMinor: null,
        feeMinor: 0,
        updatedAt: null,
      };
    return {
      configured: true,
      enabled: row.enabled,
      minOrderMinor: Number(row.min_order_minor),
      maxOrderMinor:
        row.max_order_minor === null ? null : Number(row.max_order_minor),
      feeMinor: Number(row.fee_minor),
      updatedAt: new Date(row.updated_at),
    };
  }
}
