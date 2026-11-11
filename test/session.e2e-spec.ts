import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  readSessionCookie,
  sessionCookieName,
} from '../src/modules/auth/session-cookies.js';
import { createTestApp, signToken, type TestApp } from './support/app.js';
import { FakeSupabaseAuth } from './support/fake-supabase-auth.js';
import { createTestDb, migrationsAvailable } from './support/pglite.js';
import { TEST_ENV } from './support/test-env.js';
import { seedWorld, type World } from './support/world.js';

const ORIGIN = 'http://localhost:3000';
const COOKIE = sessionCookieName(TEST_ENV.SUPABASE_URL);
const PASSWORDS = {
  alice: 'Alice-pass-1',
  superAdmin: 'Super-pass-1',
  carol: 'Carol-pass-1',
  reader: 'Reader-pass-1',
};

/** A tiny browser cookie jar: keeps what Set-Cookie says, drops what it expires, sends the rest back. */
class Jar {
  readonly cookies = new Map<string, { value: string; attrs: string }>();
  absorb(res: { headers: Record<string, unknown> }) {
    for (const line of (res.headers['set-cookie'] as string[] | undefined) ??
      []) {
      const [pair, ...attrs] = line.split('; ');
      const eq = pair.indexOf('=');
      const name = pair.slice(0, eq);
      const value = pair.slice(eq + 1);
      if (value === '' || /max-age=0/i.test(attrs.join('; ')))
        this.cookies.delete(name);
      else this.cookies.set(name, { value, attrs: attrs.join('; ') });
    }
  }
  header() {
    return [...this.cookies].map(([n, c]) => `${n}=${c.value}`).join('; ');
  }
}

const setCookies = (res: { headers: Record<string, unknown> }) =>
  (res.headers['set-cookie'] as string[] | undefined) ?? [];

describe.skipIf(!migrationsAvailable)(
  'cookie session: login, restore, refresh, logout (e2e)',
  () => {
    let t: TestApp;
    let w: World;
    const fake = new FakeSupabaseAuth();
    const http = () => t.app.getHttpServer();

    // Every call is a different visitor unless the test pins an address (login attempts are rate limited per address).
    let visitor = 0;
    const login = (
      email: string,
      password: string,
      headers: Record<string, string> = { Origin: ORIGIN },
    ) =>
      request(http())
        .post('/api/v1/auth/login')
        .set({
          'X-Forwarded-For': `198.18.${Math.floor(++visitor / 250)}.${(visitor % 250) + 1}`,
          ...headers,
        })
        .send({ email, password });

    beforeAll(async () => {
      await fake.start();
      const db = await createTestDb();
      w = await seedWorld(db);
      fake.addUser({
        id: w.alice,
        email: 'alice@example.test',
        password: PASSWORDS.alice,
      });
      fake.addUser({
        id: w.superAdmin,
        email: 'super@example.test',
        password: PASSWORDS.superAdmin,
      });
      fake.addUser({
        id: w.carol,
        email: 'carol@example.test',
        password: PASSWORDS.carol,
      });
      fake.addUser({
        id: w.members.reader,
        email: 'reader@example.test',
        password: PASSWORDS.reader,
      });
      t = await createTestApp(db);
    });

    afterAll(async () => {
      await t?.close();
      await t?.db.close();
      await fake.stop();
    });

    describe('login', () => {
      it('with includeProfile false still sets the session cookies but skips the profile lookup', async () => {
        const res = await request(http())
          .post('/api/v1/auth/login')
          .set({ 'X-Forwarded-For': '198.19.0.1', Origin: ORIGIN })
          .send({
            email: 'alice@example.test',
            password: PASSWORDS.alice,
            includeProfile: false,
          })
          .expect(200);
        expect(res.body.data).toEqual({
          id: w.alice,
          email: 'alice@example.test',
          expiresAt: expect.any(Number),
        });
        expect(setCookies(res).some((c) => c.startsWith(`${COOKIE}=`))).toBe(
          true,
        );
      });

      it('signs an existing account in, sets HttpOnly cookies and returns the safe profile with roles and organizations', async () => {
        const res = await login('Alice@Example.test ', PASSWORDS.alice).expect(
          200,
        );
        expect(res.body).toMatchObject({
          success: true,
          message: 'Signed in successfully',
        });
        expect(res.body.data).toMatchObject({
          id: w.alice,
          email: 'alice@example.test',
          fullName: 'Alice Owner',
          platformAdminLevel: null,
        });
        expect(res.body.data.memberships).toEqual([
          expect.objectContaining({
            organizationId: w.tenantA,
            organizationSlug: 'alpha-shop',
            role: 'owner',
          }),
        ]);
        expect(typeof res.body.data.expiresAt).toBe('number');

        // The tokens are in cookies only, never in the body.
        const body = JSON.stringify(res.body);
        expect(body).not.toMatch(/access_token|refresh_token|eyJ/);

        const cookies = setCookies(res);
        const session = cookies.find((c) => c.startsWith(`${COOKIE}=`))!;
        expect(session).toMatch(/HttpOnly/i);
        expect(session).toMatch(/SameSite=Lax/i);
        expect(session).toMatch(/Path=\//);
        expect(session).not.toMatch(/Domain=/i); // host-only: never widened to sibling subdomains
        expect(session).not.toMatch(/Secure/i); // local development over http
        const marker = cookies.find((c) => c.startsWith('sf_signed_in='))!;
        expect(marker).toMatch(/^sf_signed_in=1/);
        expect(marker).not.toMatch(/HttpOnly/i); // the marker carries no secret
        expect(res.headers['cache-control']).toBe('no-store');
      });

      it('works for a Platform Admin and for a user without an organization, granting nothing extra', async () => {
        const admin = (
          await login('super@example.test', PASSWORDS.superAdmin).expect(200)
        ).body.data;
        expect(admin).toMatchObject({
          id: w.superAdmin,
          platformAdminLevel: 'super_admin',
          memberships: [],
        });
        const nobody = (
          await login('carol@example.test', PASSWORDS.carol).expect(200)
        ).body.data;
        expect(nobody).toMatchObject({
          id: w.carol,
          platformAdminLevel: null,
          memberships: [],
        });
      });

      it('rejects wrong credentials with the existing message, sets no cookie and creates nothing', async () => {
        const before = await t.db.asOwner((pg) =>
          pg.query(
            'select (select count(*) from auth.users)::int u, (select count(*) from tenants)::int t, (select count(*) from memberships)::int m',
          ),
        );
        for (const [email, password] of [
          ['alice@example.test', 'wrong-password-1'],
          ['nobody@example.test', 'whatever-pass-1'], // unknown e-mail: identical answer, no sign-up
        ]) {
          const res = await login(email, password).expect(401);
          expect(res.body).toMatchObject({
            success: false,
            message: 'Incorrect email or password.',
            error: { code: 'INVALID_CREDENTIALS' },
          });
          expect(setCookies(res)).toEqual([]);
        }
        const after = await t.db.asOwner((pg) =>
          pg.query(
            'select (select count(*) from auth.users)::int u, (select count(*) from tenants)::int t, (select count(*) from memberships)::int m',
          ),
        );
        expect(after.rows[0]).toEqual(before.rows[0]);
      });

      it('validates input like the existing form: trimmed lower-case e-mail, non-empty password up to 72 characters', async () => {
        await login('not-an-email', 'x').expect(400);
        await login('alice@example.test', '').expect(400);
        await login('alice@example.test', 'x'.repeat(73)).expect(400);
        await request(http())
          .post('/api/v1/auth/login')
          .set({ Origin: ORIGIN })
          .send({ email: 'a@b.co' })
          .expect(400);
        await request(http())
          .post('/api/v1/auth/login')
          .set({ Origin: ORIGIN })
          .send({ email: 'a@b.co', password: 'x', role: 'owner' })
          .expect(400);
      });

      it('has no sign-up, registration, verification or recovery endpoint', async () => {
        for (const path of [
          'register',
          'signup',
          'sign-up',
          'verify-email',
          'forgot-password',
          'reset-password',
          'callback',
        ])
          await request(http())
            .post(`/api/v1/auth/${path}`)
            .set({ Origin: ORIGIN })
            .send({ email: 'a@b.co', password: 'x' })
            .expect(404);
      });
    });

    describe('session restoration (browser refresh)', () => {
      it('the cookie alone restores the identity, the roles and the tenant access, exactly as the Bearer token would', async () => {
        const jar = new Jar();
        jar.absorb(
          await login('alice@example.test', PASSWORDS.alice).expect(200),
        );
        const api = (path: string) =>
          request(http()).get(`/api/v1${path}`).set('Cookie', jar.header());

        const me = (await api('/auth/me').expect(200)).body.data;
        expect(me).toMatchObject({ id: w.alice, fullName: 'Alice Owner' });
        expect(me.memberships[0].role).toBe('owner');
        const session = (await api('/auth/session').expect(200)).body.data;
        expect(session).toMatchObject({
          user: { id: w.alice, email: 'alice@example.test' },
        });
        expect(session.expiresAt).toBeGreaterThan(
          Math.floor(Date.now() / 1000),
        );

        // Tenant users reach their own data and nothing else; the Platform Admin area stays closed to them.
        await api('/products').expect(200);
        await api('/platform/overview').expect(403);
        await api('/team/members').expect(200); // Owner
        await request(http())
          .get('/api/v1/products')
          .set('Cookie', jar.header())
          .set('X-Organization-Id', w.tenantB)
          .expect(403);
      });

      it('a Platform Admin session reaches /platform but not tenant data', async () => {
        const jar = new Jar();
        jar.absorb(
          await login('super@example.test', PASSWORDS.superAdmin).expect(200),
        );
        expect(
          (
            await request(http())
              .get('/api/v1/platform/me')
              .set('Cookie', jar.header())
              .expect(200)
          ).body.data.level,
        ).toBe('super_admin');
        await request(http())
          .get('/api/v1/products')
          .set('Cookie', jar.header())
          .expect(404);
      });

      it('a member session carries only the module access the Owner granted', async () => {
        const jar = new Jar();
        jar.absorb(
          await login('reader@example.test', PASSWORDS.reader).expect(200),
        );
        await request(http())
          .get('/api/v1/products')
          .set('Cookie', jar.header())
          .expect(200);
        await request(http())
          .get('/api/v1/team/members')
          .set('Cookie', jar.header())
          .expect(403);
      });

      it('without a cookie the same routes answer 401, and an invalid Bearer header is never rescued by a cookie', async () => {
        await request(http()).get('/api/v1/auth/me').expect(401);
        const jar = new Jar();
        jar.absorb(
          await login('alice@example.test', PASSWORDS.alice).expect(200),
        );
        const res = await request(http())
          .get('/api/v1/auth/me')
          .set('Cookie', jar.header())
          .set('Authorization', 'Bearer not-a-jwt')
          .expect(401);
        expect(res.body.error.code).toBe('INVALID_TOKEN');
      });

      it('a tampered or truncated cookie is a signed-out visitor, not an error page', async () => {
        const jar = new Jar();
        jar.absorb(
          await login('alice@example.test', PASSWORDS.alice).expect(200),
        );
        const value = jar.cookies.get(COOKIE)!.value;
        for (const bad of ['base64-@@@', value.slice(0, 20), 'x']) {
          const res = await request(http())
            .get('/api/v1/auth/me')
            .set('Cookie', `${COOKIE}=${bad}`);
          expect([401]).toContain(res.status);
        }
      });
    });

    describe('refresh with rotation', () => {
      /** Replaces the access token in a cookie by an expired one (the user was away longer than the token lifetime). */
      async function expire(jar: Jar) {
        const stored = (await readSessionCookie(jar.header(), COOKIE))!;
        const expired = await signToken(w.alice, {
          email: 'alice@example.test',
          expiresIn: -120,
        });
        const json = JSON.stringify({
          access_token: expired,
          refresh_token: stored.refreshToken,
          expires_at: Math.floor(Date.now() / 1000) - 60,
          token_type: 'bearer',
          user: { id: w.alice, email: 'alice@example.test' },
        });
        jar.cookies.set(COOKIE, {
          value: `base64-${Buffer.from(json).toString('base64url')}`,
          attrs: '',
        });
        for (const name of jar.cookies.keys())
          if (name.startsWith(`${COOKIE}.`)) jar.cookies.delete(name);
      }

      it('an expired access token is reported as TOKEN_EXPIRED; refreshing issues a new session and rotates the refresh token', async () => {
        const jar = new Jar();
        jar.absorb(
          await login('alice@example.test', PASSWORDS.alice).expect(200),
        );
        await expire(jar);
        const staleCookie = jar.header();

        const expired = await request(http())
          .get('/api/v1/auth/me')
          .set('Cookie', staleCookie)
          .expect(401);
        expect(expired.body.error.code).toBe('TOKEN_EXPIRED');

        const refreshed = await request(http())
          .post('/api/v1/auth/refresh')
          .set('Origin', ORIGIN)
          .set('Cookie', staleCookie)
          .expect(200);
        expect(refreshed.body.data.user).toMatchObject({ id: w.alice });
        expect(
          setCookies(refreshed).some(
            (c) => c.startsWith(`${COOKIE}=`) && /HttpOnly/i.test(c),
          ),
        ).toBe(true);
        jar.absorb(refreshed);
        await request(http())
          .get('/api/v1/auth/me')
          .set('Cookie', jar.header())
          .expect(200);

        // Rotation: the refresh token that was just used is dead. Replaying it ends the session.
        const replay = await request(http())
          .post('/api/v1/auth/refresh')
          .set('Origin', ORIGIN)
          .set('Cookie', staleCookie)
          .expect(401);
        expect(replay.body.error.code).toBe('SESSION_EXPIRED');
        expect(
          setCookies(replay).some(
            (c) => c.startsWith(`${COOKIE}=;`) || /Max-Age=0/i.test(c),
          ),
        ).toBe(true);
      });

      it('with no usable refresh token it clears the cookies and answers 401', async () => {
        for (const cookie of [
          undefined,
          `${COOKIE}=garbage`,
          `${COOKIE}=base64-${Buffer.from('{"access_token":"x"}').toString('base64url')}`,
        ]) {
          const req = request(http())
            .post('/api/v1/auth/refresh')
            .set('Origin', ORIGIN);
          const res = await (cookie ? req.set('Cookie', cookie) : req).expect(
            401,
          );
          expect(res.body.error.code).toBe('SESSION_EXPIRED');
          expect(
            setCookies(res).some(
              (c) => /Max-Age=0/i.test(c) && c.startsWith('sf_signed_in='),
            ),
          ).toBe(true);
        }
      });
    });

    describe('logout', () => {
      it('revokes the session at Supabase and clears every cookie; the old refresh token no longer works', async () => {
        const jar = new Jar();
        jar.absorb(
          await login('alice@example.test', PASSWORDS.alice).expect(200),
        );
        const cookieBefore = jar.header();
        const logoutsBefore = fake.logouts;

        const res = await request(http())
          .post('/api/v1/auth/logout')
          .set('Origin', ORIGIN)
          .set('Cookie', cookieBefore)
          .expect(200);
        expect(res.body.data).toEqual({ signedOut: true });
        expect(fake.logouts).toBe(logoutsBefore + 1);
        jar.absorb(res);
        expect(jar.cookies.size).toBe(0);

        await request(http())
          .get('/api/v1/auth/me')
          .set('Cookie', jar.header())
          .expect(401);
        const stale = await request(http())
          .post('/api/v1/auth/refresh')
          .set('Origin', ORIGIN)
          .set('Cookie', cookieBefore)
          .expect(401);
        expect(stale.body.error.code).toBe('SESSION_EXPIRED');
      });

      it('is safe when already signed out', async () => {
        const res = await request(http())
          .post('/api/v1/auth/logout')
          .set('Origin', ORIGIN)
          .expect(200);
        expect(res.body.data.signedOut).toBe(true);
        expect(
          setCookies(res).some(
            (c) => c.startsWith('sf_signed_in=') && /Max-Age=0/i.test(c),
          ),
        ).toBe(true);
      });
    });

    describe('CSRF protection and CORS', () => {
      const BFF = { 'X-Internal-Auth': TEST_ENV.AUTH_BFF_SECRET };

      it('refuses sign-in from an origin that is not allowed, and without any origin or secret', async () => {
        const evil = await login('alice@example.test', PASSWORDS.alice, {
          Origin: 'http://evil.test',
        }).expect(403);
        expect(evil.body.error.code).toBe('CSRF_ORIGIN_NOT_ALLOWED');
        const none = await login(
          'alice@example.test',
          PASSWORDS.alice,
          {},
        ).expect(403);
        expect(none.body.error.code).toBe('CSRF_ORIGIN_REQUIRED');
        await login('alice@example.test', PASSWORDS.alice, {
          Origin: 'null',
        }).expect(403);
        expect(setCookies(evil)).toEqual([]);
      });

      it('accepts the trusted frontend server (shared secret, no Origin) and refuses a wrong secret', async () => {
        await login('alice@example.test', PASSWORDS.alice, BFF).expect(200);
        await login('alice@example.test', PASSWORDS.alice, {
          'X-Internal-Auth': 'wrong-secret-wrong-secret-wrong-secret',
        }).expect(403);
        // The secret does not excuse a hostile browser origin.
        await login('alice@example.test', PASSWORDS.alice, {
          ...BFF,
          Origin: 'http://evil.test',
        }).expect(403);
      });

      it('protects state-changing requests that ride on the cookie, but not reads or Bearer calls', async () => {
        const jar = new Jar();
        jar.absorb(
          await login('alice@example.test', PASSWORDS.alice).expect(200),
        );
        const post = (origin?: string) => {
          const r = request(http())
            .post('/api/v1/categories')
            .set('Cookie', jar.header());
          return (origin ? r.set('Origin', origin) : r).send({
            name: `Cat ${Math.random()}`,
          });
        };
        expect(
          (await post('http://evil.test').expect(403)).body.error.code,
        ).toBe('CSRF_ORIGIN_NOT_ALLOWED');
        expect((await post().expect(403)).body.error.code).toBe(
          'CSRF_ORIGIN_REQUIRED',
        );
        await post(ORIGIN).expect(201);
        // A read from any origin is harmless (and CORS keeps foreign pages from reading the answer).
        await request(http())
          .get('/api/v1/categories')
          .set('Cookie', jar.header())
          .set('Origin', 'http://evil.test')
          .expect(200);
        // A Bearer token is never attached by a browser on its own, so it needs no origin.
        const bearer = await signToken(w.alice);
        await request(http())
          .post('/api/v1/categories')
          .set('Authorization', `Bearer ${bearer}`)
          .send({ name: 'Bearer cat' })
          .expect(201);
      });

      it('answers CORS preflights for the frontend origin only, with credentials', async () => {
        const ok = await request(http())
          .options('/api/v1/auth/login')
          .set('Origin', ORIGIN)
          .set('Access-Control-Request-Method', 'POST');
        expect(ok.headers['access-control-allow-origin']).toBe(ORIGIN);
        expect(ok.headers['access-control-allow-credentials']).toBe('true');
        const denied = await request(http())
          .options('/api/v1/auth/login')
          .set('Origin', 'http://evil.test')
          .set('Access-Control-Request-Method', 'POST');
        expect(denied.headers['access-control-allow-origin']).toBeUndefined();
      });
    });

    describe('login rate limiting', () => {
      const BFF_FROM = (ip: string) => ({
        'X-Internal-Auth': TEST_ENV.AUTH_BFF_SECRET,
        'X-Forwarded-For': ip,
      });

      it('counts attempts before the password is checked: the 9th attempt in the window is refused and never reaches Supabase', async () => {
        const headers = BFF_FROM('203.0.113.50');
        const statuses: number[] = [];
        const grantsBefore = fake.passwordGrants;
        for (let i = 0; i < 9; i++)
          statuses.push(
            (await login('limited@example.test', 'wrong-password-1', headers))
              .status,
          );
        expect(statuses.slice(0, 8)).toEqual(Array(8).fill(401));
        expect(statuses[8]).toBe(429);
        expect(fake.passwordGrants - grantsBefore).toBe(8); // the refused attempt did not hit the password check
        const refused = await login(
          'limited@example.test',
          PASSWORDS.alice,
          headers,
        );
        expect(refused.body.error.code).toBe('LOGIN_RATE_LIMITED');
        expect(refused.body.message).toMatch(
          /Too many requests\. Please wait about/,
        );
      });

      it('another visitor (another address) is not affected', async () => {
        await login(
          'alice@example.test',
          PASSWORDS.alice,
          BFF_FROM('198.51.100.77'),
        ).expect(200);
      });
    });
  },
);
