import { describe, expect, it, vi } from 'vitest';
import { RazorpayClient, RazorpayError } from './razorpay.client.js';
import {
  verifyCheckoutSignature,
  verifyWebhookSignature,
} from './razorpay-signature.js';
import { createHmac } from 'node:crypto';

const CREDS = {
  keyId: 'rzp_test_AbCdEfGh12345678',
  keySecret: 'SuperSecretValue1234567890',
};
const reply = (status: number, body: unknown = {}) =>
  new Response(JSON.stringify(body), { status });
const client = (fetchImpl: typeof fetch, timeoutMs = 50) =>
  new RazorpayClient(fetchImpl, undefined, { timeoutMs, retryDelayMs: 0 });

describe('RazorpayClient', () => {
  it('sends the tenant keys as Basic auth to the Razorpay API', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(reply(200, { items: [] }));
    await client(fetchImpl).validateCredentials(CREDS);
    const [url, init] = fetchImpl.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://api.razorpay.com/v1/orders?count=1');
    expect(new Headers(init.headers).get('authorization')).toBe(
      `Basic ${Buffer.from(`${CREDS.keyId}:${CREDS.keySecret}`).toString('base64')}`,
    );
  });

  it('maps 401 to an auth error without echoing anything sent', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValue(
        reply(401, { error: { description: 'Authentication failed' } }),
      );
    const error = await client(fetchImpl)
      .validateCredentials(CREDS)
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(RazorpayError);
    expect((error as RazorpayError).kind).toBe('auth');
    expect(JSON.stringify(error) + (error as Error).message).not.toContain(
      CREDS.keySecret,
    );
    expect(fetchImpl).toHaveBeenCalledTimes(1); // an auth failure is final, never retried
  });

  it('retries a read after a 503 and then succeeds', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(reply(503))
      .mockResolvedValueOnce(reply(429))
      .mockResolvedValueOnce(
        reply(200, {
          id: 'pay_1',
          status: 'captured',
          amount: 500,
          currency: 'INR',
          order_id: 'order_1',
        }),
      );
    const payment = await client(fetchImpl).fetchPayment(CREDS, 'pay_1');
    expect(payment).toMatchObject({
      id: 'pay_1',
      status: 'captured',
      amountMinor: 500,
      orderId: 'order_1',
    });
    expect(fetchImpl).toHaveBeenCalledTimes(3);
  });

  it('gives up after three tries on a read and reports "unavailable"', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(reply(500));
    const error = await client(fetchImpl)
      .fetchPayment(CREDS, 'pay_1')
      .catch((e: unknown) => e);
    expect((error as RazorpayError).kind).toBe('unavailable');
    expect(fetchImpl).toHaveBeenCalledTimes(3);
  });

  it('never retries creating an order or capturing a payment', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(reply(503));
    await expect(
      client(fetchImpl).createOrder(CREDS, {
        amountMinor: 1000,
        currency: 'INR',
        receipt: 'SF-1',
      }),
    ).rejects.toMatchObject({ kind: 'unavailable' });
    await expect(
      client(fetchImpl).capturePayment(CREDS, 'pay_1', 1000, 'INR'),
    ).rejects.toMatchObject({
      kind: 'unavailable',
    });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it('times out a request that never answers', async () => {
    const fetchImpl = vi.fn(
      (_url: unknown, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) =>
          init?.signal?.addEventListener('abort', () =>
            reject(new Error('aborted https://api.razorpay.com/secret-path')),
          ),
        ),
    ) as unknown as typeof fetch;
    const error = await client(fetchImpl, 20)
      .createOrder(CREDS, {
        amountMinor: 1000,
        currency: 'INR',
        receipt: 'SF-1',
      })
      .catch((e: unknown) => e);
    expect((error as RazorpayError).kind).toBe('unavailable');
    // The raw network error text (which can carry URLs) is not kept.
    expect((error as Error).message).toBe('Could not reach Razorpay.');
  });

  it("treats a 400 as a rejection with Razorpay's own reason, trimmed", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      reply(400, {
        error: { code: 'BAD_REQUEST_ERROR', description: 'x'.repeat(500) },
      }),
    );
    const error = await client(fetchImpl)
      .createOrder(CREDS, {
        amountMinor: 1000,
        currency: 'INR',
        receipt: 'SF-1',
      })
      .catch((e: unknown) => e);
    expect(error).toMatchObject({
      kind: 'rejected',
      status: 400,
      code: 'BAD_REQUEST_ERROR',
    });
    expect((error as Error).message.length).toBe(200);
  });

  it('rejects an answer that is not the documented shape', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(reply(200, { id: 'order_1' }));
    await expect(
      client(fetchImpl).createOrder(CREDS, {
        amountMinor: 1000,
        currency: 'INR',
        receipt: 'SF-1',
      }),
    ).rejects.toMatchObject({ kind: 'invalid_response' });
  });

  it("shortens the receipt to Razorpay's 40-character limit", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      reply(200, {
        id: 'order_1',
        amount: 1000,
        currency: 'INR',
        status: 'created',
      }),
    );
    await client(fetchImpl).createOrder(CREDS, {
      amountMinor: 1000,
      currency: 'INR',
      receipt: 'R'.repeat(60),
    });
    const body = JSON.parse(
      (fetchImpl.mock.calls[0] as [string, { body: string }])[1].body,
    ) as { receipt: string };
    expect(body.receipt).toHaveLength(40);
  });
});

describe('signatures', () => {
  const secret = 'SuperSecretValue1234567890';
  const good = createHmac('sha256', secret)
    .update('order_A|pay_B')
    .digest('hex');

  it('accepts the signature Razorpay Checkout produces', () => {
    expect(verifyCheckoutSignature('order_A', 'pay_B', good, secret)).toBe(
      true,
    );
    expect(
      verifyCheckoutSignature('order_A', 'pay_B', good.toUpperCase(), secret),
    ).toBe(true);
  });

  it.each([
    ['another payment', ['order_A', 'pay_C', good]],
    ['another order', ['order_X', 'pay_B', good]],
    [
      'the wrong secret',
      [
        'order_A',
        'pay_B',
        createHmac('sha256', 'other-secret-value')
          .update('order_A|pay_B')
          .digest('hex'),
      ],
    ],
    ['a short value', ['order_A', 'pay_B', 'abc']],
    ['a non-string', ['order_A', 'pay_B', undefined]],
    ['non-hex text', ['order_A', 'pay_B', 'z'.repeat(64)]],
  ])('rejects %s', (_name, [o, p, sig]) => {
    expect(verifyCheckoutSignature(o as string, p as string, sig, secret)).toBe(
      false,
    );
  });

  it('checks webhook bodies byte for byte', () => {
    const body = '{"event":"payment.captured"}';
    const sig = createHmac('sha256', 'whsec-value-123')
      .update(body)
      .digest('hex');
    expect(verifyWebhookSignature(body, sig, 'whsec-value-123')).toBe(true);
    expect(verifyWebhookSignature(body + ' ', sig, 'whsec-value-123')).toBe(
      false,
    );
    expect(
      verifyWebhookSignature(Buffer.from(body), sig, 'whsec-value-123'),
    ).toBe(true);
  });
});
