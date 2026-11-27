import { createHash, randomBytes } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import { sql } from 'drizzle-orm';
import { AppException, notFound } from '../../common/app.exception.js';
import {
  DatabaseService,
  rowsOf,
  type DbTx,
} from '../../database/database.service.js';

/** A tenant id that matches no row: lets the store lookup run before a real tenant can be pinned (same trick as checkout). */
const NO_TENANT = '00000000-0000-0000-0000-000000000000';

/** How long a signed-in storefront session lasts. */
export const SESSION_DAYS = 30;
const TOKEN = /^[A-Za-z0-9_-]{43}$/;

export interface CustomerStore {
  tenantId: string;
  currency: string;
}

/** The signed-in shopper, as the database knows them. Always read from the session row, never from the request. */
export interface CustomerPrincipal {
  accountId: string;
  customerId: string;
  tenantId: string;
  email: string;
  fullName: string;
  phone: string | null;
}

export const hashSessionToken = (token: string) =>
  createHash('sha256').update(token).digest('hex');

/** The way a shopper proves who they are on every account route. A missing or bad session is always the same 401. */
export const loginRequired = () =>
  new AppException('UNAUTHENTICATED', 'Sign in to continue.', {
    code: 'CUSTOMER_LOGIN_REQUIRED',
  });

/**
 * Storefront customer sessions. Separate from the owner/staff/admin sessions on purpose: an opaque random token stored (hashed)
 * in `customer_sessions`, valid for ONE tenant only. The tenant comes from the store slug in the URL (resolved here, on the
 * server) and the session lookup is pinned to it, so a token from store A can never open an account in store B.
 */
@Injectable()
export class CustomerSessionService {
  constructor(private readonly db: DatabaseService) {}

  /** Store slug -> tenant. Unknown, inactive and suspended stores are indistinguishable (not found). */
  async resolveStore(slug: string): Promise<CustomerStore> {
    const row = await this.db.withCheckout(
      NO_TENANT,
      async (tx) =>
        rowsOf<{ tenant_id: string; currency: string }>(
          await tx.execute(
            sql`select tenant_id, currency from public.get_checkout_store(${slug})`,
          ),
        )[0],
    );
    if (!row) throw notFound('Store not found.', 'STORE_NOT_FOUND');
    return { tenantId: row.tenant_id, currency: row.currency };
  }

  /** The shopper behind a token, or null (unknown, expired, signed out, or from another store). */
  async find(
    tx: DbTx,
    tenantId: string,
    token: string | undefined,
  ): Promise<CustomerPrincipal | null> {
    if (!token || !TOKEN.test(token)) return null;
    const row = rowsOf<{
      account_id: string;
      customer_id: string;
      email: string;
      full_name: string;
      phone: string | null;
    }>(
      await tx.execute(sql`
        select a.id as account_id, a.customer_id, a.email, a.full_name, a.phone
        from public.customer_sessions s
        join public.customer_accounts a on a.tenant_id = s.tenant_id and a.id = s.account_id
        where s.tenant_id = ${tenantId}::uuid and s.token_hash = ${hashSessionToken(token)}
          and s.revoked_at is null and s.expires_at > now()`),
    )[0];
    return row
      ? {
          accountId: row.account_id,
          customerId: row.customer_id,
          tenantId,
          email: row.email,
          fullName: row.full_name,
          phone: row.phone,
        }
      : null;
  }

  /** Like `find`, but a missing session is a 401. */
  async require(
    tx: DbTx,
    tenantId: string,
    token: string | undefined,
  ): Promise<CustomerPrincipal> {
    const principal = await this.find(tx, tenantId, token);
    if (!principal) throw loginRequired();
    return principal;
  }

  /** Starts a session. The token is returned ONCE; only its hash is stored. Old, expired sessions of the account are cleared. */
  async issue(tx: DbTx, tenantId: string, accountId: string) {
    await tx.execute(sql`
      delete from public.customer_sessions
      where tenant_id = ${tenantId}::uuid and account_id = ${accountId}::uuid
        and (expires_at < now() or revoked_at is not null)`);
    const token = randomBytes(32).toString('base64url');
    const expiresAt = new Date(Date.now() + SESSION_DAYS * 86_400_000);
    await tx.execute(sql`
      insert into public.customer_sessions (tenant_id, account_id, token_hash, expires_at)
      values (${tenantId}::uuid, ${accountId}::uuid, ${hashSessionToken(token)}, ${expiresAt.toISOString()}::timestamptz)`);
    return { token, expiresAt };
  }

  async revoke(tx: DbTx, tenantId: string, token: string | undefined) {
    if (!token || !TOKEN.test(token)) return;
    await tx.execute(sql`
      update public.customer_sessions set revoked_at = now()
      where tenant_id = ${tenantId}::uuid and token_hash = ${hashSessionToken(token)} and revoked_at is null`);
  }

  /** Signs the account out everywhere except (optionally) one session: used when the password changes. */
  async revokeOthers(
    tx: DbTx,
    tenantId: string,
    accountId: string,
    keepToken: string | undefined,
  ) {
    await tx.execute(sql`
      update public.customer_sessions set revoked_at = now()
      where tenant_id = ${tenantId}::uuid and account_id = ${accountId}::uuid and revoked_at is null
        and token_hash <> ${keepToken ? hashSessionToken(keepToken) : ''}`);
  }
}
