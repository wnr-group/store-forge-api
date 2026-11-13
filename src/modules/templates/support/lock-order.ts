import { sql } from 'drizzle-orm';
import type { DbTx } from '../../../infrastructure/database/database.types.js';

export const DEFAULT_LOCK_TIMEOUT_MS = 3000;

export interface TxLockContext {
  hasStoreLock: boolean;
  lockedTemplateIds: Set<string>;
}

export function createLockContext(): TxLockContext {
  return {
    hasStoreLock: false,
    lockedTemplateIds: new Set<string>(),
  };
}

/** Sets LOCAL lock_timeout for the current transaction (D51). */
export async function setLockTimeout(
  tx: DbTx,
  timeoutMs = DEFAULT_LOCK_TIMEOUT_MS,
): Promise<void> {
  await tx.execute(sql.raw(`SET LOCAL lock_timeout = '${timeoutMs}ms'`));
}

/** Locks the store row for update (D50 rule 1). Sets hasStoreLock in context. */
export async function lockStore(
  tx: DbTx,
  tenantId: string,
  storeId: string,
  ctx?: TxLockContext,
): Promise<{ id: string }> {
  const rows = await tx.execute<{ id: string }>(
    sql`SELECT id FROM stores WHERE id = ${storeId} AND tenant_id = ${tenantId} FOR UPDATE`,
  );
  if (!rows[0]) {
    throw new Error(`Store not found or access denied: ${storeId}`);
  }
  if (ctx) ctx.hasStoreLock = true;
  return rows[0];
}

/** Locks template rows in ascending UUID order for update (D50 rule 2, 5). */
export async function lockTemplates(
  tx: DbTx,
  templateIds: string[],
  ctx?: TxLockContext,
): Promise<string[]> {
  if (templateIds.length === 0) return [];
  const sortedIds = [...new Set(templateIds)].sort();
  const idParams = sql.join(
    sortedIds.map((id) => sql`${id}`),
    sql`, `,
  );
  const rows = await tx.execute<{ id: string }>(
    sql`SELECT id FROM templates WHERE id IN (${idParams}) ORDER BY id ASC FOR UPDATE`,
  );
  if (ctx) {
    for (const r of rows) ctx.lockedTemplateIds.add(r.id);
  }
  return rows.map((r) => r.id);
}

/** Locks template rows in ascending UUID order FOR SHARE (D50 rule 3). */
export async function lockSharedTemplates(
  tx: DbTx,
  templateIds: string[],
  ctx?: TxLockContext,
): Promise<string[]> {
  if (templateIds.length === 0) return [];
  const sortedIds = [...new Set(templateIds)].sort();
  const idParams = sql.join(
    sortedIds.map((id) => sql`${id}`),
    sql`, `,
  );
  const rows = await tx.execute<{ id: string }>(
    sql`SELECT id FROM templates WHERE id IN (${idParams}) ORDER BY id ASC FOR SHARE`,
  );
  if (ctx) {
    for (const r of rows) ctx.lockedTemplateIds.add(r.id);
  }
  return rows.map((r) => r.id);
}

/** Asserts store lock was acquired before template lock in this transaction context (D50 rule 5). */
export function assertLockOrder(ctx: TxLockContext, action: string): void {
  if (!ctx.hasStoreLock && ctx.lockedTemplateIds.size > 0) {
    throw new Error(
      `Lock order violation: cannot perform ${action} without prior store lock`,
    );
  }
}
