import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { anonymous, as, createTestApp, type TestApp } from './support/app.js';
import { createTestDb, migrationsAvailable } from './support/pglite.js';
import { seedWorld, type World } from './support/world.js';

describe.skipIf(!migrationsAvailable)(
  'profile, password, readiness and remaining happy paths (e2e)',
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

    describe('readiness', () => {
      it('GET /health/ready proves the database answers through the RLS-guarded path', async () => {
        const res = await anonymous(t).get('/health/ready').expect(200);
        expect(res.body.data).toEqual({
          status: 'ok',
          service: 'store-forge-api',
          database: 'up',
        });
      });
    });

    describe('own profile', () => {
      it('reads the profile created by the database trigger for the Supabase user', async () => {
        const res = await alice.get('/users/me').expect(200);
        expect(res.body.data).toEqual({
          id: w.alice,
          email: `${w.alice}@example.test`,
          fullName: 'Alice Owner',
        });
      });

      it("updates only the caller's own name and mirrors it to Supabase Auth", async () => {
        const res = await alice
          .patch('/users/me', { fullName: '  Alice Renamed ' })
          .expect(200);
        expect(res.body.data.fullName).toBe('Alice Renamed');
        expect(t.authAdmin.names.get(w.alice)).toBe('Alice Renamed');
        expect(
          (await alice.get('/users/me').expect(200)).body.data.fullName,
        ).toBe('Alice Renamed');
        // Nobody else's profile moved.
        expect(
          (await (await as(t, w.bob)).get('/users/me').expect(200)).body.data
            .fullName,
        ).toBe('Bob Owner');
      });

      it("cannot change someone else's profile by smuggling an id, and validates the name", async () => {
        await alice
          .patch('/users/me', { fullName: 'Mallory', id: w.bob })
          .expect(400);
        await alice.patch('/users/me', { fullName: 'A' }).expect(400);
        await alice
          .patch('/users/me', { fullName: 'x'.repeat(121) })
          .expect(400);
        await alice.patch('/users/me', {}).expect(400);
        expect(
          (await (await as(t, w.bob)).get('/users/me').expect(200)).body.data
            .fullName,
        ).toBe('Bob Owner');
      });
    });

    describe('password change', () => {
      const email = (id: string) => `${id}@example.test`;

      it('re-verifies the current password with Supabase, then sets the new one', async () => {
        t.authClient.currentPasswords.set(email(w.alice), 'Old-pass-1');
        t.authClient.calls.length = 0;
        const res = await alice
          .post('/auth/change-password', {
            currentPassword: 'Old-pass-1',
            password: 'New-pass-12',
            confirmPassword: 'New-pass-12',
          })
          .expect(200);
        expect(res.body).toMatchObject({ success: true, data: null });
        expect(t.authClient.calls).toEqual([
          `signIn:${email(w.alice)}`,
          'update:New-pass-12',
          'signOut',
        ]);
      });

      it('refuses a wrong current password and changes nothing', async () => {
        t.authClient.currentPasswords.set(email(w.bob), 'Real-pass-1');
        t.authClient.calls.length = 0;
        const bob = await as(t, w.bob);
        const res = await bob
          .post('/auth/change-password', {
            currentPassword: 'Guess-pass-1',
            password: 'New-pass-12',
            confirmPassword: 'New-pass-12',
          })
          .expect(400);
        expect(res.body.error).toMatchObject({
          code: 'CURRENT_PASSWORD_INCORRECT',
          details: { currentPassword: 'Incorrect password' },
        });
        expect(t.authClient.calls.some((c) => c.startsWith('update:'))).toBe(
          false,
        );
      });

      it("passes Supabase's own rate limit through as 429", async () => {
        t.authClient.failSignIn = { status: 429 };
        try {
          const res = await (
            await as(t, w.carol)
          )
            .post('/auth/change-password', {
              currentPassword: 'Old-pass-1',
              password: 'New-pass-12',
              confirmPassword: 'New-pass-12',
            })
            .expect(429);
          expect(res.body.error.code).toBe('RATE_LIMITED');
        } finally {
          t.authClient.failSignIn = null;
        }
      });
    });

    describe('remaining update and read paths', () => {
      it('renames and re-parents a category (PATCH /categories/:id)', async () => {
        const parent = (
          await alice.post('/categories', { name: 'Parent' }).expect(201)
        ).body.data;
        const child = (
          await alice.post('/categories', { name: 'Child' }).expect(201)
        ).body.data;
        const res = await alice
          .patch(`/categories/${child.id}`, {
            name: 'Child Renamed',
            description: 'About',
            parentId: parent.id,
          })
          .expect(200);
        expect(res.body.data).toMatchObject({
          name: 'Child Renamed',
          slug: 'child',
          description: 'About',
          parentId: parent.id,
          parentName: 'Parent',
        });
        const cleared = await alice
          .patch(`/categories/${child.id}`, {
            parentId: null,
            description: null,
          })
          .expect(200);
        expect(cleared.body.data).toMatchObject({
          parentId: null,
          description: null,
          name: 'Child Renamed',
        });
        const noop = await alice
          .patch(`/categories/${child.id}`, {})
          .expect(200);
        expect(noop.body.data.name).toBe('Child Renamed');
      });

      it('reads one collection with its ordered product ids (GET /collections/:id)', async () => {
        const a = (
          await alice
            .post('/products', { name: 'First', price: '1' })
            .expect(201)
        ).body.data.id;
        const b = (
          await alice
            .post('/products', { name: 'Second', price: '1' })
            .expect(201)
        ).body.data.id;
        const created = (
          await alice
            .post('/collections', { name: 'Ordered', productIds: [b, a] })
            .expect(201)
        ).body.data;
        const res = await alice.get(`/collections/${created.id}`).expect(200);
        expect(res.body.data).toMatchObject({
          id: created.id,
          name: 'Ordered',
          productCount: 2,
          productIds: [b, a],
        });
        await alice
          .get('/collections/00000000-0000-4000-8000-000000000000')
          .expect(404);
      });

      it('updates a customer (PATCH /customers/:id), including an e-mail change that clashes', async () => {
        const one = (
          await alice
            .post('/customers', { fullName: 'One', email: 'one@example.test' })
            .expect(201)
        ).body.data;
        await alice
          .post('/customers', { fullName: 'Two', email: 'two@example.test' })
          .expect(201);
        const res = await alice
          .patch(`/customers/${one.id}`, {
            fullName: 'One Updated',
            phone: '+1 415 555 0100',
            notes: 'VIP',
          })
          .expect(200);
        expect(res.body.data).toMatchObject({
          fullName: 'One Updated',
          email: 'one@example.test',
          phone: '+1 415 555 0100',
          notes: 'VIP',
        });
        const cleared = await alice
          .patch(`/customers/${one.id}`, { phone: null, notes: '' })
          .expect(200);
        expect(cleared.body.data).toMatchObject({ phone: null, notes: null });
        const clash = await alice
          .patch(`/customers/${one.id}`, { email: 'TWO@example.test' })
          .expect(409);
        expect(clash.body.error.code).toBe('CUSTOMER_EMAIL_TAKEN');
        await alice
          .patch(`/customers/${one.id}`, { email: 'nope' })
          .expect(400);
      });
    });
  },
);
