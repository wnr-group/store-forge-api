/**
 * Razorpay Key ID: its approved format, the Test/Live mode it implies, and the masked form shown to the Owner.
 *
 * The mode is derived from the prefix every time and is never stored, so it cannot drift from the key itself. Only valid
 * ids are ever masked or classified; anything else throws rather than being displayed.
 */

/** The approved Key ID pattern. The same expression is a CHECK on the table and is mirrored by the frontend schema. */
export const KEY_ID_PATTERN = /^rzp_(test|live)_[A-Za-z0-9]{8,}$/;

export type RazorpayMode = 'test' | 'live';

const MASK = '••••';
const VISIBLE_TAIL = 4;
/** `rzp_test_` / `rzp_live_`. */
const PREFIX_LENGTH = 9;

export function isValidKeyId(value: unknown): value is string {
  return typeof value === 'string' && KEY_ID_PATTERN.test(value);
}

function assertValid(keyId: string): void {
  if (!isValidKeyId(keyId)) throw new TypeError('not a valid Razorpay Key ID');
}

/** `test` or `live`, from the prefix. */
export function razorpayModeOf(keyId: string): RazorpayMode {
  assertValid(keyId);
  return keyId.startsWith('rzp_live_') ? 'live' : 'test';
}

/**
 * The prefix, a fixed-width mask and the last four characters, e.g. `rzp_test_••••5678`. The mask has the same width for
 * every id, so the length of the id is not revealed, and a valid id always has at least four hidden characters.
 */
export function maskKeyId(keyId: string): string {
  assertValid(keyId);
  return `${keyId.slice(0, PREFIX_LENGTH)}${MASK}${keyId.slice(-VISIBLE_TAIL)}`;
}
