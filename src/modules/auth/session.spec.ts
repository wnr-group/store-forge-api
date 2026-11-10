import type { Request } from 'express';
import {
  evaluateCsrf,
  type CsrfInput,
} from '../../common/guards/csrf.guard.js';
import {
  clientAddress,
  isAllowedOrigin,
  isTrustedServer,
} from './request-trust.js';
import {
  CookieJar,
  readSessionCookie,
  sessionCookieName,
} from './session-cookies.js';

const NAME = 'sb-proj-auth-token';
const SECRET = 's'.repeat(32);

const req = (headers: Record<string, string>, extra: Partial<Request> = {}) =>
  ({
    headers,
    ip: '10.0.0.9',
    protocol: 'https',
    socket: { remoteAddress: '10.0.0.8' },
    ...extra,
  }) as unknown as Request;

const csrf = (over: Partial<CsrfInput> = {}) =>
  evaluateCsrf({
    method: 'POST',
    protectedRoute: false,
    hasBearer: false,
    hasSessionCookie: true,
    origin: undefined,
    originAllowed: false,
    trustedServer: false,
    ...over,
  });

describe('CSRF rules', () => {
  it('never blocks safe methods', () => {
    for (const method of ['GET', 'HEAD', 'OPTIONS'])
      expect(
        csrf({ method, protectedRoute: true, origin: 'http://evil.test' }),
      ).toBe('allow');
  });

  it('lets requests through that have no cookie session to ride on', () => {
    expect(csrf({ hasSessionCookie: false })).toBe('allow');
    expect(csrf({ hasBearer: true })).toBe('allow'); // browsers never attach Authorization by themselves
  });

  it('requires an allowed origin when a state-changing request carries the cookie session', () => {
    expect(csrf({ origin: 'http://app.test', originAllowed: true })).toBe(
      'allow',
    );
    expect(csrf({ origin: 'http://evil.test', originAllowed: false })).toBe(
      'wrong-origin',
    );
    expect(csrf({})).toBe('origin-required');
  });

  it('protects the sign-in / sign-out / refresh routes even without a cookie', () => {
    expect(csrf({ protectedRoute: true, hasSessionCookie: false })).toBe(
      'origin-required',
    );
    expect(
      csrf({ protectedRoute: true, hasSessionCookie: false, hasBearer: true }),
    ).toBe('origin-required');
    expect(
      csrf({
        protectedRoute: true,
        hasSessionCookie: false,
        origin: 'http://evil.test',
      }),
    ).toBe('wrong-origin');
  });

  it('accepts the trusted frontend server without an origin, but never together with a hostile one', () => {
    expect(csrf({ protectedRoute: true, trustedServer: true })).toBe('allow');
    expect(
      csrf({
        protectedRoute: true,
        trustedServer: true,
        origin: 'http://evil.test',
      }),
    ).toBe('wrong-origin');
  });
});

describe('request trust', () => {
  it('recognises the shared secret in constant time and rejects anything else', () => {
    expect(isTrustedServer(req({ 'x-internal-auth': SECRET }), SECRET)).toBe(
      true,
    );
    expect(
      isTrustedServer(req({ 'x-internal-auth': 'x'.repeat(32) }), SECRET),
    ).toBe(false);
    expect(
      isTrustedServer(req({ 'x-internal-auth': SECRET.slice(1) }), SECRET),
    ).toBe(false);
    expect(isTrustedServer(req({}), SECRET)).toBe(false);
    expect(isTrustedServer(req({ 'x-internal-auth': SECRET }), undefined)).toBe(
      false,
    ); // no secret configured: nobody is trusted
  });

  it('takes the visitor address from X-Forwarded-For ONLY for the trusted server', () => {
    const r = req({ 'x-forwarded-for': '203.0.113.5, 10.1.1.1' });
    expect(clientAddress(r, true)).toBe('203.0.113.5');
    expect(clientAddress(r, false)).toBe('10.0.0.9'); // an ordinary client cannot choose its own bucket
    expect(clientAddress(req({}), true)).toBe('10.0.0.9');
  });

  it("accepts listed origins and the API's own origin (Swagger UI) only", () => {
    const r = req({ host: 'api.example.com' });
    const allow = ['https://app.example.com'];
    expect(isAllowedOrigin('https://app.example.com', allow, r)).toBe(true);
    expect(isAllowedOrigin('https://api.example.com', allow, r)).toBe(true);
    for (const bad of [
      'http://api.example.com',
      'https://app.example.com.evil.test',
      'null',
      'https://evil.test',
    ])
      expect(isAllowedOrigin(bad, allow, r), bad).toBe(false);
  });
});

describe('session cookie', () => {
  it('derives the supabase-js cookie name from the project URL', () => {
    expect(sessionCookieName('https://abcdefgh.supabase.co')).toBe(
      'sb-abcdefgh-auth-token',
    );
  });

  const encode = (o: object) =>
    `base64-${Buffer.from(JSON.stringify(o)).toString('base64url')}`;

  it('reads a session from one cookie or from chunks, and refuses garbage', async () => {
    const session = {
      access_token: 'AT',
      refresh_token: 'RT',
      expires_at: 1234,
    };
    const value = encode(session);
    expect(await readSessionCookie(`${NAME}=${value}`, NAME)).toEqual({
      accessToken: 'AT',
      refreshToken: 'RT',
      expiresAt: 1234,
    });
    const half = Math.ceil(value.length / 2);
    expect(
      await readSessionCookie(
        `${NAME}.0=${value.slice(0, half)}; ${NAME}.1=${value.slice(half)}`,
        NAME,
      ),
    ).toMatchObject({ accessToken: 'AT' });
    expect(
      await readSessionCookie(`${NAME}=${JSON.stringify(session)}`, NAME),
    ).toMatchObject({ accessToken: 'AT' }); // legacy plain JSON
    for (const bad of [
      undefined,
      '',
      'other=1',
      `${NAME}=base64-%%%`,
      `${NAME}=${encode({ nope: 1 })}`,
      `${NAME}=${encode({ access_token: '' })}`,
    ])
      expect(await readSessionCookie(bad, NAME), String(bad)).toBeNull();
  });

  it('hardens what supabase-js writes: HttpOnly, Lax, host-only, Secure in production, plus a token-free marker', () => {
    const jar = new CookieJar(true, NAME);
    jar.setAll([
      {
        name: NAME,
        value: 'base64-xyz',
        options: {
          maxAge: 400,
          domain: '.example.com',
          httpOnly: false,
          sameSite: 'none',
          path: '/app',
        },
      },
    ]);
    const [session, marker] = jar.headers;
    expect(session).toMatch(/^sb-proj-auth-token=base64-xyz/);
    expect(session).toMatch(/HttpOnly/i);
    expect(session).toMatch(/SameSite=Lax/i);
    expect(session).toMatch(/Secure/i);
    expect(session).toMatch(/Path=\//);
    expect(session).not.toMatch(/Domain=/i);
    expect(session).not.toMatch(/SameSite=None/i);
    expect(marker).toMatch(/^sf_signed_in=1/);
    expect(marker).not.toMatch(/HttpOnly/i);
    expect(marker).not.toContain('base64-xyz');
  });

  it('clears every chunk and the marker on sign-out', () => {
    const jar = new CookieJar(false, NAME);
    jar.clearSession([
      { name: `${NAME}.0`, value: 'a' },
      { name: `${NAME}.1`, value: 'b' },
      { name: 'theme', value: 'dark' }, // unrelated cookies are left alone
    ]);
    const lines = jar.headers.join('\n');
    expect(lines).toMatch(/sb-proj-auth-token\.0=; .*Max-Age=0/);
    expect(lines).toMatch(/sb-proj-auth-token\.1=; .*Max-Age=0/);
    expect(lines).toMatch(/sf_signed_in=; .*Max-Age=0/);
    expect(lines).not.toMatch(/theme/);
  });
});
