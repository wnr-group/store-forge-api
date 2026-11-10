import { Injectable } from '@nestjs/common';
import { sql } from 'drizzle-orm';
import {
  DatabaseService,
  rowsOf,
  type DbTx,
} from '../../../database/database.service.js';
import { recordAudit } from '../audit/audit.service.js';
import { mapProvisioningError } from '../platform-errors.js';
import type {
  PlatformSettingsDto,
  UpdatePlatformSettingsDto,
} from './settings.dto.js';

type SettingsRaw = {
  platform_name: string;
  support_email: string | null;
  default_currency: string;
  default_timezone: string;
  default_store_status: 'active' | 'inactive';
  updated_at: string | Date;
  updated_by_email: string | null;
};

/**
 * Platform settings: the values that used to be hardcoded. Stored in a table nobody can reach directly; admins read
 * them through get_platform_settings(), super admins change them through platform_update_settings() (validated again
 * in SQL). Nothing secret is stored here.
 */
@Injectable()
export class PlatformSettingsService {
  constructor(private readonly db: DatabaseService) {}

  private async fetch(tx: DbTx): Promise<PlatformSettingsDto> {
    const r = rowsOf<SettingsRaw>(
      await tx.execute(sql`select * from public.get_platform_settings()`),
    )[0];
    return {
      platformName: r.platform_name,
      supportEmail: r.support_email,
      defaultCurrency: r.default_currency,
      defaultTimezone: r.default_timezone,
      defaultStoreStatus: r.default_store_status,
      updatedAt: new Date(r.updated_at),
      updatedByEmail: r.updated_by_email,
    };
  }

  get(adminId: string): Promise<PlatformSettingsDto> {
    return this.db.withUser(adminId, (tx) => this.fetch(tx));
  }

  /** Super admins only (the guard checks first, the SQL function again). Nothing is written or logged when nothing changed. */
  async update(
    adminId: string,
    v: UpdatePlatformSettingsDto,
  ): Promise<PlatformSettingsDto> {
    try {
      await this.db.withUser(adminId, async (tx) => {
        const before = await this.fetch(tx);
        const after = {
          platformName: v.platformName ?? before.platformName,
          supportEmail:
            v.supportEmail !== undefined ? v.supportEmail : before.supportEmail,
          defaultCurrency: v.defaultCurrency ?? before.defaultCurrency,
          defaultTimezone: v.defaultTimezone ?? before.defaultTimezone,
          defaultStoreStatus: v.defaultStoreStatus ?? before.defaultStoreStatus,
        };
        const previous: Record<string, unknown> = {};
        const next: Record<string, unknown> = {};
        const changed: string[] = [];
        for (const key of Object.keys(after) as (keyof typeof after)[]) {
          if (before[key] === after[key]) continue;
          changed.push(key);
          previous[key] = before[key];
          next[key] = after[key];
        }
        if (changed.length === 0) return;
        await tx.execute(sql`select public.platform_update_settings(
          ${after.platformName}, ${after.supportEmail}, ${after.defaultCurrency}, ${after.defaultTimezone}, ${after.defaultStoreStatus})`);
        await recordAudit(tx, {
          action: 'platform_settings.updated',
          entityType: 'platform_settings',
          description: `Updated platform settings: ${changed.join(', ')}`,
          previous,
          next,
        });
      });
    } catch (error) {
      return mapProvisioningError(error);
    }
    return this.get(adminId);
  }
}
