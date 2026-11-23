import { Inject, Injectable, Optional } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { AppConfig } from '../../config/configuration.js';

/**
 * The ONLY place that talks to Razorpay. It uses Razorpay's REST API directly (no SDK), with the tenant's own Key ID and Key
 * Secret passed per call and never stored on the instance, never logged and never put in an error message.
 *
 * Timeouts: every request is cut off after `timeoutMs`. Retries: only requests that cannot change anything (GET) are retried,
 * and only for network failures, 429 and 5xx. Creating an order or capturing a payment is NEVER retried automatically, because
 * a retry after an unseen success could create a second order or capture twice; those failures are surfaced instead.
 */
export const RAZORPAY_FETCH = Symbol('RAZORPAY_FETCH');
export const RAZORPAY_TIMINGS = Symbol('RAZORPAY_TIMINGS');

export interface RazorpayTimings {
  timeoutMs: number;
  retryDelayMs: number;
}
export const RAZORPAY_BASE_URL = 'https://api.razorpay.com';

export interface RazorpayCredentials {
  keyId: string;
  keySecret: string;
}

export type RazorpayErrorKind =
  /** Razorpay refused the Key ID / Key Secret (HTTP 401). */
  | 'auth'
  /** Razorpay understood the request and said no (HTTP 400/404/422...). */
  | 'rejected'
  /** Network failure, timeout, 429 or 5xx: nothing is known about the outcome. */
  | 'unavailable'
  /** Razorpay answered with something that is not the documented shape. */
  | 'invalid_response';

export class RazorpayError extends Error {
  constructor(
    readonly kind: RazorpayErrorKind,
    message: string,
    readonly status?: number,
    readonly code?: string,
  ) {
    super(message);
    this.name = 'RazorpayError';
  }
}

export interface RazorpayOrder {
  id: string;
  amountMinor: number;
  currency: string;
  status: string;
}

export interface RazorpayPayment {
  id: string;
  orderId: string | null;
  amountMinor: number;
  currency: string;
  /** created | authorized | captured | refunded | failed */
  status: string;
  method: string | null;
  errorCode: string | null;
  errorDescription: string | null;
}

type Json = Record<string, unknown>;
const str = (v: unknown): string | null => (typeof v === 'string' ? v : null);

@Injectable()
export class RazorpayClient {
  private readonly fetchImpl: typeof fetch;
  private readonly baseUrl: string;
  private readonly timeoutMs: number;
  private readonly retryDelayMs: number;

  constructor(
    @Optional() @Inject(RAZORPAY_FETCH) fetchImpl?: typeof fetch,
    @Optional() config?: ConfigService<AppConfig, true>,
    @Optional() @Inject(RAZORPAY_TIMINGS) timings?: RazorpayTimings,
  ) {
    this.timeoutMs = timings?.timeoutMs ?? 10_000;
    this.retryDelayMs = timings?.retryDelayMs ?? 250;
    this.fetchImpl = fetchImpl ?? ((...a) => fetch(...a));
    this.baseUrl =
      config?.get('razorpay', { infer: true })?.apiBaseUrl ?? RAZORPAY_BASE_URL;
  }

  /** Proves the Key ID and Key Secret work, without creating anything: lists at most one order. */
  async validateCredentials(creds: RazorpayCredentials): Promise<void> {
    await this.request(creds, 'GET', '/v1/orders?count=1', undefined, true);
  }

  async createOrder(
    creds: RazorpayCredentials,
    input: {
      amountMinor: number;
      currency: string;
      receipt: string;
      notes?: Record<string, string>;
    },
  ): Promise<RazorpayOrder> {
    const body = await this.request(creds, 'POST', '/v1/orders', {
      amount: input.amountMinor,
      currency: input.currency,
      receipt: input.receipt.slice(0, 40),
      notes: input.notes ?? {},
    });
    const id = str(body.id);
    if (!id || typeof body.amount !== 'number' || !str(body.currency))
      throw new RazorpayError(
        'invalid_response',
        'Unexpected Razorpay order response.',
      );
    return {
      id,
      amountMinor: body.amount,
      currency: str(body.currency)!,
      status: str(body.status) ?? 'created',
    };
  }

  async fetchPayment(
    creds: RazorpayCredentials,
    paymentId: string,
  ): Promise<RazorpayPayment> {
    return this.toPayment(
      await this.request(
        creds,
        'GET',
        `/v1/payments/${encodeURIComponent(paymentId)}`,
        undefined,
        true,
      ),
    );
  }

  async capturePayment(
    creds: RazorpayCredentials,
    paymentId: string,
    amountMinor: number,
    currency: string,
  ): Promise<RazorpayPayment> {
    return this.toPayment(
      await this.request(
        creds,
        'POST',
        `/v1/payments/${encodeURIComponent(paymentId)}/capture`,
        { amount: amountMinor, currency },
      ),
    );
  }

  private toPayment(body: Json): RazorpayPayment {
    const id = str(body.id);
    const status = str(body.status);
    if (!id || !status || typeof body.amount !== 'number')
      throw new RazorpayError(
        'invalid_response',
        'Unexpected Razorpay payment response.',
      );
    return {
      id,
      orderId: str(body.order_id),
      amountMinor: body.amount,
      currency: str(body.currency) ?? 'INR',
      status,
      method: str(body.method),
      errorCode: str(body.error_code),
      errorDescription: str(body.error_description),
    };
  }

  private async request(
    creds: RazorpayCredentials,
    method: 'GET' | 'POST',
    path: string,
    payload?: Json,
    retryable = false,
  ): Promise<Json> {
    const attempts = retryable ? 3 : 1;
    const authorization = `Basic ${Buffer.from(`${creds.keyId}:${creds.keySecret}`).toString('base64')}`;
    let last: RazorpayError | undefined;
    for (let attempt = 0; attempt < attempts; attempt += 1) {
      if (attempt > 0)
        await new Promise((r) =>
          setTimeout(r, this.retryDelayMs * 2 ** (attempt - 1)),
        );
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), this.timeoutMs);
      try {
        const res = await this.fetchImpl(`${this.baseUrl}${path}`, {
          method,
          headers: {
            Authorization: authorization,
            'Content-Type': 'application/json',
            Accept: 'application/json',
          },
          body: payload ? JSON.stringify(payload) : undefined,
          signal: controller.signal,
        });
        const text = await res.text();
        let body: Json = {};
        try {
          body = text ? (JSON.parse(text) as Json) : {};
        } catch {
          if (res.ok)
            throw new RazorpayError(
              'invalid_response',
              'Razorpay sent an unreadable response.',
              res.status,
            );
        }
        if (res.ok) return body;
        const error = (body.error ?? {}) as Json;
        const description = (
          str(error.description) ?? 'Razorpay rejected the request.'
        ).slice(0, 200);
        if (res.status === 401)
          throw new RazorpayError(
            'auth',
            'Razorpay rejected the Key ID or Key Secret.',
            401,
            str(error.code) ?? undefined,
          );
        if (res.status === 429 || res.status >= 500)
          throw new RazorpayError(
            'unavailable',
            'Razorpay is temporarily unavailable.',
            res.status,
          );
        throw new RazorpayError(
          'rejected',
          description,
          res.status,
          str(error.code) ?? undefined,
        );
      } catch (error) {
        if (error instanceof RazorpayError) {
          if (error.kind !== 'unavailable') throw error;
          last = error;
        } else {
          // Abort (timeout) or a network error: the message could contain the URL, so it is not kept.
          last = new RazorpayError('unavailable', 'Could not reach Razorpay.');
        }
      } finally {
        clearTimeout(timer);
      }
    }
    throw last ?? new RazorpayError('unavailable', 'Could not reach Razorpay.');
  }
}
