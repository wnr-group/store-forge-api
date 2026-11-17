import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  anonymous,
  as,
  createTestApp,
  ISSUER,
  otherKeys,
  signToken,
  type TestApp,
} from './support/app.js';
import { createTestDb, migrationsAvailable } from './support/pglite.js';
import { seedWorld, type World } from './support/world.js';

/**
 * Authentication, authorization and tenant isolation through the full HTTP stack and the REAL database schema
 * (RLS, SECURITY DEFINER functions). Only Supabase Auth admin/storage calls are faked.
 */
describe.skipIf(!migrationsAvailable)(
  'authentication, authorization and tenant isolation (e2e)',
  () => {
    let t: TestApp;
    let w: World;

    beforeAll(async () => {
      const db = await createTestDb();
      w = await seedWorld(db);
      t = await createTestApp(db);
    });

    afterAll(async () => {
      await t?.close();
      await t?.db.close();
    });

    describe('Supabase access tokens', () => {
      it('lets public routes through without a token', async () => {
        const res = await anonymous(t).get('/health').expect(200);
        expect(res.body).toMatchObject({
          success: true,
          data: { status: 'ok' },
        });
      });

      it('rejects a missing token with 401 AUTH_REQUIRED in the standard error envelope', async () => {
        const res = await anonymous(t).get('/auth/me').expect(401);
        expect(res.body).toMatchObject({
          success: false,
          error: { code: 'AUTH_REQUIRED' },
          path: '/api/v1/auth/me',
        });
        expect(typeof res.body.timestamp).toBe('string');
      });

      it('rejects garbage, a wrong scheme and a token signed by an untrusted key', async () => {
        const server = t.app.getHttpServer();
        const { default: request } = await import('supertest');
        await request(server)
          .get('/api/v1/auth/me')
          .set('Authorization', 'Bearer not-a-jwt')
          .expect(401);
        await request(server)
          .get('/api/v1/auth/me')
          .set('Authorization', `Basic ${await signToken(w.alice)}`)
          .expect(401);
        const forged = await signToken(w.alice, {
          privateKey: (await otherKeys).privateKey,
        });
        const res = await request(server)
          .get('/api/v1/auth/me')
          .set('Authorization', `Bearer ${forged}`)
          .expect(401);
        expect(res.body.error.code).toBe('INVALID_TOKEN');
      });

      it('rejects an expired token with 401 TOKEN_EXPIRED', async () => {
        const { default: request } = await import('supertest');
        const expired = await signToken(w.alice, { expiresIn: -60 });
        const res = await request(t.app.getHttpServer())
          .get('/api/v1/auth/me')
          .set('Authorization', `Bearer ${expired}`)
          .expect(401);
        expect(res.body.error.code).toBe('TOKEN_EXPIRED');
      });

      it.each([
        ['wrong issuer', { issuer: 'https://evil.example/auth/v1' }],
        ['wrong audience', { audience: 'something-else' }],
        [
          'the anon role (the public anon key is also a valid JWT)',
          { role: 'anon' },
        ],
        ['an anonymous Supabase user', { extra: { is_anonymous: true } }],
      ])('rejects a token with %s', async (_name, options) => {
        const { default: request } = await import('supertest');
        const token = await signToken(w.alice, options);
        await request(t.app.getHttpServer())
          .get('/api/v1/auth/me')
          .set('Authorization', `Bearer ${token}`)
          .expect(401);
      });

      it('rejects a token whose subject is not a UUID', async () => {
        const { default: request } = await import('supertest');
        const token = await signToken('not-a-uuid');
        await request(t.app.getHttpServer())
          .get('/api/v1/auth/me')
          .set('Authorization', `Bearer ${token}`)
          .expect(401);
      });

      it('accepts a valid token and reads roles from the database, not from the token', async () => {
        // A token that LIES about its role must not change anything.
        const { default: request } = await import('supertest');
        const lying = await signToken(w.carol, {
          extra: {
            user_role: 'owner',
            app_metadata: { role: 'platform_admin' },
          },
        });
        const res = await request(t.app.getHttpServer())
          .get('/api/v1/auth/me')
          .set('Authorization', `Bearer ${lying}`)
          .expect(200);
        expect(res.body.data).toMatchObject({
          id: w.carol,
          platformAdminLevel: null,
          memberships: [],
        });
        void ISSUER;
      });

      it('/auth/me returns the memberships and the platform level straight from Postgres', async () => {
        const alice = await (await as(t, w.alice)).get('/auth/me').expect(200);
        expect(alice.body.data.platformAdminLevel).toBeNull();
        expect(alice.body.data.memberships).toHaveLength(1);
        expect(alice.body.data.memberships[0]).toMatchObject({
          organizationId: w.tenantA,
          role: 'owner',
          organizationSlug: 'alpha-shop',
        });

        const admin = await (
          await as(t, w.superAdmin)
        )
          .get('/auth/me')
          .expect(200);
        expect(admin.body.data).toMatchObject({
          platformAdminLevel: 'super_admin',
          memberships: [],
        });
      });

      it('validates change-password input before touching Supabase', async () => {
        const a = await as(t, w.alice);
        const mismatch = await a
          .post('/auth/change-password', {
            currentPassword: 'Old-pass-1',
            password: 'New-pass-12',
            confirmPassword: 'Other-pass-1',
          })
          .expect(400);
        expect(mismatch.body.error.details).toMatchObject({
          confirmPassword: 'Passwords do not match',
        });
        await a
          .post('/auth/change-password', {
            currentPassword: 'Same-pass-1',
            password: 'Same-pass-1',
            confirmPassword: 'Same-pass-1',
          })
          .expect(400);
        const weak = await a
          .post('/auth/change-password', {
            currentPassword: 'x',
            password: 'short',
            confirmPassword: 'short',
          })
          .expect(400);
        expect(weak.body.error.code).toBe('VALIDATION_ERROR');
      });

      it('rate limits password changes (5 per minute per client)', async () => {
        const a = await as(t, w.alice, undefined, { ip: '203.0.113.7' });
        const statuses: number[] = [];
        for (let i = 0; i < 7; i++) {
          statuses.push(
            (
              await a.post('/auth/change-password', {
                currentPassword: 'x',
                password: 'short',
                confirmPassword: 'short',
              })
            ).status,
          );
        }
        expect(statuses).toContain(429);
      });
    });

    describe('organization resolution (tenant isolation)', () => {
      it("defaults to the caller's own organization", async () => {
        const res = await (
          await as(t, w.alice)
        )
          .get('/organizations/current')
          .expect(200);
        expect(res.body.data.organization).toMatchObject({
          id: w.tenantA,
          slug: 'alpha-shop',
        });
        expect(res.body.data.role).toBe('owner');
        expect(res.body.data.store).toMatchObject({ id: w.storeA });
      });

      it('refuses an X-Organization-Id the caller does not belong to (never silently switches)', async () => {
        const res = await (
          await as(t, w.alice, w.tenantB)
        )
          .get('/organizations/current')
          .expect(403);
        expect(res.body.error.code).toBe('ORGANIZATION_ACCESS_DENIED');
        await (await as(t, w.alice, w.tenantB)).get('/products').expect(403);
        await (await as(t, w.alice, w.tenantB)).get('/customers').expect(403);
      });

      it('refuses a malformed organization id', async () => {
        await (await as(t, w.alice, 'not-a-uuid')).get('/products').expect(403);
      });

      it('answers 404 NO_WORKSPACE for a user who belongs to no organization', async () => {
        const res = await (await as(t, w.carol)).get('/products').expect(404);
        expect(res.body.error.code).toBe('NO_WORKSPACE');
      });

      it('gives a user with no organization an empty list, and Platform Admins no tenant data', async () => {
        const list = await (
          await as(t, w.carol)
        )
          .get('/organizations')
          .expect(200);
        expect(list.body.data).toEqual([]);
        const res = await (
          await as(t, w.superAdmin)
        )
          .get('/products')
          .expect(404);
        expect(res.body.error.code).toBe('NO_WORKSPACE');
      });

      it('a disabled membership grants nothing', async () => {
        const res = await (
          await as(t, w.members.disabled)
        )
          .get('/products')
          .expect(404);
        expect(res.body.error.code).toBe('NO_WORKSPACE');
        const me = await (
          await as(t, w.members.disabled)
        )
          .get('/organizations')
          .expect(200);
        expect(me.body.data).toEqual([]);
      });

      it('a suspended organization is invisible to its members', async () => {
        await t.db.asOwner((pg) =>
          pg.query("update tenants set status = 'suspended' where id = $1", [
            w.tenantB,
          ]),
        );
        try {
          const res = await (await as(t, w.bob)).get('/products').expect(404);
          expect(res.body.error.code).toBe('NO_WORKSPACE');
        } finally {
          await t.db.asOwner((pg) =>
            pg.query("update tenants set status = 'active' where id = $1", [
              w.tenantB,
            ]),
          );
        }
        await (await as(t, w.bob)).get('/products').expect(200);
      });
    });

    describe('cross-tenant data access', () => {
      let productB: string;
      let categoryB: string;
      let customerB: string;

      beforeAll(async () => {
        const bob = await as(t, w.bob);
        productB = (
          await bob
            .post('/products', { name: 'Bob Tee', price: '10.00' })
            .expect(201)
        ).body.data.id;
        categoryB = (
          await bob.post('/categories', { name: 'Bob Things' }).expect(201)
        ).body.data.id;
        customerB = (
          await bob
            .post('/customers', {
              fullName: 'Bob Customer',
              email: 'bobs@customer.test',
            })
            .expect(201)
        ).body.data.id;
      });

      it("never lists another organization's rows", async () => {
        const alice = await as(t, w.alice);
        expect((await alice.get('/products').expect(200)).body.data).toEqual(
          [],
        );
        expect((await alice.get('/categories').expect(200)).body.data).toEqual(
          [],
        );
        expect((await alice.get('/customers').expect(200)).body.data).toEqual(
          [],
        );
        const bob = await as(t, w.bob);
        expect((await bob.get('/products').expect(200)).body.data).toHaveLength(
          1,
        );
      });

      it("answers 404 (not 403, not the row) for another organization's ids on every read and write", async () => {
        const alice = await as(t, w.alice);
        await alice.get(`/products/${productB}`).expect(404);
        await alice
          .patch(`/products/${productB}`, { name: 'Hijacked' })
          .expect(404);
        await alice.delete(`/products/${productB}`).expect(404);
        await alice.post(`/products/${productB}/duplicate`).expect(404);
        await alice.get(`/categories/${categoryB}`).expect(404);
        await alice
          .patch(`/categories/${categoryB}`, { name: 'Hijacked' })
          .expect(404);
        await alice.delete(`/categories/${categoryB}`).expect(404);
        await alice.get(`/customers/${customerB}`).expect(404);
        await alice
          .patch(`/customers/${customerB}`, { fullName: 'Hijacked' })
          .expect(404);
        await alice.delete(`/customers/${customerB}`).expect(404);

        const intact = await (
          await as(t, w.bob)
        )
          .get(`/products/${productB}`)
          .expect(200);
        expect(intact.body.data.name).toBe('Bob Tee');
      });

      it('bulk operations silently ignore ids from another organization', async () => {
        const alice = await as(t, w.alice);
        const del = await alice
          .post('/products/bulk-delete', { ids: [productB] })
          .expect(200);
        expect(del.body.data.count).toBe(0);
        const status = await alice
          .post('/products/bulk-status', { ids: [productB], status: 'active' })
          .expect(200);
        expect(status.body.data.count).toBe(0);
        await (await as(t, w.bob)).get(`/products/${productB}`).expect(200);
      });

      it("cannot attach another organization's category or product to your own data", async () => {
        const alice = await as(t, w.alice);
        const p = await alice
          .post('/products', {
            name: 'Mine',
            price: '5.00',
            categoryId: categoryB,
          })
          .expect(400);
        expect(p.body.error.code).toBe('CATEGORY_NOT_FOUND');
        const c = await alice
          .post('/collections', { name: 'Mine', productIds: [productB] })
          .expect(400);
        expect(c.body.error.code).toBe('PRODUCT_NOT_FOUND');
        const cat = await alice
          .post('/categories', { name: 'Child', parentId: categoryB })
          .expect(400);
        expect(cat.body.error.code).toBe('PARENT_NOT_FOUND');
      });

      it("cannot adjust another organization's stock", async () => {
        const alice = await as(t, w.alice);
        await alice
          .post('/inventory/adjustments', {
            productId: productB,
            mode: 'add',
            value: 5,
            reason: 'restock',
          })
          .expect(404);
      });

      it("cannot read another organization's team", async () => {
        const res = await (
          await as(t, w.alice, w.tenantB)
        )
          .get('/team/members')
          .expect(403);
        expect(res.body.error.code).toBe('ORGANIZATION_ACCESS_DENIED');
      });
    });

    describe('roles and module permissions', () => {
      it('a read-only member can read but not write', async () => {
        const reader = await as(t, w.members.reader, w.tenantA);
        await reader.get('/products').expect(200);
        await reader.get('/customers').expect(200);
        await reader.get('/analytics').expect(200);
        const res = await reader
          .post('/products', { name: 'X', price: '1.00' })
          .expect(403);
        expect(res.body.error.code).toBe('FORBIDDEN');
        await reader
          .post('/customers', { fullName: 'X', email: 'x@y.test' })
          .expect(403);
        await reader.patch('/store', { name: 'Hacked store' }).expect(403);
        await reader
          .post('/inventory/adjustments', {
            productId: w.storeA,
            mode: 'add',
            value: 1,
            reason: 'restock',
          })
          .expect(403);
      });

      it('a member with no module access gets 403 on those modules, but still sees the dashboard shell', async () => {
        const nothing = await as(t, w.members.nothing, w.tenantA);
        await nothing.get('/products').expect(403);
        await nothing.get('/categories').expect(403);
        await nothing.get('/inventory').expect(403);
        await nothing.get('/customers').expect(403);
        await nothing.get('/analytics').expect(403);
        const current = await nothing.get('/organizations/current').expect(200);
        expect(current.body.data.access).toEqual([
          { module: 'settings', label: 'Store settings', level: 'read' },
        ]);
        await nothing.get('/store').expect(200);
      });

      it('members can never manage the team; only the Owner can', async () => {
        for (const who of ['reader', 'writer'] as const) {
          const m = await as(t, w.members[who], w.tenantA);
          await m.get('/team/members').expect(403);
          await m
            .post('/team/members', {
              fullName: 'New Person',
              email: 'new@x.test',
              password: 'Passw0rd-1',
              permissions: {
                products: 'write',
                orders: 'read',
                customers: 'write',
                settings: 'write',
              },
            })
            .expect(403);
        }
        const owner = await (
          await as(t, w.alice)
        )
          .get('/team/members')
          .expect(200);
        expect(owner.body.data.map((m: { role: string }) => m.role)).toContain(
          'owner',
        );
      });

      it('a member with settings write may edit the store; read may not', async () => {
        const writer = await as(t, w.members.writer, w.tenantA);
        const res = await writer
          .patch('/store', { description: 'Edited by a member' })
          .expect(200);
        expect(res.body.data.description).toBe('Edited by a member');
      });

      it('everything under /platform needs a Platform Admin, never a tenant Owner', async () => {
        const alice = await as(t, w.alice);
        for (const url of [
          '/platform/me',
          '/platform/overview',
          '/platform/organizations',
          '/platform/admins',
          '/platform/settings',
          '/platform/audit-logs',
          '/platform/usage',
        ]) {
          const res = await alice.get(url).expect(403);
          expect(res.body.error.code).toBe('FORBIDDEN');
        }
        await alice.post('/platform/organizations', {}).expect(403);
        await (await as(t, w.carol)).get('/platform/overview').expect(403);
      });

      it('a platform admin sees organizations but still cannot reach tenant data', async () => {
        const admin = await as(t, w.admin);
        const list = await admin.get('/platform/organizations').expect(200);
        expect(list.body.meta.total).toBe(2);
        await admin.get('/products').expect(404);
      });
    });

    describe('input validation and response envelope', () => {
      it('rejects unknown fields and bad types with the standard validation envelope', async () => {
        const alice = await as(t, w.alice);
        const res = await alice
          .post('/categories', {
            name: 'Ok',
            role: 'owner',
            tenantId: w.tenantB,
          })
          .expect(400);
        expect(res.body).toMatchObject({
          success: false,
          error: { code: 'VALIDATION_ERROR' },
        });
        expect(Array.isArray(res.body.error.details)).toBe(true);
        expect(JSON.stringify(res.body.error.details)).toContain('tenantId');
      });

      it('rejects malformed ids with 400', async () => {
        await (await as(t, w.alice)).get('/products/not-a-uuid').expect(400);
      });

      it('does not leak internals on unknown routes or server errors', async () => {
        const res = await (await as(t, w.alice)).get('/nope').expect(404);
        expect(res.body.success).toBe(false);
        expect(JSON.stringify(res.body)).not.toMatch(
          /stack|node_modules|postgres/i,
        );
      });

      it('wraps successes in { success, message, data } and adds meta only for collections', async () => {
        const alice = await as(t, w.alice);
        const single = await alice.get('/store').expect(200);
        expect(single.body).toMatchObject({
          success: true,
          message: expect.any(String),
          data: { id: w.storeA },
        });
        expect(single.body.meta).toBeUndefined();
        const list = await alice.get('/products?page=1&limit=5').expect(200);
        expect(list.body.meta).toEqual({
          page: 1,
          limit: 5,
          total: 0,
          totalPages: 1,
        });
        const plain = await alice.get('/categories').expect(200);
        expect(plain.body.meta).toBeUndefined();
      });
    });
  },
);
