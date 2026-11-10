import { sql, type SQL } from 'drizzle-orm';
import type { Database, DbTx } from './database.types.js';

/** Hard-coded on purpose: the role is never derived from any input. */
const REQUEST_ROLE_SQL = sql.raw('set local role authenticated');

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export class RlsGuardError extends Error {
  constructor(message: string) {
    super(`RLS guard failed: ${message}`);
    this.name = 'RlsGuardError';
  }
}

/** Normalises `tx.execute()` results across drivers (postgres-js: array; pglite: { rows }). */
export function rowsOf<T = Record<string, unknown>>(result: unknown): T[] {
  if (Array.isArray(result)) return result as T[];
  const rows = (result as { rows?: unknown } | null)?.rows;
  return Array.isArray(rows) ? (rows as T[]) : [];
}

// Connections that already passed the guard (checked once per client, not per request).
const verified = new WeakSet<object>();

/**
 * Refuses to run if RLS could be bypassed: the login role or the request role
 * is a superuser / has BYPASSRLS, or the role switch didn't take effect.
 * Runs inside the first request transaction, after SET LOCAL ROLE.
 */
async function assertRlsEnforced(tx: DbTx) {
  const rows = rowsOf<{
    current_user: string;
    session_user: string;
    bad_roles: string[] | null;
  }>(
    await tx.execute(sql`
      select current_user, session_user,
        (select array_agg(rolname) from pg_roles
          where rolname in (current_user, session_user) and (rolsuper or rolbypassrls)) as bad_roles
    `),
  );
  const row = rows[0];
  if (!row || row.current_user !== 'authenticated') {
    throw new RlsGuardError(
      `request role is "${row?.current_user}", expected "authenticated"`,
    );
  }
  if (row.bad_roles?.length) {
    throw new RlsGuardError(
      `role(s) ${row.bad_roles.join(', ')} can bypass row level security`,
    );
  }
}

/**
 * Runs `fn` in a transaction acting as `userId`.
 *
 * `userId` MUST come from a server-validated Supabase session, never from the browser.
 * It is checked to be a UUID before any transaction or SQL is executed.
 * Any error thrown by `fn` rolls the whole transaction back.
 */
export async function withUserContext<T>(
  db: Database,
  userId: string,
  fn: (tx: DbTx) => Promise<T>,
): Promise<T> {
  if (!UUID.test(userId)) {
    throw new Error('withUserContext: userId must be a UUID');
  }
  const claims = JSON.stringify({ sub: userId, role: 'authenticated' });

  return db.transaction(async (tx) => {
    const lit = (value: string) => `'${value.replaceAll("'", "''")}'`;
    const setClaims: SQL = sql.raw(`select
      set_config('request.jwt.claims', ${lit(claims)}, true),
      set_config('request.jwt.claim.sub', ${lit(userId)}, true),
      set_config('request.jwt.claim.role', 'authenticated', true)`);

    await Promise.all([tx.execute(setClaims), tx.execute(REQUEST_ROLE_SQL)]);

    if (!verified.has(db)) {
      await assertRlsEnforced(tx);
      verified.add(db);
    }
    return fn(tx);
  });
}

/**
 * Runs `fn` as the request role with NO user identity, for the public storefront only.
 */
export async function withPublicContext<T>(
  db: Database,
  fn: (tx: DbTx) => Promise<T>,
): Promise<T> {
  return db.transaction(async (tx) => {
    await tx.execute(
      sql`select set_config('request.jwt.claims', '', true), set_config('request.jwt.claim.sub', '', true)`,
    );
    await tx.execute(REQUEST_ROLE_SQL);
    if (!verified.has(db)) {
      await assertRlsEnforced(tx);
      verified.add(db);
    }
    return fn(tx);
  });
}
