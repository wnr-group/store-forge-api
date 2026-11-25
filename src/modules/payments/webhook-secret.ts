/**
 * Razorpay webhook secret: the string the Owner types into Razorpay's webhook settings and into the dashboard, so both sides
 * sign and verify with the same value. Razorpay lets the account holder choose it, so the rule is deliberately plain: 8 to 128
 * visible ASCII characters, no spaces. Like the Key Secret it is never trimmed or normalised, so padding is rejected rather
 * than silently stored.
 */
export const WEBHOOK_SECRET_MIN_LENGTH = 8;
export const WEBHOOK_SECRET_MAX_LENGTH = 128;
export const WEBHOOK_SECRET_PATTERN = /^[\x21-\x7E]{8,128}$/;

export function isValidWebhookSecret(value: unknown): value is string {
  return typeof value === 'string' && WEBHOOK_SECRET_PATTERN.test(value);
}
