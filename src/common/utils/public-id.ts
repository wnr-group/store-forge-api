import { randomInt } from 'node:crypto';

/** Public tenant identifier: lowercase letters and digits. Matches the tenants_public_id_check constraint (5-8 chars). */
export const PUBLIC_ID_PATTERN = /^[a-z0-9]{5,8}$/;

const ALPHABET = 'abcdefghijklmnopqrstuvwxyz0123456789';
export const PUBLIC_ID_LENGTH = 6;

/** Cryptographically secure random public id. randomInt is unbiased, unlike `byte % 36`. */
export function generatePublicId(length = PUBLIC_ID_LENGTH): string {
  let id = '';
  for (let i = 0; i < length; i++) id += ALPHABET[randomInt(ALPHABET.length)];
  return id;
}
