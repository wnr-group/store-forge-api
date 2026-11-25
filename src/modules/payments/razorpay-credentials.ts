import { sql } from 'drizzle-orm';
import { rowsOf, type DbTx } from '../../database/database.service.js';
import { decryptSecret } from './credentials-crypto.js';
import type { KeyEnv } from './credentials-key.js';

/**
 * The reviewed reader of a tenant's Razorpay credentials. It is the only caller of `decryptSecret`.
 *
 * It must run inside a transaction of the tenant-pinned checkout role: the SECURITY DEFINER function it calls refuses any
 * tenant other than the pinned one, and `authenticated` (so PostgREST) cannot execute it at all. The plaintext secrets live
 * only in the returned object, which callers keep in a local variable for the duration of one operation and never log,
 * store or return.
 */
export interface RazorpayAccount {
  keyId: string;
  keySecret: string;
  /** null when the Owner has not saved one. */
  webhookSecret: string | null;
  enabled: boolean;
  verified: boolean;
}

interface Row {
  key_id: string;
  secret_ciphertext: string;
  iv: string;
  auth_tag: string;
  key_version: number;
  webhook_secret_ciphertext: string | null;
  webhook_secret_iv: string | null;
  webhook_secret_auth_tag: string | null;
  webhook_secret_key_version: number | null;
  enabled: boolean;
  verification_status: string;
}

/** `null` when the tenant has no Razorpay credentials. Throws if decryption fails (wrong key, tampered data). */
export async function loadRazorpayAccount(
  tx: DbTx,
  tenantId: string,
  env: KeyEnv = process.env,
): Promise<RazorpayAccount | null> {
  const row = rowsOf<Row>(
    await tx.execute(
      sql`select * from public.get_razorpay_credentials(${tenantId}::uuid)`,
    ),
  )[0];
  if (!row) return null;
  const keySecret = decryptSecret(
    {
      ciphertext: row.secret_ciphertext,
      iv: row.iv,
      authTag: row.auth_tag,
      keyVersion: row.key_version,
    },
    tenantId,
    env,
  );
  const webhookSecret =
    row.webhook_secret_ciphertext &&
    row.webhook_secret_iv &&
    row.webhook_secret_auth_tag &&
    row.webhook_secret_key_version
      ? decryptSecret(
          {
            ciphertext: row.webhook_secret_ciphertext,
            iv: row.webhook_secret_iv,
            authTag: row.webhook_secret_auth_tag,
            keyVersion: row.webhook_secret_key_version,
          },
          tenantId,
          env,
        )
      : null;
  return {
    keyId: row.key_id,
    keySecret,
    webhookSecret,
    enabled: row.enabled,
    verified: row.verification_status === 'verified',
  };
}
