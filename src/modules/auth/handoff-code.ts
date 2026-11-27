import { createHmac, timingSafeEqual } from 'node:crypto';

/** How long a handoff code can be exchanged for. The link is followed straight away, so a minute is plenty. */
export const HANDOFF_TTL_SECONDS = 60;

/** A store host label (`{slug}-{public id}`), the same shape the `stores.subdomain` check allows. */
export const HOST_LABEL = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/;

type Payload = { t: string; a: string; e: number };

const b64 = (input: Buffer | string) =>
  Buffer.from(input).toString('base64url');

/** A key of its own for this one purpose, so the shared server secret is never used as a signing key directly. */
const key = (secret: string) =>
  createHmac('sha256', secret).update('storeforge:session-handoff:v1').digest();

const sign = (secret: string, body: string) =>
  createHmac('sha256', key(secret)).update(body).digest();

/**
 * A handoff code lets a signed-in person open ONE store host already signed in (session cookies are host-only, so a new host
 * has none). It carries a single-use Supabase login token, the host it is for and an expiry, signed so none of them can be
 * changed. Single use is enforced by Supabase itself (the token is consumed when it is exchanged).
 */
export function sealHandoff(
  secret: string,
  tokenHash: string,
  audience: string,
  nowSeconds: number,
): string {
  const payload: Payload = {
    t: tokenHash,
    a: audience,
    e: nowSeconds + HANDOFF_TTL_SECONDS,
  };
  const body = b64(JSON.stringify(payload));
  return `${body}.${b64(sign(secret, body))}`;
}

/** The login token inside a code, or null when the code is forged, expired or made for a different host. */
export function openHandoff(
  secret: string,
  code: string,
  audience: string,
  nowSeconds: number,
): string | null {
  const [body, mac, ...rest] = code.split('.');
  if (!body || !mac || rest.length) return null;
  const expected = sign(secret, body);
  const given = Buffer.from(mac, 'base64url');
  if (given.length !== expected.length || !timingSafeEqual(given, expected))
    return null;
  let payload: Partial<Payload>;
  try {
    payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
  } catch {
    return null;
  }
  if (
    typeof payload.t !== 'string' ||
    payload.a !== audience ||
    typeof payload.e !== 'number' ||
    payload.e < nowSeconds
  )
    return null;
  return payload.t;
}
