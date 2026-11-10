import { timingSafeEqual } from 'node:crypto';
import type { Request } from 'express';

/** The header the trusted frontend server sends with the shared AUTH_BFF_SECRET. */
export const INTERNAL_AUTH_HEADER = 'x-internal-auth';

/** True when the request carries the shared secret of the trusted server-side caller (compared in constant time). */
export function isTrustedServer(
  req: Request,
  secret: string | undefined,
): boolean {
  if (!secret) return false;
  const sent = req.headers[INTERNAL_AUTH_HEADER];
  const value = Array.isArray(sent) ? sent[0] : sent;
  if (typeof value !== 'string') return false;
  const a = Buffer.from(value);
  const b = Buffer.from(secret);
  return a.length === b.length && timingSafeEqual(a, b);
}

/**
 * The address login rate limiting is keyed on. A request from the trusted frontend server names the visitor in
 * `X-Forwarded-For` (the first hop); everyone else is identified by the socket / proxy-resolved address, so a client
 * cannot choose its own bucket by sending that header.
 */
export function clientAddress(req: Request, trusted: boolean): string {
  if (trusted) {
    const forwarded = req.headers['x-forwarded-for'];
    const first = (Array.isArray(forwarded) ? forwarded[0] : forwarded)
      ?.split(',')[0]
      ?.trim();
    if (first) return first;
  }
  return req.ip || req.socket.remoteAddress || 'unknown';
}

/** Browser origins this API accepts for cookie-session requests: the configured allowlist, and its own origin (Swagger UI). */
export function isAllowedOrigin(
  origin: string,
  allowlist: readonly string[],
  req: Request,
): boolean {
  if (allowlist.includes(origin)) return true;
  const host = req.headers.host;
  return !!host && origin === `${req.protocol}://${host}`;
}
