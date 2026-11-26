import { randomInt } from 'node:crypto';

const ALPHABET = 'abcdefghijklmnopqrstuvwxyz0123456789';

/** The longest base kept before a suffix is added, so `base-xxxx` always fits the 40 characters the database allows. */
const BASE_MAX = 30;
/** The shortest store address the database accepts (`is_valid_store_slug`). */
const SLUG_MIN = 3;

const randomSuffix = (length: number): string => {
  let out = '';
  for (let i = 0; i < length; i++) out += ALPHABET[randomInt(ALPHABET.length)];
  return out;
};

/**
 * The store address a store name asks for: lower case, accents folded, everything that is not a letter or digit turned into one hyphen,
 * no hyphen at either end. Returns '' when nothing usable is left (a name written only in another script, or only symbols).
 */
export function slugFromStoreName(name: string): string {
  return name
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, BASE_MAX)
    .replace(/-+$/g, '');
}

/**
 * Store addresses to try for a store name, best first: the plain one, then the same with a short random suffix (so two stores called
 * "Blue Door" both get a working address). The caller moves on when the database says an address is taken or not allowed (reserved).
 */
export function slugCandidates(name: string, suffixed = 5): string[] {
  const base = slugFromStoreName(name);
  const out: string[] = [];
  if (base.length >= SLUG_MIN) out.push(base);
  const stem = base.length >= 2 ? base : 'store';
  for (let i = 0; i < suffixed; i++) out.push(`${stem}-${randomSuffix(4)}`);
  return out;
}
