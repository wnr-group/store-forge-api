import { Injectable } from '@nestjs/common';
import { sql } from 'drizzle-orm';
import { Paginated } from '../../../common/dto/api-response.dto.js';
import {
  DatabaseService,
  rowsOf,
  type DbTx,
} from '../../../database/database.service.js';
import type { AuditEntry } from './audit-actions.js';
import type { AuditLogDto, AuditQueryDto } from './audit.dto.js';

/**
 * Records one action INSIDE the caller's transaction, so the change and its log entry commit or roll back together.
 * Callers have already been authorised as Platform Admins; the SQL function checks again and takes the administrator
 * from the session, never from input.
 */
export async function recordAudit(tx: DbTx, e: AuditEntry): Promise<void> {
  await tx.execute(sql`select public.platform_record_audit(
    ${e.action}, ${e.entityType}, ${e.entityId ?? null}::uuid, ${e.organizationId ?? null}::uuid, ${e.description},
    ${e.previous ? JSON.stringify(e.previous) : null}::jsonb, ${e.next ? JSON.stringify(e.next) : null}::jsonb)`);
}

type AuditRaw = {
  id: string;
  admin_user_id: string;
  admin_email: string;
  action: string;
  entity_type: string;
  entity_id: string | null;
  organization_id: string | null;
  organization_name: string | null;
  description: string;
  previous_data: unknown;
  new_data: unknown;
  created_at: string | Date;
  total_count: string | number | bigint;
};

/** `YYYY-MM-DD` -> the start of that day (UTC); `plusDays` gives the exclusive end of a range. */
const day = (s: string | undefined, plusDays = 0): string | null => {
  if (!s) return null;
  const d = new Date(`${s}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + plusDays);
  return d.toISOString();
};

/** Platform Admin audit trail: written by platform_record_audit(), read by platform_list_audit(); the table itself cannot be reached. */
@Injectable()
export class AuditService {
  constructor(private readonly db: DatabaseService) {}

  private fetchPage(tx: DbTx, q: AuditQueryDto, page: number) {
    return tx
      .execute(
        sql`select * from public.platform_list_audit(
          ${q.action === 'all' ? null : q.action}, ${q.admin === 'all' ? null : q.admin}::uuid, ${q.org || null}::uuid, ${q.search || null},
          ${day(q.from)}::timestamptz, ${day(q.to, 1)}::timestamptz, ${q.limit}, ${(page - 1) * q.limit})`,
      )
      .then((r) => rowsOf<AuditRaw>(r));
  }

  async list(
    adminId: string,
    q: AuditQueryDto,
  ): Promise<Paginated<AuditLogDto>> {
    return this.db.withUser(adminId, async (tx) => {
      let page = q.page;
      let raw = await this.fetchPage(tx, q, page);
      if (raw.length === 0 && page > 1) {
        // A page past the end (an old link): show the last real page instead of an empty one.
        const first = await this.fetchPage(tx, q, 1);
        page = Math.max(
          1,
          Math.ceil(Number(first[0]?.total_count ?? 0) / q.limit),
        );
        raw = page === 1 ? first : await this.fetchPage(tx, q, page);
      }
      return new Paginated(
        raw.map((r) => ({
          id: r.id,
          adminUserId: r.admin_user_id,
          adminEmail: r.admin_email,
          action: r.action,
          entityType: r.entity_type,
          entityId: r.entity_id,
          organizationId: r.organization_id,
          organizationName: r.organization_name,
          description: r.description,
          previousData: r.previous_data,
          newData: r.new_data,
          createdAt: new Date(r.created_at),
        })),
        { page, limit: q.limit, total: Number(raw[0]?.total_count ?? 0) },
      );
    });
  }

  /** Administrators who appear in the log, for a filter dropdown. */
  async admins(adminId: string): Promise<{ id: string; email: string }[]> {
    return this.db.withUser(adminId, async (tx) => {
      const rows = rowsOf<{ admin_user_id: string; admin_email: string }>(
        await tx.execute(sql`select * from public.platform_audit_admins()`),
      );
      return rows
        .map((r) => ({ id: r.admin_user_id, email: r.admin_email }))
        .sort((a, b) => a.email.localeCompare(b.email));
    });
  }
}
