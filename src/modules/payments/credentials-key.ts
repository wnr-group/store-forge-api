/**
 * Master key for the tenants' payment credentials (Razorpay secrets), read from the environment on demand.
 *
 * Deliberately NOT part of `config/env.validation.ts`: that class fails the whole application at startup, but only the
 * payment-settings save needs this key. A missing or invalid key must leave the storefront, the dashboard, the status
 * read and the removal of a configuration working, and make only the save fail closed (see payments.service).
 *
 * One variable per key version: `CREDENTIALS_ENCRYPTION_KEY_V<n>` holds 32 random bytes, standard base64 (generate with
 * `openssl rand -base64 32`), and `CREDENTIALS_ENCRYPTION_KEY_CURRENT` names the version used for new writes. Older
 * versions stay configured so rows written under them remain readable after a rotation.
 */

/** Why a key could not be used. Only this category is ever logged or returned, never any value. */
export type CredentialsKeyFailure = 'key_missing' | 'key_invalid';

export class CredentialsKeyError extends Error {
  readonly category: CredentialsKeyFailure;

  constructor(category: CredentialsKeyFailure) {
    super(category);
    this.name = 'CredentialsKeyError';
    this.category = category;
  }
}

export type KeyEnv = Readonly<Record<string, string | undefined>>;

export interface LoadedKey {
  key: Buffer;
  version: number;
}

const KEY_BYTES = 32;
/** Positive integer without a leading zero; the `key_version` column is a smallint. */
const VERSION_PATTERN = /^[1-9][0-9]{0,4}$/;
const MAX_VERSION = 32767;
const BASE64_PATTERN = /^[A-Za-z0-9+/]+={0,2}$/;

function currentVersion(env: KeyEnv): number {
  const raw = env.CREDENTIALS_ENCRYPTION_KEY_CURRENT;
  if (raw === undefined || raw === '')
    throw new CredentialsKeyError('key_missing');
  if (!VERSION_PATTERN.test(raw) || Number(raw) > MAX_VERSION)
    throw new CredentialsKeyError('key_invalid');
  return Number(raw);
}

/** The key of one specific version. Strict on purpose: anything not exactly 32 canonical base64 bytes is refused. */
export function loadKeyVersion(
  version: number,
  env: KeyEnv = process.env,
): LoadedKey {
  if (!Number.isInteger(version) || version < 1 || version > MAX_VERSION)
    throw new CredentialsKeyError('key_invalid');
  const raw = env[`CREDENTIALS_ENCRYPTION_KEY_V${version}`];
  if (raw === undefined || raw === '')
    throw new CredentialsKeyError('key_missing');
  if (raw.length % 4 !== 0 || !BASE64_PATTERN.test(raw))
    throw new CredentialsKeyError('key_invalid');
  const key = Buffer.from(raw, 'base64');
  if (key.length !== KEY_BYTES || key.toString('base64') !== raw)
    throw new CredentialsKeyError('key_invalid');
  return { key, version };
}

/** The key used for new writes. Validated every time it is asked for, never at startup. */
export function loadKey(env: KeyEnv = process.env): LoadedKey {
  return loadKeyVersion(currentVersion(env), env);
}
