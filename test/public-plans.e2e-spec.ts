import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import supertest from 'supertest';
import { as, createTestApp, type TestApp } from './support/app.js';
import { createTestDb, migrationsAvailable } from './support/pglite.js';
import { seedWorld } from './support/world.js';

type Client = Awaited<ReturnType<typeof as>>;
type PublicPlan = {
  code: string;
  name: string;
  description: string | null;
  currency: string;
  monthlyPrice: string;
  monthlyPriceMinor: number;
  yearlyPrice: string;
  yearlyPriceMinor: number;
  trialDays: number;
  features: { key: string; label: string }[];
  limits: { key: string; label: string; unit: string; value: number | null }[];
};

describe.skipIf(!migrationsAvailable)('public subscription plans (e2e)', () => {
  let t: TestApp;
  let sup: Client;
  let starterId: string;

  const publicPlans = async () =>
    (
      await supertest(t.app.getHttpServer())
        .get('/api/v1/public/plans')
        .expect(200)
    ).body.data as PublicPlan[];

  const body = (over: Record<string, unknown> = {}) => ({
    code: 'starter',
    name: 'Starter',
    description: 'For small stores',
    monthlyPrice: '499',
    yearlyPrice: '4990',
    trialDays: 14,
    features: { discount_codes: true, google_analytics: false },
    limits: { products: { soft: 80, hard: 100 }, staff_accounts: { hard: 2 } },
    ...over,
  });

  beforeAll(async () => {
    const db = await createTestDb();
    const w = await seedWorld(db);
    t = await createTestApp(db);
    sup = await as(t, w.superAdmin);
  });

  afterAll(async () => {
    await t?.close();
    await t?.db.close();
  });

  it('lists nothing while only the internal unrestricted Legacy plan exists', async () => {
    expect(await publicPlans()).toEqual([]);
  });

  it('shows a published plan to anyone, with prices, trial, included features and limits', async () => {
    starterId = (await sup.post('/platform/plans', body()).expect(201)).body
      .data.id;
    const [plan] = await publicPlans();
    expect(plan).toEqual({
      code: 'starter',
      name: 'Starter',
      description: 'For small stores',
      currency: 'INR',
      monthlyPrice: '499.00',
      monthlyPriceMinor: 49900,
      yearlyPrice: '4990.00',
      yearlyPriceMinor: 499000,
      trialDays: 14,
      features: [
        { key: 'discount_codes', label: 'Discount codes and coupons' },
      ],
      limits: [
        { key: 'products', label: 'Products', unit: 'count', value: 100 },
        {
          key: 'staff_accounts',
          label: 'Staff accounts',
          unit: 'count',
          value: 2,
        },
        {
          key: 'orders_per_month',
          label: 'Orders per month',
          unit: 'count',
          value: null,
        },
        { key: 'storage_bytes', label: 'Storage', unit: 'bytes', value: null },
      ],
    });
  });

  it('never exposes ids, subscriber counts or other admin data', async () => {
    const [plan] = await publicPlans();
    expect(Object.keys(plan).sort()).toEqual([
      'code',
      'currency',
      'description',
      'features',
      'limits',
      'monthlyPrice',
      'monthlyPriceMinor',
      'name',
      'trialDays',
      'yearlyPrice',
      'yearlyPriceMinor',
    ]);
  });

  it('lists plans in the order the admin chose, and hides a plan once it is made inactive', async () => {
    // Lower numbers are listed first, so push Starter after Pro.
    await sup
      .patch(`/platform/plans/${starterId}`, { sortOrder: 5 })
      .expect(200);
    const pro = (
      await sup
        .post(
          '/platform/plans',
          body({
            code: 'pro',
            name: 'Pro',
            monthlyPrice: '1499',
            yearlyPrice: '14990',
            sortOrder: 0,
          }),
        )
        .expect(201)
    ).body.data.id as string;
    expect((await publicPlans()).map((p) => p.code)).toEqual([
      'pro',
      'starter',
    ]);

    await sup
      .patch(`/platform/plans/${pro}/status`, { status: 'inactive' })
      .expect(200);
    expect((await publicPlans()).map((p) => p.code)).toEqual(['starter']);

    await sup
      .patch(`/platform/plans/${pro}/status`, { status: 'active' })
      .expect(200);
    expect((await publicPlans()).map((p) => p.code)).toEqual([
      'pro',
      'starter',
    ]);
  });

  it('treats a limit with no hard number as unlimited, and does not list an unrestricted plan', async () => {
    await sup
      .patch(`/platform/plans/${starterId}`, {
        limits: { products: { soft: 50 } },
      })
      .expect(200);
    const starter = (await publicPlans()).find((p) => p.code === 'starter')!;
    expect(starter.limits.find((l) => l.key === 'products')?.value).toBeNull();

    await sup
      .post(
        '/platform/plans',
        body({ code: 'internal', name: 'Internal', isUnrestricted: true }),
      )
      .expect(201);
    expect((await publicPlans()).map((p) => p.code)).not.toContain('internal');
  });
});
