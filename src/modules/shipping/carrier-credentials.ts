import { sql } from 'drizzle-orm';
import { invalid } from '../../common/app.exception.js';
import { rowsOf, type DbTx } from '../../database/database.service.js';
import { decryptSecret } from '../payments/credentials-crypto.js';
import type {
  CarrierCredentials,
  CredentialField,
} from './providers/shipping-provider.js';

/**
 * A tenant's saved carrier connection with its secrets decrypted. This file holds the second reviewed decryption site of the
 * application (the first is the Razorpay reader): it runs inside a transaction of the tenant-pinned checkout role, because the
 * database function it calls refuses any other tenant and cannot be executed by signed-in users at all. Decrypted values live
 * only in the returned object, which callers keep in a local variable for one operation and never log, store or return.
 */
export interface StoredCarrierConnection {
  providerCode: string;
  settings: Record<string, string>;
  secrets: Record<string, string>;
  enabled: boolean;
  isDefault: boolean;
  verified: boolean;
}

interface Row {
  provider_code: string;
  settings: Record<string, string> | string;
  secrets_ciphertext: string;
  iv: string;
  auth_tag: string;
  key_version: number;
  enabled: boolean;
  is_default: boolean;
  verification_status: string;
}

/** The tenant's connection to one carrier, or all of them (`providerCode` left out). Throws if decryption fails. */
export async function loadCarrierConnections(
  tx: DbTx,
  tenantId: string,
  providerCode?: string,
): Promise<StoredCarrierConnection[]> {
  const rows = rowsOf<Row>(
    await tx.execute(
      sql`select * from public.get_carrier_credentials(${tenantId}::uuid, ${providerCode ?? null})`,
    ),
  );
  return rows.map((r) => ({
    providerCode: r.provider_code,
    settings:
      typeof r.settings === 'string'
        ? (JSON.parse(r.settings) as Record<string, string>)
        : r.settings,
    secrets: JSON.parse(
      decryptSecret(
        {
          ciphertext: r.secrets_ciphertext,
          iv: r.iv,
          authTag: r.auth_tag,
          keyVersion: r.key_version,
        },
        tenantId,
      ),
    ) as Record<string, string>,
    enabled: r.enabled,
    isDefault: r.is_default,
    verified: r.verification_status === 'verified',
  }));
}

/** What an adapter receives: settings and secrets side by side. */
export const toCredentials = (
  c: Pick<StoredCarrierConnection, 'settings' | 'secrets'>,
): CarrierCredentials => ({
  ...c.settings,
  ...c.secrets,
});

export const MAX_VALUE_LENGTH = 256;

/** Line breaks, tabs and other control characters have no place in a setting (and often come from a bad paste). */
const hasControlCharacter = (value: string) => {
  for (let i = 0; i < value.length; i += 1) {
    const code = value.charCodeAt(i);
    if (code < 32 || code === 127) return true;
  }
  return false;
};

export interface MergedCredentials {
  settings: Record<string, string>;
  secrets: Record<string, string>;
  /** The keys the caller changed (names only: this list goes into the audit history). */
  changed: string[];
}

/**
 * Applies what the tenant submitted onto what is saved. Secrets can never be read back, so a field that is left out keeps its
 * saved value, a new value replaces it, and an empty value clears a field that is not required. Values are trimmed (a pasted
 * token often carries a space or newline at the end). Everything wrong is reported at once, per field, with fixed wording that
 * never repeats what was typed.
 */
export function mergeCredentials(
  fields: readonly CredentialField[],
  existing: Pick<StoredCarrierConnection, 'settings' | 'secrets'> | null,
  submitted: Record<string, unknown>,
): MergedCredentials {
  const errors: Record<string, string> = {};
  const known = new Map(fields.map((f) => [f.key, f]));
  for (const key of Object.keys(submitted))
    if (!known.has(key))
      errors[key] = 'This setting does not exist for this carrier.';

  const settings: Record<string, string> = {};
  const secrets: Record<string, string> = {};
  const changed: string[] = [];
  for (const f of fields) {
    const before = existing
      ? f.secret
        ? existing.secrets[f.key]
        : existing.settings[f.key]
      : undefined;
    let value = before;
    if (f.key in submitted) {
      const raw = submitted[f.key];
      if (typeof raw !== 'string') {
        errors[f.key] = 'Enter this as text.';
        continue;
      }
      const trimmed = raw.trim();
      if (hasControlCharacter(trimmed)) {
        errors[f.key] = 'This contains characters that are not allowed.';
        continue;
      }
      if (trimmed.length > MAX_VALUE_LENGTH) {
        errors[f.key] =
          `This is too long (at most ${MAX_VALUE_LENGTH} characters).`;
        continue;
      }
      value = trimmed === '' ? undefined : trimmed;
      if (value !== before) changed.push(f.key);
    }
    if (value === undefined) {
      if (f.required && !errors[f.key]) errors[f.key] = 'This is required.';
      continue;
    }
    if (f.options && !f.options.includes(value)) {
      errors[f.key] = `Choose one of: ${f.options.join(', ')}.`;
      continue;
    }
    (f.secret ? secrets : settings)[f.key] = value;
  }
  if (Object.keys(errors).length > 0)
    throw invalid(
      'Some carrier settings need attention.',
      errors,
      'CARRIER_SETTINGS_INVALID',
    );
  return { settings, secrets, changed };
}
