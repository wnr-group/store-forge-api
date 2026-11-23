import { createHash } from 'node:crypto';
import { Inject, Injectable, Optional } from '@nestjs/common';
import { CarrierError, type TrackingStatus } from './shipping-provider.js';

/**
 * The ONLY code in the shipping module that makes network calls. Every carrier adapter goes through it, which gives all of them
 * the same safety rules:
 *  - a timeout on every request;
 *  - automatic retries ONLY for requests flagged `retry` (reads), and only for network failures, 429 and 5xx. Creating or
 *    cancelling a shipment is never retried automatically, because a retry after an unseen success could duplicate it;
 *  - error messages built from the carrier's answer are cut short and have any credential values removed (`secrets`), and
 *    the URL, headers and request body are never part of an error.
 */
export const CARRIER_FETCH = Symbol('CARRIER_FETCH');
export const CARRIER_TIMINGS = Symbol('CARRIER_TIMINGS');

export interface CarrierTimings {
  timeoutMs: number;
  retryDelayMs: number;
}

export interface CarrierRequest {
  /** Used only in safe messages ("Delhivery rejected the request"). */
  carrier: string;
  method: 'GET' | 'POST';
  url: string;
  headers?: Record<string, string>;
  /** Sent as JSON. */
  json?: unknown;
  /** Sent as application/x-www-form-urlencoded. */
  form?: Record<string, string>;
  /** Safe to repeat (a read). */
  retry?: boolean;
  /** Credential values to scrub from any message that quotes the carrier. */
  secrets?: readonly string[];
}

export interface CarrierResponse {
  status: number;
  /** Parsed JSON, or null when the body was empty or not JSON. */
  body: unknown;
  text: string;
}

const MESSAGE_KEYS = [
  'message',
  'msg',
  'error',
  'error_description',
  'rmk',
  'remarks',
  'detail',
  'errors',
];

/** Pulls a human sentence out of a carrier's error body, if there is one. */
export function messageOf(body: unknown, fallback: string): string {
  const seek = (value: unknown, depth: number): string | null => {
    if (typeof value === 'string' && value.trim()) return value.trim();
    if (depth > 2 || value === null || typeof value !== 'object') return null;
    if (Array.isArray(value)) {
      for (const v of value) {
        const found = seek(v, depth + 1);
        if (found) return found;
      }
      return null;
    }
    for (const key of MESSAGE_KEYS) {
      const found = seek((value as Record<string, unknown>)[key], depth + 1);
      if (found) return found;
    }
    return null;
  };
  return seek(body, 0) ?? fallback;
}

export function scrub(text: string, secrets: readonly string[] = []): string {
  let out = text;
  for (const s of secrets) if (s.length >= 4) out = out.split(s).join('***');
  return out.replace(/\s+/g, ' ').slice(0, 200);
}

@Injectable()
export class CarrierHttp {
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;
  private readonly retryDelayMs: number;

  constructor(
    @Optional() @Inject(CARRIER_FETCH) fetchImpl?: typeof fetch,
    @Optional() @Inject(CARRIER_TIMINGS) timings?: CarrierTimings,
  ) {
    this.fetchImpl = fetchImpl ?? ((...a) => fetch(...a));
    this.timeoutMs = timings?.timeoutMs ?? 15_000;
    this.retryDelayMs = timings?.retryDelayMs ?? 300;
  }

  async request(req: CarrierRequest): Promise<CarrierResponse> {
    const attempts = req.retry ? 3 : 1;
    let last: CarrierError | undefined;
    for (let attempt = 0; attempt < attempts; attempt += 1) {
      if (attempt > 0)
        await new Promise((r) =>
          setTimeout(r, this.retryDelayMs * 2 ** (attempt - 1)),
        );
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), this.timeoutMs);
      try {
        const headers: Record<string, string> = {
          Accept: 'application/json',
          ...req.headers,
        };
        let body: string | undefined;
        if (req.json !== undefined) {
          headers['Content-Type'] = 'application/json';
          body = JSON.stringify(req.json);
        } else if (req.form) {
          headers['Content-Type'] = 'application/x-www-form-urlencoded';
          body = new URLSearchParams(req.form).toString();
        }
        const res = await this.fetchImpl(req.url, {
          method: req.method,
          headers,
          body,
          signal: controller.signal,
        });
        const text = await res.text();
        let parsed: unknown = null;
        try {
          parsed = text ? JSON.parse(text) : null;
        } catch {
          parsed = null;
        }
        if (res.ok) return { status: res.status, body: parsed, text };
        if (res.status === 401 || res.status === 403)
          throw new CarrierError(
            'auth',
            `${req.carrier} did not accept the credentials.`,
            { status: res.status },
          );
        if (res.status === 429 || res.status >= 500)
          throw new CarrierError(
            'unavailable',
            `${req.carrier} is temporarily unavailable.`,
            { status: res.status },
          );
        throw new CarrierError(
          'rejected',
          scrub(
            messageOf(parsed, `${req.carrier} rejected the request.`),
            req.secrets,
          ),
          { status: res.status },
        );
      } catch (error) {
        if (error instanceof CarrierError) {
          if (error.kind !== 'unavailable') throw error;
          last = error;
        } else {
          // Timeout or network failure. The raw error can carry URLs, so it is not kept.
          last = new CarrierError(
            'unavailable',
            `Could not reach ${req.carrier}.`,
          );
        }
      } finally {
        clearTimeout(timer);
      }
    }
    throw (
      last ?? new CarrierError('unavailable', `Could not reach ${req.carrier}.`)
    );
  }
}

// --- Token cache --------------------------------------------------------------------------------------------------------

/**
 * Keeps a carrier's short-lived access token in memory so every call does not log in again. Keys are a hash of the
 * credentials (never the credentials), values live only in this process and expire on their own. A function instance that
 * is recycled simply logs in again.
 */
export class TokenCache {
  private readonly entries = new Map<
    string,
    { token: string; expiresAt: number }
  >();

  constructor(
    private readonly ttlMs: number,
    private readonly now: () => number = Date.now,
  ) {}

  static keyOf(...parts: string[]): string {
    return createHash('sha256').update(parts.join('\u0000')).digest('hex');
  }

  get(key: string): string | undefined {
    const e = this.entries.get(key);
    if (!e) return undefined;
    if (e.expiresAt <= this.now()) {
      this.entries.delete(key);
      return undefined;
    }
    return e.token;
  }

  set(key: string, token: string): void {
    if (this.entries.size > 500) this.entries.clear();
    this.entries.set(key, { token, expiresAt: this.now() + this.ttlMs });
  }

  delete(key: string): void {
    this.entries.delete(key);
  }
}

// --- Small shared helpers ------------------------------------------------------------------------------------------------

/** Rupees as a number or numeric string -> integer paise; null when it is not a usable amount. */
export function rupeesToMinor(value: unknown): number | null {
  const n = typeof value === 'string' ? Number(value.replace(/,/g, '')) : value;
  return typeof n === 'number' && Number.isFinite(n) && n >= 0
    ? Math.round(n * 100)
    : null;
}

export const minorToRupees = (minor: number): number => Math.round(minor) / 100;

/** The last ten digits of an Indian phone number (strips +91, spaces and dashes). */
export const phone10 = (phone: string): string =>
  phone.replace(/\D/g, '').slice(-10);

export function gramsToKg(grams: number): number {
  return Math.max(0.001, Math.round(grams) / 1000);
}

/** Maps a carrier's free-text status to our small set. Order matters: the most specific phrases come first. */
export function normalizeStatus(
  text: string | null | undefined,
): TrackingStatus {
  const t = (text ?? '').toLowerCase();
  if (!t) return 'unknown';
  if (/\bcancel/.test(t)) return 'cancelled';
  if (
    /\brto\b.*(deliver)|return(ed)? to (origin|shipper|seller)|rto delivered/.test(
      t,
    )
  )
    return 'returned';
  if (/\brto\b|return(ing)?|reverse/.test(t)) return 'returning';
  if (/out for delivery|\bofd\b/.test(t)) return 'out_for_delivery';
  if (
    /undeliver|not delivered|delivery attempt|failed|ndr|refus|consignee (unavailable|not)/.test(
      t,
    )
  )
    return 'undelivered';
  if (/deliver/.test(t)) return 'delivered';
  if (
    /in[- ]?transit|shipped|dispatched|arrived|reached|departed|received at|hub|bagged|forwarded/.test(
      t,
    )
  )
    return 'in_transit';
  if (
    /pick(ed)?[- ]?up|picked|collected/.test(t) &&
    !/(schedul|pending|awaiting|requested|not)/.test(t)
  )
    return 'picked_up';
  if (
    /manifest|schedul|pending|awaiting|created|booked|new|ready|open|pickup/.test(
      t,
    )
  )
    return 'pending';
  return 'unknown';
}

/** Only an https address from a carrier's own answer is passed on (never a javascript: or http: link). */
export function safeUrl(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  try {
    const u = new URL(value);
    return u.protocol === 'https:' ? u.toString() : null;
  } catch {
    return null;
  }
}

export function parseDate(value: unknown): Date | null {
  if (typeof value !== 'string' && typeof value !== 'number') return null;
  const d = new Date(
    typeof value === 'string' && /^\d{4}-\d{2}-\d{2} \d/.test(value)
      ? value.replace(' ', 'T') + '+05:30'
      : value,
  );
  return Number.isNaN(d.getTime()) ? null : d;
}

/** Reads credentials against the declared fields; throws `invalid_input` naming only the FIELD that is missing. */
export function readCreds(
  carrier: string,
  creds: Readonly<Record<string, string>>,
  fields: readonly {
    key: string;
    required: boolean;
    options?: readonly string[];
  }[],
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const f of fields) {
    const v = typeof creds[f.key] === 'string' ? creds[f.key].trim() : '';
    if (!v) {
      if (f.required)
        throw new CarrierError(
          'invalid_input',
          `${carrier}: "${f.key}" is missing from the saved settings.`,
        );
      continue;
    }
    if (f.options && !f.options.includes(v))
      throw new CarrierError(
        'invalid_input',
        `${carrier}: "${f.key}" must be one of ${f.options.join(', ')}.`,
      );
    out[f.key] = v;
  }
  return out;
}

/** Postal codes in India are exactly six digits and do not start with 0. */
export function assertPincode(label: string, value: string): void {
  if (!/^[1-9]\d{5}$/.test(value))
    throw new CarrierError(
      'invalid_input',
      `${label} must be a valid 6-digit PIN code.`,
    );
}
