/**
 * Razorpay Key Secret: the approved format.
 *
 * The rule is `^[A-Za-z0-9]{16,128}$`. It is based on ONE observed disposable test-mode credential (24 alphanumeric
 * characters with upper-case, lower-case and digits) and is NOT an officially guaranteed Razorpay format; a live secret
 * may differ, in which case the rule is widened by a forward change. The lower bound is a safety margin below the
 * observed length. The upper bound keeps the plaintext far below the 1536 bytes that fit the 2048-character
 * ciphertext cap.
 *
 * The value is never trimmed or normalised, so padding is rejected rather than silently stored. The frontend schema
 * mirrors this rule exactly.
 */
export const KEY_SECRET_MIN_LENGTH = 16;
export const KEY_SECRET_MAX_LENGTH = 128;
export const KEY_SECRET_PATTERN = /^[A-Za-z0-9]{16,128}$/;

export function isValidKeySecret(value: unknown): value is string {
  return typeof value === 'string' && KEY_SECRET_PATTERN.test(value);
}
