import { createHmac, timingSafeEqual } from 'node:crypto';

/**
 * Razorpay signatures are lowercase-hex HMAC-SHA256. Comparison is constant-time and never throws on malformed input.
 */
function safeEqualHex(expected: string, supplied: unknown): boolean {
  if (typeof supplied !== 'string' || !/^[0-9a-f]{64}$/i.test(supplied))
    return false;
  const a = Buffer.from(expected, 'hex');
  const b = Buffer.from(supplied.toLowerCase(), 'hex');
  return a.length === b.length && timingSafeEqual(a, b);
}

/** Checkout success callback: HMAC_SHA256(razorpay_order_id + "|" + razorpay_payment_id, key_secret). */
export function verifyCheckoutSignature(
  razorpayOrderId: string,
  razorpayPaymentId: string,
  signature: unknown,
  keySecret: string,
): boolean {
  const expected = createHmac('sha256', keySecret)
    .update(`${razorpayOrderId}|${razorpayPaymentId}`)
    .digest('hex');
  return safeEqualHex(expected, signature);
}

/** Webhook: HMAC_SHA256(raw request body, webhook secret), compared with the X-Razorpay-Signature header. */
export function verifyWebhookSignature(
  rawBody: Buffer | string,
  signature: unknown,
  webhookSecret: string,
): boolean {
  const expected = createHmac('sha256', webhookSecret)
    .update(rawBody)
    .digest('hex');
  return safeEqualHex(expected, signature);
}
