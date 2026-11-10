import { drizzle } from 'drizzle-orm/pglite';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  assertSeedAllowed,
  DEMO_PLATFORM_ADMIN,
  DEMO_USERS,
  ensureDemoUsers,
  seedDemoData,
  verifyDemoData,
  type SeedSummary,
} from '../scripts/lib/demo-seed.js';
import { as, createTestApp, type TestApp } from './support/app.js';
import { createTestDb, migrationsAvailable } from './support/pglite.js';

describe('demo seed guards', () => {
  const env = { DIRECT_URL: 'postgres://x', SEED_DEMO_DATA: 'true' };

  it('refuses production, a missing confirmation and a missing owner connection', () => {
    expect(() => assertSeedAllowed({ ...env, NODE_ENV: 'production' })).toThrow(
      /production/,
    );
    expect(() =>
      assertSeedAllowed({ ...env, VERCEL_ENV: 'production' }),
    ).toThrow(/production/);
    expect(() => assertSeedAllowed({ DIRECT_URL: 'postgres://x' })).toThrow(
      /SEED_DEMO_DATA=true/,
    );
    expect(() => assertSeedAllowed({ SEED_DEMO_DATA: 'true' })).toThrow(
      /DIRECT_URL/,
    );
  });

  it('defaults to the built-in demo owner and accepts an existing user instead', () => {
    expect(assertSeedAllowed(env).userEmail).toBe('owner@demo.test');
    expect(
      assertSeedAllowed({ ...env, SEED_DEMO_USER_EMAIL: ' Me@Example.com ' })
        .userEmail,
    ).toBe('Me@Example.com');
  });
});

describe.skipIf(!migrationsAvailable)(
  'demo seed data (real schema, real RLS)',
  () => {
    let t: TestApp;
    let first: SeedSummary;
    let second: SeedSummary;
    const owner = DEMO_USERS[0];
    const team = DEMO_USERS.filter((u) => u.role !== 'owner').map((u) => ({
      userId: u.id,
      role: u.role as 'admin' | 'staff',
    }));

    beforeAll(async () => {
      const db = await createTestDb({ fullAuth: true });
      // The seeder runs as the privileged owner connection, exactly like `npm run db:seed:demo`.
      await db.asOwner(async (pg) => {
        const orm = drizzle(pg) as never;
        await ensureDemoUsers(orm);
        first = await seedDemoData(
          orm,
          owner.id,
          new Date('2026-11-10T10:00:00Z'),
          team,
        );
        second = await seedDemoData(
          orm,
          owner.id,
          new Date('2026-11-10T10:00:00Z'),
          team,
        );
      });
      t = await createTestApp(db);
    });

    afterAll(async () => {
      await t?.close();
      await t?.db.close();
    });

    it('creates the demo company with products, variants, customers, orders and a stock ledger', () => {
      expect(first.tenantCreated).toBe(true);
      for (const key of [
        'categories',
        'products',
        'productVariants',
        'collections',
        'customers',
        'orders',
        'orderItems',
        'inventoryAdjustments',
      ])
        expect(first.counts[key].inserted, key).toBeGreaterThan(0);
    });

    it('passes its own consistency checks (totals, line items, ledger ends at the stock level)', async () => {
      const problems = await t.db.asOwner((pg) =>
        verifyDemoData(drizzle(pg) as never, first.tenantId),
      );
      expect(problems).toEqual([]);
    });

    it('is idempotent: a second run inserts nothing and finds the same company', () => {
      expect(second.tenantId).toBe(first.tenantId);
      expect(second.tenantCreated).toBe(false);
      for (const [key, c] of Object.entries(second.counts))
        expect(c.inserted, key).toBe(0);
    });

    it('the seeded organization is usable through the API as its Owner', async () => {
      const api = await as(t, owner.id);
      const current = (await api.get('/organizations/current').expect(200)).body
        .data;
      expect(current.organization.slug).toBe('urban-nest-demo');
      expect(current.role).toBe('owner');
      const products = (await api.get('/products?limit=5').expect(200)).body;
      expect(products.meta.total).toBe(first.counts.products.inserted);
      const analytics = (await api.get('/analytics?range=90').expect(200)).body
        .data;
      expect(analytics).toMatchObject({ hasOrders: true, currency: 'INR' });
      expect(analytics.totalSalesMinor).toBeGreaterThan(0);
      expect(
        (await api.get('/inventory').expect(200)).body.meta.total,
      ).toBeGreaterThan(0);
      expect((await api.get('/customers').expect(200)).body.meta.total).toBe(
        first.counts.customers.inserted,
      );
    });

    it('the demo team gets the presets: the manager writes orders-free catalog, staff cannot edit settings', async () => {
      const manager = await as(t, DEMO_USERS[1].id, first.tenantId);
      const staff = await as(t, DEMO_USERS[2].id, first.tenantId);
      await manager.patch('/store', { description: 'Managed' }).expect(200);
      await staff.patch('/store', { description: 'Nope' }).expect(403);
      await staff.get('/products').expect(200);
      await (
        await as(t, DEMO_USERS[1].id, first.tenantId)
      )
        .get('/team/members')
        .expect(403);
    });

    it('the demo Platform Admin can see the company but has no tenant data access', async () => {
      const admin = await as(t, DEMO_PLATFORM_ADMIN.id);
      expect(
        (await admin.get('/platform/organizations').expect(200)).body.meta
          .total,
      ).toBe(1);
      await admin.get('/products').expect(404);
    });

    it('never touches another organization', async () => {
      const orgs = await t.db.asOwner((pg) =>
        pg.query('select count(*)::int as n from tenants'),
      );
      expect((orgs.rows[0] as { n: number }).n).toBe(1);
    });
  },
);
