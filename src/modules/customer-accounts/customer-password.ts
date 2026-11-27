import { randomBytes, scrypt, timingSafeEqual } from 'node:crypto';

/**
 * Storefront customer passwords. scrypt (built into Node, memory-hard) with a per-password random salt; the stored text is
 * `scrypt$N$r$p$salt$hash` so the cost can be raised later and old hashes still verify. A plain-text password is never stored,
 * logged or returned.
 */
const N = 16384;
const R = 8;
const P = 1;
const KEY_LENGTH = 64;
const MAX_MEMORY = 64 * 1024 * 1024;

const derive = (
  password: string,
  salt: Buffer,
  n: number,
  r: number,
  p: number,
  length: number,
) =>
  new Promise<Buffer>((resolve, reject) =>
    scrypt(
      password.normalize('NFKC'),
      salt,
      length,
      { N: n, r, p, maxmem: MAX_MEMORY },
      (error, key) => (error ? reject(error) : resolve(key)),
    ),
  );

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const key = await derive(password, salt, N, R, P, KEY_LENGTH);
  return `scrypt$${N}$${R}$${P}$${salt.toString('base64url')}$${key.toString('base64url')}`;
}

export async function verifyPassword(
  password: string,
  stored: string,
): Promise<boolean> {
  const parts = stored.split('$');
  if (parts.length !== 6 || parts[0] !== 'scrypt') return false;
  const [n, r, p] = [parts[1], parts[2], parts[3]].map(Number);
  if (![n, r, p].every((v) => Number.isSafeInteger(v) && v > 0)) return false;
  // A stored value is trusted, but never let a damaged one ask for unbounded memory.
  if (128 * n * r > MAX_MEMORY) return false;
  const salt = Buffer.from(parts[4], 'base64url');
  const expected = Buffer.from(parts[5], 'base64url');
  if (salt.length === 0 || expected.length === 0) return false;
  const actual = await derive(password, salt, n, r, p, expected.length);
  return timingSafeEqual(actual, expected);
}

/** A hash nobody knows the password of: checked when the email is unknown, so "no such account" costs the same time as "wrong password". */
let decoy: Promise<string> | undefined;
export const decoyHash = () =>
  (decoy ??= hashPassword(randomBytes(24).toString('base64url')));
