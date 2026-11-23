import { createHmac } from 'node:crypto';

/**
 * An in-memory stand-in for the parts of Razorpay's REST API the application uses, plugged into RazorpayClient as its
 * `fetch`. It checks the Basic auth header like the real service, keeps orders and payments, and lets a test decide what a
 * payment looks like. It proves OUR code against the documented request/response shapes; it does not prove Razorpay itself
 * (that needs the real sandbox, see test/real).
 */
export interface FakePayment {
  id: string;
  order_id: string;
  amount: number;
  currency: string;
  status: 'created' | 'authorized' | 'captured' | 'failed' | 'refunded';
  method: string;
  error_code?: string | null;
  error_description?: string | null;
}

export class FakeRazorpay {
  keyId: string;
  keySecret: string;
  readonly orders = new Map<
    string,
    {
      id: string;
      amount: number;
      currency: string;
      status: string;
      receipt: string;
    }
  >();
  readonly payments = new Map<string, FakePayment>();
  readonly calls: { method: string; path: string }[] = [];
  /** When set, every request answers with this status (for outage tests). */
  failWith: number | null = null;
  private counter = 0;

  constructor(keyId: string, keySecret: string) {
    this.keyId = keyId;
    this.keySecret = keySecret;
  }

  readonly fetch: typeof fetch = async (input, init) => {
    const url = new URL(String(input));
    const method = (init?.method ?? 'GET').toUpperCase();
    const path = url.pathname + url.search;
    this.calls.push({ method, path });
    const json = (status: number, body: unknown) =>
      new Response(JSON.stringify(body), {
        status,
        headers: { 'content-type': 'application/json' },
      });

    if (this.failWith)
      return json(this.failWith, {
        error: { code: 'SERVER_ERROR', description: 'down' },
      });
    const auth = new Headers(init?.headers).get('authorization');
    const expected = `Basic ${Buffer.from(`${this.keyId}:${this.keySecret}`).toString('base64')}`;
    if (auth !== expected)
      return json(401, {
        error: {
          code: 'BAD_REQUEST_ERROR',
          description: 'Authentication failed',
        },
      });

    const body = init?.body
      ? (JSON.parse(String(init.body)) as Record<string, unknown>)
      : {};
    if (method === 'GET' && url.pathname === '/v1/orders')
      return json(200, { entity: 'collection', count: 0, items: [] });
    if (method === 'POST' && url.pathname === '/v1/orders') {
      const id = `order_FAKE${String(++this.counter).padStart(8, '0')}`;
      const order = {
        id,
        amount: Number(body.amount),
        currency: String(body.currency),
        status: 'created',
        receipt: String(body.receipt ?? ''),
      };
      this.orders.set(id, order);
      return json(200, order);
    }
    const pay = /^\/v1\/payments\/([^/]+)(\/capture)?$/.exec(url.pathname);
    if (pay) {
      const payment = this.payments.get(pay[1]);
      if (!payment)
        return json(400, {
          error: {
            code: 'BAD_REQUEST_ERROR',
            description: 'The id provided does not exist',
          },
        });
      if (method === 'GET' && !pay[2]) return json(200, payment);
      if (method === 'POST' && pay[2]) {
        if (payment.status !== 'authorized')
          return json(400, {
            error: {
              code: 'BAD_REQUEST_ERROR',
              description: 'This payment has already been captured',
            },
          });
        if (Number(body.amount) !== payment.amount)
          return json(400, {
            error: {
              code: 'BAD_REQUEST_ERROR',
              description:
                'Capture amount must be equal to the amount authorized',
            },
          });
        payment.status = 'captured';
        return json(200, payment);
      }
    }
    return json(404, {
      error: { code: 'BAD_REQUEST_ERROR', description: 'not found' },
    });
  };

  /** A payment the shopper made against a Razorpay order, in the given state. */
  pay(
    razorpayOrderId: string,
    status: FakePayment['status'] = 'captured',
    over: Partial<FakePayment> = {},
  ): FakePayment {
    const order = this.orders.get(razorpayOrderId);
    const payment: FakePayment = {
      id: `pay_FAKE${String(++this.counter).padStart(8, '0')}`,
      order_id: razorpayOrderId,
      amount: order?.amount ?? 0,
      currency: order?.currency ?? 'INR',
      status,
      method: 'upi',
      ...(status === 'failed'
        ? {
            error_code: 'BAD_REQUEST_ERROR',
            error_description: 'Payment failed at the bank',
          }
        : {}),
      ...over,
    };
    this.payments.set(payment.id, payment);
    return payment;
  }

  /** What Razorpay Checkout would sign for the browser. */
  signature(
    razorpayOrderId: string,
    paymentId: string,
    secret = this.keySecret,
  ): string {
    return createHmac('sha256', secret)
      .update(`${razorpayOrderId}|${paymentId}`)
      .digest('hex');
  }
}
