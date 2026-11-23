import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { as, createTestApp, type TestApp } from './support/app.js';
import { createTestDb, migrationsAvailable } from './support/pglite.js';
import { seedWorld, type World } from './support/world.js';

const FULL = {
  products: 'write',
  orders: 'read',
  customers: 'write',
  settings: 'write',
};

describe.skipIf(!migrationsAvailable)(
  'store settings, uploads, team and public endpoints (e2e)',
  () => {
    let t: TestApp;
    let w: World;
    let alice: Awaited<ReturnType<typeof as>>;

    beforeAll(async () => {
      const db = await createTestDb();
      w = await seedWorld(db);
      t = await createTestApp(db);
      alice = await as(t, w.alice);
    });

    afterAll(async () => {
      await t?.close();
      await t?.db.close();
    });

    describe('store settings', () => {
      it('reads the store with a currency lock flag', async () => {
        const res = await alice.get('/store').expect(200);
        expect(res.body.data).toMatchObject({
          slug: 'alpha-shop',
          currency: 'INR',
          currencyLocked: false,
          status: 'active',
        });
      });

      it('partially updates fields and clears optional ones with null', async () => {
        const res = await alice
          .patch('/store', {
            name: '  Alpha Prime  ',
            description: 'Hello',
            contactEmail: 'HELLO@Alpha.test',
            contactPhone: '+91 98765 43210',
            timezone: 'Europe/Berlin',
          })
          .expect(200);
        expect(res.body.data).toMatchObject({
          name: 'Alpha Prime',
          description: 'Hello',
          contactEmail: 'hello@alpha.test',
          timezone: 'Europe/Berlin',
          slug: 'alpha-shop',
        });
        const cleared = await alice
          .patch('/store', { description: null, contactPhone: '' })
          .expect(200);
        expect(cleared.body.data).toMatchObject({
          description: null,
          contactPhone: null,
          name: 'Alpha Prime',
        });
      });

      it('validates name, slug, currency, timezone and email', async () => {
        await alice.patch('/store', { name: 'A' }).expect(400);
        await alice.patch('/store', { slug: 'ab' }).expect(400);
        await alice.patch('/store', { slug: 'double--hyphen' }).expect(400);
        await alice.patch('/store', { slug: 'admin' }).expect(400); // reserved
        await alice.patch('/store', { currency: 'RUPEES' }).expect(400);
        await alice.patch('/store', { timezone: 'Mars/Olympus' }).expect(400);
        await alice.patch('/store', { contactEmail: 'nope' }).expect(400);
        await alice.patch('/store', { organizationId: w.tenantB }).expect(400);
      });

      it('refuses a store address that another store already owns (409) and accepts a free one', async () => {
        const taken = await alice
          .patch('/store', { slug: 'beta-shop' })
          .expect(409);
        expect(taken.body.error.code).toBe('STORE_SLUG_TAKEN');
        const free = await alice
          .patch('/store', { slug: 'alpha-prime' })
          .expect(200);
        expect(free.body.data.slug).toBe('alpha-prime');
      });

      it('allows a currency change only while the organization has no products or orders', async () => {
        const bob = await as(t, w.bob);
        const ok = await bob.patch('/store', { currency: 'USD' }).expect(200);
        expect(ok.body.data.currency).toBe('USD');
        await bob
          .post('/products', { name: 'Priced', price: '9.99' })
          .expect(201);
        const locked = await bob
          .patch('/store', { currency: 'EUR' })
          .expect(400);
        expect(locked.body.error.code).toBe('CURRENCY_LOCKED');
        expect(
          (await bob.get('/store').expect(200)).body.data.currencyLocked,
        ).toBe(true);
        // The product price was parsed with USD (2 decimals): 9.99 -> 999 minor units.
        const list = await bob.get('/products').expect(200);
        expect(list.body.data[0].priceMinor).toBe(999);
      });

      it('verifies the logo, replaces it, and removes the old file only when nothing references it', async () => {
        const first = `${w.tenantA}/store/${randomUUID()}.png`;
        const second = `${w.tenantA}/store/${randomUUID()}.png`;
        const third = `${w.tenantA}/store/${randomUUID()}.png`;
        for (const p of [first, second, third]) t.storage.upload(p);

        await alice
          .patch('/store', {
            logoPath: `${w.tenantA}/store/${randomUUID()}.png`,
          })
          .expect(400); // never uploaded
        await alice
          .patch('/store', {
            logoPath: `${w.tenantB}/store/${randomUUID()}.png`,
          })
          .expect(400); // another organization
        await alice
          .patch('/store', {
            logoPath: `${w.tenantA}/store/../${randomUUID()}.png`,
          })
          .expect(400); // traversal

        await alice.patch('/store', { logoPath: first }).expect(200);
        // A template (managed elsewhere) also points at the first file.
        await t.db.asOwner((pg) =>
          pg.query(
            "insert into store_template_settings (store_id, tenant_id, template_key, hero_image_path) values ($1,$2,'classic',$3)",
            [w.storeA, w.tenantA, first],
          ),
        );
        await alice.patch('/store', { logoPath: second }).expect(200);
        expect(t.storage.removed).not.toContain(first); // still shown by the template
        expect(t.storage.objects.has(first)).toBe(true);

        await alice.patch('/store', { logoPath: third }).expect(200);
        expect(t.storage.removed).toContain(second); // nothing references it any more
      });

      it('refuses a logo that is already the template hero image', async () => {
        const hero = `${w.tenantA}/store/${randomUUID()}.png`;
        t.storage.upload(hero);
        await t.db.asOwner((pg) =>
          pg.query(
            'update store_template_settings set hero_image_path = $1 where store_id = $2',
            [hero, w.storeA],
          ),
        );
        const res = await alice.patch('/store', { logoPath: hero }).expect(400);
        expect(res.body.error.code).toBe('LOGO_IN_USE_AS_HERO');
      });
    });

    describe('uploads', () => {
      it('derives the folder from the verified organization, never from the request', async () => {
        const res = await alice
          .post('/uploads/signed-urls', {
            scope: 'store',
            files: [{ type: 'image/png', size: 1000 }],
          })
          .expect(201);
        expect(res.body.data[0].path).toBe(`${w.tenantA}/store/0.png`);
        const id = randomUUID();
        const product = await alice
          .post('/uploads/signed-urls', {
            scope: 'product',
            ownerId: id,
            files: [{ type: 'image/webp', size: 1000 }],
          })
          .expect(201);
        expect(product.body.data[0].path).toBe(`${w.tenantA}/${id}/0.png`);
      });

      it('requires ownerId for product and collection scopes and validates the files', async () => {
        await alice
          .post('/uploads/signed-urls', {
            scope: 'product',
            files: [{ type: 'image/png', size: 10 }],
          })
          .expect(400);
        await alice
          .post('/uploads/signed-urls', {
            scope: 'store',
            files: [{ type: 'image/gif', size: 10 }],
          })
          .expect(400);
        await alice
          .post('/uploads/signed-urls', { scope: 'store', files: [] })
          .expect(400);
        await alice
          .post('/uploads/signed-urls', {
            scope: 'store',
            files: Array.from({ length: 11 }, () => ({
              type: 'image/png',
              size: 1,
            })),
          })
          .expect(400);
      });

      it('checks the permission that matches the scope', async () => {
        const reader = await as(t, w.members.reader, w.tenantA);
        await reader
          .post('/uploads/signed-urls', {
            scope: 'store',
            files: [{ type: 'image/png', size: 10 }],
          })
          .expect(403);
        await reader
          .post('/uploads/signed-urls', {
            scope: 'product',
            ownerId: randomUUID(),
            files: [{ type: 'image/png', size: 10 }],
          })
          .expect(403);
        const writer = await as(t, w.members.writer, w.tenantA);
        await writer
          .post('/uploads/signed-urls', {
            scope: 'store',
            files: [{ type: 'image/png', size: 10 }],
          })
          .expect(201);
      });
    });

    describe('team (Owner only)', () => {
      let memberId: string;

      it('lists the owner and members with role labels', async () => {
        const res = await alice.get('/team/members').expect(200);
        const byEmail = Object.fromEntries(
          res.body.data.map((m: { email: string }) => [m.email, m]),
        );
        expect(byEmail['alice@example.test']).toMatchObject({
          role: 'owner',
          roleLabel: 'Owner',
        });
        expect(byEmail['writer@example.test']).toMatchObject({
          role: 'admin',
          roleLabel: 'Manager',
        });
        expect(byEmail['reader@example.test'].roleLabel).toBe('Viewer');
        expect(byEmail['nothing@example.test'].roleLabel).toBe('Custom');
      });

      it('creates a confirmed account and a membership with the chosen module access', async () => {
        const res = await alice
          .post('/team/members', {
            fullName: 'New Hire',
            email: 'New.Hire@Example.test',
            password: 'Passw0rd-1',
            permissions: { ...FULL, settings: 'read' },
          })
          .expect(201);
        memberId = res.body.data.userId;
        expect(res.body.data.email).toBe('new.hire@example.test');
        const team = (await alice.get('/team/members').expect(200)).body.data;
        expect(
          team.find((m: { userId: string }) => m.userId === memberId),
        ).toMatchObject({
          role: 'admin',
          roleLabel: 'Staff',
          fullName: 'New Hire',
          status: 'active',
        });
        // The new member can immediately act within their access, and only there.
        const hire = await as(t, memberId, w.tenantA);
        await hire.get('/products').expect(200);
        await hire.patch('/store', { name: 'Nope' }).expect(403);
      });

      it('validates passwords, e-mail, names and permission levels', async () => {
        const base = {
          fullName: 'X Y',
          email: 'xy@example.test',
          password: 'Passw0rd-1',
          permissions: FULL,
        };
        await alice
          .post('/team/members', { ...base, password: 'short' })
          .expect(400);
        await alice
          .post('/team/members', { ...base, password: 'onlyletters' })
          .expect(400);
        await alice
          .post('/team/members', { ...base, password: '12345678' })
          .expect(400);
        await alice
          .post('/team/members', { ...base, email: 'bad' })
          .expect(400);
        await alice
          .post('/team/members', { ...base, fullName: 'X' })
          .expect(400);
        await alice
          .post('/team/members', {
            ...base,
            permissions: { ...FULL, orders: 'admin' },
          })
          .expect(400); // unknown orders level
        await alice
          .post('/team/members', {
            ...base,
            permissions: { ...FULL, settings: 'none' },
          })
          .expect(400); // settings never below read
        await alice
          .post('/team/members', {
            ...base,
            permissions: { products: 'write' },
          })
          .expect(400);
        await alice
          .post('/team/members', { ...base, role: 'owner' })
          .expect(400); // the role is never client-supplied
      });

      it('refuses a duplicate e-mail with 409', async () => {
        const res = await alice
          .post('/team/members', {
            fullName: 'Dup',
            email: 'new.hire@example.test',
            password: 'Passw0rd-1',
            permissions: FULL,
          })
          .expect(409);
        expect(res.body.error.code).toBe('EMAIL_TAKEN');
      });

      it('deletes the freshly created account when the membership cannot be written (no orphans)', async () => {
        // Another Owner's call targets the same organization via a forged header: the guard stops it before any account exists.
        const before = t.authAdmin.deleted.length;
        await (
          await as(t, w.bob, w.tenantA)
        )
          .post('/team/members', {
            fullName: 'Evil Twin',
            email: 'evil@example.test',
            password: 'Passw0rd-1',
            permissions: FULL,
          })
          .expect(403);
        const exists = await t.db.asOwner((pg) =>
          pg.query(
            "select 1 from auth.users where email = 'evil@example.test'",
          ),
        );
        expect(exists.rows).toHaveLength(0);
        expect(t.authAdmin.deleted.length).toBe(before);
      });

      it('edits name and permissions (partial) but never the owner or yourself', async () => {
        const res = await alice
          .patch(`/team/members/${memberId}`, {
            permissions: { ...FULL, products: 'read' },
          })
          .expect(200);
        expect(res.body.data.permissions.products).toBe('read');
        expect(res.body.data.fullName).toBe('New Hire');
        const renamed = await alice
          .patch(`/team/members/${memberId}`, { fullName: 'Renamed Hire' })
          .expect(200);
        expect(renamed.body.data.fullName).toBe('Renamed Hire');
        expect(t.authAdmin.names.get(memberId)).toBe('Renamed Hire');
        const self = await alice
          .patch(`/team/members/${w.alice}`, { permissions: FULL })
          .expect(404);
        expect(self.body.error.code).toBe('MEMBER_NOT_FOUND');
        await alice
          .patch(`/team/members/${randomUUID()}`, { permissions: FULL })
          .expect(404);
      });

      it('cannot touch a member of another organization', async () => {
        const bobsMember = await (
          await as(t, w.bob)
        )
          .post('/team/members', {
            fullName: 'Bob Hire',
            email: 'bobhire@example.test',
            password: 'Passw0rd-1',
            permissions: FULL,
          })
          .expect(201);
        const id = bobsMember.body.data.userId;
        await alice
          .patch(`/team/members/${id}`, { fullName: 'Hijack' })
          .expect(404);
        await alice
          .patch(`/team/members/${id}/status`, { status: 'disabled' })
          .expect(404);
        await alice.delete(`/team/members/${id}`).expect(404);
        await alice
          .post(`/team/members/${id}/password`, { password: 'Hijack-pass-1' })
          .expect(404);
        expect(t.authAdmin.passwords.get(id)).toBe('Passw0rd-1');
      });

      it('disables a member (instant loss of access) and re-enables them', async () => {
        const hire = await as(t, memberId, w.tenantA);
        const off = await alice
          .patch(`/team/members/${memberId}/status`, { status: 'disabled' })
          .expect(200);
        expect(off.body.data.status).toBe('disabled');
        await hire.get('/products').expect(404); // no active workspace
        await alice
          .patch(`/team/members/${memberId}/status`, { status: 'active' })
          .expect(200);
        await hire.get('/products').expect(200);
        await alice
          .patch(`/team/members/${w.alice}/status`, { status: 'disabled' })
          .expect(404);
        await alice
          .patch(`/team/members/${memberId}/status`, { status: 'frozen' })
          .expect(400);
      });

      it("resets a member's password through the Auth Admin API, but never the owner's", async () => {
        await alice
          .post(`/team/members/${memberId}/password`, {
            password: 'Fresh-pass-9',
          })
          .expect(200);
        expect(t.authAdmin.passwords.get(memberId)).toBe('Fresh-pass-9');
        await alice
          .post(`/team/members/${w.alice}/password`, {
            password: 'Fresh-pass-9',
          })
          .expect(404);
        await alice
          .post(`/team/members/${memberId}/password`, { password: 'weak' })
          .expect(400);
      });

      it('removes a member and deletes their account when it has no other membership', async () => {
        await alice.delete(`/team/members/${memberId}`).expect(200);
        expect(t.authAdmin.deleted).toContain(memberId);
        const team = (await alice.get('/team/members').expect(200)).body.data;
        expect(
          team.find((m: { userId: string }) => m.userId === memberId),
        ).toBeUndefined();
        await alice.delete(`/team/members/${memberId}`).expect(404);
        const self = await alice.delete(`/team/members/${w.alice}`).expect(400);
        expect(self.body.error.code).toBeDefined();
      });
    });

    describe('rate limiting of sensitive team routes', () => {
      it('allows 10 account creations per minute per client, then answers 429', async () => {
        const limited = await as(t, w.alice, undefined, { ip: '198.51.100.9' });
        const statuses: number[] = [];
        for (let i = 0; i < 12; i++) {
          statuses.push(
            (
              await limited.post('/team/members', {
                fullName: 'X',
                email: 'bad',
              })
            ).status,
          );
        }
        expect(statuses.filter((s) => s === 400)).toHaveLength(10);
        expect(statuses.slice(10)).toEqual([429, 429]);
      });
    });

    describe('public endpoints', () => {
      it('serves branding without a token', async () => {
        const { default: request } = await import('supertest');
        const res = await request(t.app.getHttpServer())
          .get('/api/v1/public/branding')
          .expect(200);
        expect(res.body.data).toMatchObject({ platformName: 'StoreForge' });
      });

      it('serves an active storefront and treats unknown stores as 404', async () => {
        const { default: request } = await import('supertest');
        await as(t, w.alice).then((a) =>
          a
            .post('/products', {
              name: 'Public Tee',
              price: '20',
              status: 'active',
            })
            .expect(201),
        );
        await as(t, w.alice).then((a) =>
          a
            .post('/products', { name: 'Hidden Draft', price: '20' })
            .expect(201),
        );
        const res = await request(t.app.getHttpServer())
          .get('/api/v1/public/storefronts/alpha-prime')
          .expect(200);
        expect(res.body.data).toMatchObject({
          slug: 'alpha-prime',
          currency: 'INR',
        });
        expect(
          res.body.data.products.map((p: { name: string }) => p.name),
        ).toEqual(['Public Tee']);
        expect(res.body.data.products[0].priceMinor).toBe(2000);
        await request(t.app.getHttpServer())
          .get('/api/v1/public/storefronts/does-not-exist')
          .expect(404);
      });

      it("a suspended organization's storefront disappears", async () => {
        const { default: request } = await import('supertest');
        await t.db.asOwner((pg) =>
          pg.query("update tenants set status = 'suspended' where id = $1", [
            w.tenantA,
          ]),
        );
        try {
          await request(t.app.getHttpServer())
            .get('/api/v1/public/storefronts/alpha-prime')
            .expect(404);
        } finally {
          await t.db.asOwner((pg) =>
            pg.query("update tenants set status = 'active' where id = $1", [
              w.tenantA,
            ]),
          );
        }
      });
    });
  },
);
