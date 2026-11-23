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

export interface FakeRefund {
  id: string;
  payment_id: string;
  amount: number;
  currency: string;
  status: 'pending' | 'processed' | 'failed';
  receipt: string | null;
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
  readonly refunds = new Map<string, FakeRefund>();
  /** The state a newly created refund starts in. */
  refundStartsAs: FakeRefund['status'] = 'processed';
  /** Razorpay answers the next refund request with an error of this HTTP status (and creates nothing). */
  rejectNextRefundWith: number | null = null;
  /** Simulates a lost response: the next refund IS created at Razorpay, but the caller sees a network failure. */
  loseNextRefundResponse = false;
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
    const orderPayments = /^\/v1\/orders\/([^/]+)\/payments$/.exec(
      url.pathname,
    );
    if (orderPayments && method === 'GET')
      return json(200, {
        entity: 'collection',
        items: [...this.payments.values()].filter(
          (p) => p.order_id === orderPayments[1],
        ),
      });
    const refundOne = /^\/v1\/refunds\/([^/]+)$/.exec(url.pathname);
    if (refundOne && method === 'GET') {
      const r = this.refunds.get(refundOne[1]);
      return r
        ? json(200, r)
        : json(400, {
            error: {
              code: 'BAD_REQUEST_ERROR',
              description: 'The id provided does not exist',
            },
          });
    }
    const refundsOf = /^\/v1\/payments\/([^/]+)\/refunds$/.exec(url.pathname);
    if (refundsOf && method === 'GET')
      return json(200, {
        entity: 'collection',
        items: [...this.refunds.values()].filter(
          (r) => r.payment_id === refundsOf[1],
        ),
      });
    const refundCreate = /^\/v1\/payments\/([^/]+)\/refund$/.exec(url.pathname);
    if (refundCreate && method === 'POST') {
      if (this.rejectNextRefundWith) {
        const status = this.rejectNextRefundWith;
        this.rejectNextRefundWith = null;
        return json(status, {
          error: {
            code: 'BAD_REQUEST_ERROR',
            description: 'The refund amount is not valid',
          },
        });
      }
      const payment = this.payments.get(refundCreate[1]);
      if (!payment || payment.status !== 'captured')
        return json(400, {
          error: {
            code: 'BAD_REQUEST_ERROR',
            description: 'The payment has not been captured',
          },
        });
      const already = [...this.refunds.values()]
        .filter((r) => r.payment_id === payment.id && r.status !== 'failed')
        .reduce((sum, r) => sum + r.amount, 0);
      if (Number(body.amount) + already > payment.amount)
        return json(400, {
          error: {
            code: 'BAD_REQUEST_ERROR',
            description:
              'The refund amount is greater than the amount available for refund',
          },
        });
      const refund: FakeRefund = {
        id: `rfnd_FAKE${String(++this.counter).padStart(8, '0')}`,
        payment_id: payment.id,
        amount: Number(body.amount),
        currency: payment.currency,
        status: this.refundStartsAs,
        receipt: typeof body.receipt === 'string' ? body.receipt : null,
      };
      this.refunds.set(refund.id, refund);
      if (this.loseNextRefundResponse) {
        this.loseNextRefundResponse = false;
        throw new TypeError('fetch failed');
      }
      return json(200, refund);
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

  /** A signed webhook exactly as Razorpay would send it: the raw bytes and the signature over them. */
  webhook(
    event: string,
    payload: Record<string, unknown>,
    secret: string,
    eventId = `evt_${Math.random().toString(36).slice(2, 14)}`,
  ) {
    const raw = Buffer.from(
      JSON.stringify({
        entity: 'event',
        event,
        contains: Object.keys(payload),
        payload,
        created_at: 1,
      }),
    );
    return {
      raw,
      signature: createHmac('sha256', secret).update(raw).digest('hex'),
      eventId,
    };
  }
}
