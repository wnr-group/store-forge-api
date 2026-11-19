import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { loadKey, loadKeyVersion, type KeyEnv } from './credentials-key.js';

/**
 * AES-256-GCM encryption of a tenant's payment secret. Every write gets a fresh random 12-byte IV and a 16-byte
 * authentication tag, and the tenant id is bound in as additional authenticated data, so a stored row copied to
 * another tenant fails to authenticate.
 *
 * This module only encrypts. There is intentionally no decryption path in production code: reading a secret back needs
 * its own reviewed, access-controlled function. The one decrypt helper below exists for the round-trip and tamper tests
 * and is checked by a static test to be unreachable from any other source file.
 */

/** Storage cap for the base64 ciphertext (also a CHECK on the table). 2048 characters hold at most 1536 plaintext bytes. */
export const MAX_CIPHERTEXT_CHARS = 2048;

const IV_BYTES = 12;
const TAG_BYTES = 16;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The encrypted form would not fit the storage cap. Carries no secret, so it is safe to log and map. */
export class CredentialsTooLargeError extends Error {
  constructor() {
    super('ciphertext_too_large');
    this.name = 'CredentialsTooLargeError';
  }
}

export interface EncryptedSecret {
  /** Base64. */
  ciphertext: string;
  /** Base64 of the 12-byte IV. */
  iv: string;
  /** Base64 of the 16-byte GCM tag. */
  authTag: string;
  keyVersion: number;
}

/** The tenant uuid, lower-cased so database casing can never change what was authenticated. */
function tenantAad(tenantId: string): Buffer {
  if (typeof tenantId !== 'string' || !UUID.test(tenantId))
    throw new TypeError('tenantId must be a uuid');
  return Buffer.from(tenantId.toLowerCase(), 'utf8');
}

/**
 * Encrypts `secret` for `tenantId` under the current key version. Throws `CredentialsKeyError` when the key is missing
 * or unusable (nothing is produced) and `CredentialsTooLargeError` when the result would exceed the storage cap
 * (never truncated).
 */
export function encryptSecret(
  secret: string,
  tenantId: string,
  env: KeyEnv = process.env,
): EncryptedSecret {
  if (typeof secret !== 'string' || secret.length === 0)
    throw new TypeError('secret must be a non-empty string');
  const aad = tenantAad(tenantId);
  const { key, version } = loadKey(env);

  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv('aes-256-gcm', key, iv, {
    authTagLength: TAG_BYTES,
  });
  cipher.setAAD(aad);
  const encrypted = Buffer.concat([
    cipher.update(secret, 'utf8'),
    cipher.final(),
  ]);
  const ciphertext = encrypted.toString('base64');
  if (ciphertext.length > MAX_CIPHERTEXT_CHARS)
    throw new CredentialsTooLargeError();

  return {
    ciphertext,
    iv: iv.toString('base64'),
    authTag: cipher.getAuthTag().toString('base64'),
    keyVersion: version,
  };
}

/** Test-only inverse of `encryptSecret`. Throws if the key, tenant id, IV, tag or ciphertext do not match. */
function decryptSecret(
  encrypted: EncryptedSecret,
  tenantId: string,
  env: KeyEnv = process.env,
): string {
  const { key } = loadKeyVersion(encrypted.keyVersion, env);
  const decipher = createDecipheriv(
    'aes-256-gcm',
    key,
    Buffer.from(encrypted.iv, 'base64'),
    { authTagLength: TAG_BYTES },
  );
  decipher.setAAD(tenantAad(tenantId));
  decipher.setAuthTag(Buffer.from(encrypted.authTag, 'base64'));
  return Buffer.concat([
    decipher.update(Buffer.from(encrypted.ciphertext, 'base64')),
    decipher.final(),
  ]).toString('utf8');
}

/** Tests only. A static test fails if anything else in `src` mentions this. */
export const __testing = { decryptSecret };
