import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { anonymous, as, createTestApp, type TestApp } from './support/app.js';
import {
  createPlatformAdmin,
  createTestDb,
  migrationsAvailable,
} from './support/pglite.js';
import { seedWorld, type World } from './support/world.js';

type Client = Awaited<ReturnType<typeof as>>;

describe.skipIf(!migrationsAvailable)(
  'platform tenant management (e2e)',
  () => {
    let t: TestApp;
    let w: World;
    let sup: Client;
    let support: Client;
    let carol: Client; // a signed-in account that belongs to no organization
    let alice: Client; // owner of alpha-shop
    let tenantId: string;
    let ownerId: string;
    let publicId: string;

    const createOrg = (overrides: Record<string, unknown> = {}) =>
      sup.post('/platform/organizations', {
        companyName: 'Delta Traders',
        storeName: 'Delta Store',
        storeSlug: 'delta-store',
        storeDescription: 'Things',
        contactPhone: '+44 20 7946 0958',
        address: '1 High Street',
        ownerName: 'Dana Owner',
        ownerEmail: 'dana@delta.test',
        ownerPassword: 'Passw0rd-1',
        ...overrides,
      });

    const search = async (q: string, extra = '') =>
      (
        await sup
          .get(
            `/platform/organizations?search=${encodeURIComponent(q)}${extra}`,
          )
          .expect(200)
      ).body.data as { id: string }[];

    beforeAll(async () => {
      const db = await createTestDb();
      w = await seedWorld(db);
      const supportId = await createPlatformAdmin(
        db,
        'support@example.test',
        'support_admin',
      );
      t = await createTestApp(db);
      sup = await as(t, w.superAdmin);
      support = await as(t, supportId);
      carol = await as(t, w.carol);
      alice = await as(t, w.alice);

      const created = (await createOrg().expect(201)).body.data;
      tenantId = created.tenantId;
      ownerId = created.ownerId;
      publicId = (
        await sup.get(`/platform/organizations/${tenantId}`).expect(200)
      ).body.data.company.publicId;
    });

    afterAll(async () => {
      await t?.close();
      await t?.db.close();
    });

    describe('search and filters', () => {
      it('finds a tenant by name, slug, owner e-mail, tenant id, public id and store domain', async () => {
        for (const q of [
          'Delta Traders',
          'delta-store',
          'DANA@delta.test',
          tenantId,
          publicId,
          `delta-store-${publicId}`,
        ]) {
          const ids = (await search(q)).map((r) => r.id);
          expect(ids, `search for ${q}`).toEqual([tenantId]);
        }
      });

      it('returns nothing for an unknown term and treats LIKE wildcards literally', async () => {
        expect(await search('no-such-tenant')).toHaveLength(0);
        expect(await search('%')).toHaveLength(0);
        expect(await search('_')).toHaveLength(0);
      });

      it('combines search with the status filter', async () => {
        await sup
          .patch(`/platform/organizations/${tenantId}/status`, {
            status: 'suspended',
          })
          .expect(200);
        expect(
          await search('dana@delta.test', '&status=suspended'),
        ).toHaveLength(1);
        expect(await search('dana@delta.test', '&status=active')).toHaveLength(
          0,
        );
        await sup
          .patch(`/platform/organizations/${tenantId}/status`, {
            status: 'active',
          })
          .expect(200);
      });
    });

    describe('suspension', () => {
      it('cuts off the members and the public storefront, keeps every record, and is reversible', async () => {
        const slug = 'alpha-shop';
        const before = await anonymous(t).get(`/public/storefronts/${slug}`);
        expect(before.status).toBe(200);
        const owner = await as(t, ownerId);
        await owner
          .post('/products', { name: 'Kept Item', price: '5' })
          .expect(201);

        await sup
          .patch(`/platform/organizations/${w.tenantA}/status`, {
            status: 'suspended',
          })
          .expect(200);
        await anonymous(t).get(`/public/storefronts/${slug}`).expect(404);
        await alice.get('/products').expect(404);
        await alice
          .post('/products', { name: 'Blocked', price: '1' })
          .expect(404);
        expect(
          (await alice.get('/organizations').expect(200)).body.data.some(
            (o: { id: string }) => o.id === w.tenantA,
          ),
        ).toBe(false);

        // Nothing was deleted.
        const kept = await t.db.asOwner((pg) =>
          pg.query(
            'select count(*)::int as n from stores where tenant_id = $1',
            [w.tenantA],
          ),
        );
        expect(kept.rows[0]).toEqual({ n: 1 });

        await sup
          .patch(`/platform/organizations/${w.tenantA}/status`, {
            status: 'active',
          })
          .expect(200);
        await anonymous(t).get(`/public/storefronts/${slug}`).expect(200);
        await alice.get('/products').expect(200);
      });
    });

    describe('activity history', () => {
      it('shows one organization its own history, to roles that may read tenants', async () => {
        const res = await support
          .get(`/platform/organizations/${tenantId}/activity`)
          .expect(200);
        const actions = res.body.data.map((e: { action: string }) => e.action);
        expect(actions).toEqual(
          expect.arrayContaining([
            'organization.created',
            'organization.suspended',
            'organization.reactivated',
          ]),
        );
        expect(
          res.body.data.every(
            (e: { organizationId: string }) => e.organizationId === tenantId,
          ),
        ).toBe(true);
      });

      it('keeps the history of a deleted organization, with a deletion entry', async () => {
        await sup
          .patch(`/platform/organizations/${tenantId}`, {
            companyName: 'Delta Renamed',
          })
          .expect(200);
        await sup.delete(`/platform/organizations/${tenantId}`).expect(200);
        const res = await sup
          .get(`/platform/organizations/${tenantId}/activity`)
          .expect(200);
        const deleted = res.body.data.find(
          (e: { action: string }) => e.action === 'organization.deleted',
        );
        expect(deleted).toBeTruthy();
        expect(deleted.organizationName).toBe('Delta Renamed');
        expect(deleted.previousData).toMatchObject({
          slug: 'delta-store',
          ownerEmail: 'dana@delta.test',
        });
      });

      it('does not log a deletion that was refused', async () => {
        const missing = '00000000-0000-4000-8000-000000000001';
        await sup.delete(`/platform/organizations/${missing}`).expect(404);
        const res = await sup
          .get(`/platform/organizations/${missing}/activity`)
          .expect(200);
        expect(res.body.data).toHaveLength(0);
      });
    });

    describe('tenant creation is admin-controlled', () => {
      const body = {
        companyName: 'Sneaky Co',
        storeName: 'Sneaky',
        storeSlug: 'sneaky-co',
        ownerName: 'Sam',
        ownerEmail: 'sam@sneaky.test',
        ownerPassword: 'Passw0rd-1',
        fullName: 'Sam',
        email: 'sam@sneaky.test',
        password: 'Passw0rd-1',
      };

      it('offers no public sign-up or store-creation route', async () => {
        const anon = anonymous(t);
        for (const path of [
          '/auth/register',
          '/auth/signup',
          '/auth/sign-up',
          '/register',
          '/signup',
          '/organizations',
          '/stores',
          '/public/organizations',
          '/public/register',
          '/public/signup',
        ]) {
          const res = await anon.post(path, body);
          expect(res.status, `POST ${path}`).toBeGreaterThanOrEqual(400);
          expect(res.status, `POST ${path}`).not.toBe(500);
        }
        expect((await anon.post('/platform/organizations', body)).status).toBe(
          401,
        );
      });

      it('refuses tenant users on the platform creation route and creates nothing', async () => {
        await alice.post('/platform/organizations', body).expect(403);
        await carol.post('/platform/organizations', body).expect(403);
        await support.post('/platform/organizations', body).expect(403);
        const rows = await t.db.asOwner((pg) =>
          pg.query(
            "select count(*)::int as n from tenants where slug = 'sneaky-co'",
          ),
        );
        expect(rows.rows[0]).toEqual({ n: 0 });
      });

      it('a signed-in user with no organization cannot create one through the tenant API', async () => {
        for (const path of ['/organizations', '/stores']) {
          const res = await carol.post(path, {
            name: 'Mine',
            companyName: 'Mine',
            slug: 'mine-store',
          });
          expect(res.status, `POST ${path}`).toBeGreaterThanOrEqual(400);
          expect(res.status).not.toBe(500);
        }
      });
    });
  },
);
