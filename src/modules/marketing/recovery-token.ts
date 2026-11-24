import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import { loadKey, type KeyEnv } from '../payments/credentials-key.js';

/**
 * Recovery links and the browser's cart id, as the database stores them.
 *
 * The recovery token of a cart is NOT stored: it is an HMAC of the cart's own id under a key derived from the server's master
 * key (with its own context label, so it can never double as an encryption key). The database keeps only the SHA-256 of the
 * token, to find the cart when a link is opened; the dashboard recomputes the token on demand to show the link to the owner.
 * A leaked database therefore cannot be turned into working recovery links. The browser's cart id is likewise kept only as a hash.
 */
const CONTEXT = 'storeforge:abandoned-cart-recovery:v1';

export const sha256Hex = (value: string) =>
  createHash('sha256').update(value, 'utf8').digest('hex');

/** The token for one cart. Throws `CredentialsKeyError` when the server has no usable master key. */
export function recoveryTokenFor(
  tenantId: string,
  cartId: string,
  env: KeyEnv = process.env,
): string {
  const { key } = loadKey(env);
  const derived = createHmac('sha256', key).update(CONTEXT).digest();
  return createHmac('sha256', derived)
    .update(`${tenantId.toLowerCase()}:${cartId.toLowerCase()}`)
    .digest('base64url');
}

/** What is stored to find the cart again from its token. */
export const recoveryTokenHash = (token: string) => sha256Hex(token);

/** A recovery token has exactly one shape; anything else is refused before the database is asked. */
export const looksLikeRecoveryToken = (value: string) =>
  /^[A-Za-z0-9_-]{43}$/.test(value);

/** What is stored of the browser's cart id. */
export const cartKeyHash = (cartKey: string) => sha256Hex(`cart:${cartKey}`);

/** Constant-time string comparison for hashes. */
export function sameHash(a: string, b: string): boolean {
  const x = Buffer.from(a, 'utf8');
  const y = Buffer.from(b, 'utf8');
  return x.length === y.length && timingSafeEqual(x, y);
}
