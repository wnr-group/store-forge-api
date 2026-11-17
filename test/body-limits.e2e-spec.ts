import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { as, createTestApp, type TestApp } from './support/app.js';
import { createTestDb, migrationsAvailable } from './support/pglite.js';
import { seedWorld } from './support/world.js';

describe.skipIf(!migrationsAvailable)('request body limits (e2e)', () => {
  let t: TestApp;
  let alice: Awaited<ReturnType<typeof as>>;
  beforeAll(async () => {
    const db = await createTestDb();
    const w = await seedWorld(db);
    t = await createTestApp(db);
    alice = await as(t, w.alice);
  });
  afterAll(async () => {
    await t?.close();
    await t?.db.close();
  });

  const pad = (chars: number) => ({ name: 'x'.repeat(chars) });

  it('AC-18: other routes still parse small bodies and refuse more than 100 KB in the error envelope', async () => {
    await alice.post('/categories', { name: 'Body parse check' }).expect(201);
    const res = await alice.post('/categories', pad(150_000)).expect(413);
    expect(res.body).toMatchObject({
      success: false,
      error: { code: 'HTTP_413' },
    });
  });

  it('the import route accepts bodies between 100 KB and 2 MB and refuses more', async () => {
    const mid = await alice.post('/products/import', pad(1_500_000));
    expect(mid.status).not.toBe(413);
    await alice.post('/products/import', pad(2_500_000)).expect(413);
  });
});
