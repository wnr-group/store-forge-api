import { Injectable, Logger } from '@nestjs/common';
import { sql } from 'drizzle-orm';
import type { DbTx } from '../database/database.types.js';

export interface AuditEntry {
  action: string;
  entityType: string;
  entityId?: string | null;
  organizationId?: string | null;
  description: string;
  previous?: Record<string, unknown> | null;
  next?: Record<string, unknown> | null;
}

@Injectable()
export class AuditService {
  private readonly logger = new Logger(AuditService.name);

  /**
   * Records an audit log entry in the current transaction using public.platform_record_audit (AC-B-76 to AC-B-78).
   * Runs atomically with the mutation. Returns the generated audit record ID.
   */
  async record(tx: DbTx, entry: AuditEntry): Promise<string> {
    const prevJson = entry.previous ? JSON.stringify(entry.previous) : null;
    const nextJson = entry.next ? JSON.stringify(entry.next) : null;

    const rows = await tx.execute<{ id: string }>(
      sql`select public.platform_record_audit(
        ${entry.action},
        ${entry.entityType},
        ${entry.entityId ? sql`${entry.entityId}::uuid` : null},
        ${entry.organizationId ? sql`${entry.organizationId}::uuid` : null},
        ${entry.description},
        ${prevJson ? sql`${prevJson}::jsonb` : null},
        ${nextJson ? sql`${nextJson}::jsonb` : null}
      ) as id`,
    );

    const id = rows[0]?.id;
    return id;
  }
}
