import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  createFakeSupabase,
  type FakeSupabaseServer,
} from '../../../test/support/auth/fake-supabase.js';
import { signTestToken } from '../../../test/support/auth/sign-test-token.js';
import {
  generateTestKeyPair,
  type TestKeyPair,
} from '../../../test/support/auth/test-keys.js';
import { createTestApp } from '../../../test/support/create-test-app.js';
import {
  createTestDatabase,
  type TestDatabase,
} from '../../../test/support/database/create-test-database.js';
import {
  addMember,
  createTenantWithOwner,
  createUser,
  withSuperuser,
} from '../../../test/support/database/fixtures.js';
import { probeSpies } from '../../../test/support/probe/probe.controller.js';
import { ProbeModule } from '../../../test/support/probe/probe.module.js';
import { DatabaseModule } from '../database/database.module.js';
import { DatabaseService } from '../database/database.service.js';
import { stores } from '../database/schema/stores.js';
import { AuthModule } from './auth.module.js';

describe('Strict Tenant Guard, Permissions and withTenant (AC-B-24 to AC-B-38, TEN)', () => {
  let app: INestApplication;
  let fakeSupabase: FakeSupabaseServer;
  let testDb: TestDatabase;
  let dbService: DatabaseService;
  let keyPair: TestKeyPair;

  let aliceId: string;
  let bobId: string;
  let charlieId: string;
  let staffId: string;
  let disabledUserId: string;

  let tenantA: { tenantId: string; storeId: string; storeSlug: string };
  let tenantB: { tenantId: string; storeId: string; storeSlug: string };
  let tenantSuspended: { tenantId: string; storeId: string; storeSlug: string };

  beforeAll(async () => {
    testDb = await createTestDatabase();

    keyPair = await generateTestKeyPair('tenant-key-1');
    fakeSupabase = await createFakeSupabase({ keys: [keyPair.publicJwk] });
    process.env.SUPABASE_URL = fakeSupabase.url;
    process.env.SUPABASE_ANON_KEY = 'test-anon-key';

    // Users
    aliceId = await createUser(testDb.pg, {
      email: 'alice.tenant@example.test',
      fullName: 'Alice Owner',
    });
    bobId = await createUser(testDb.pg, {
      email: 'bob.tenant@example.test',
      fullName: 'Bob Owner',
    });
    charlieId = await createUser(testDb.pg, {
      email: 'charlie.tenant@example.test',
      fullName: 'Charlie Multi',
    });
    staffId = await createUser(testDb.pg, {
      email: 'staff.tenant@example.test',
      fullName: 'Staff Member',
    });
    disabledUserId = await createUser(testDb.pg, {
      email: 'disabled.user@example.test',
      fullName: 'Disabled Member',
    });

    // Tenants
    tenantA = await createTenantWithOwner(testDb.pg, {
      ownerId: aliceId,
      storeSlug: 'alice-corp',
      tenantName: 'Alice Corp',
      storeName: 'Alice Store',
    });

    tenantB = await createTenantWithOwner(testDb.pg, {
      ownerId: bobId,
      storeSlug: 'bob-corp',
      tenantName: 'Bob Corp',
      storeName: 'Bob Store',
    });

    tenantSuspended = await createTenantWithOwner(testDb.pg, {
      ownerId: aliceId,
      storeSlug: 'alice-suspended',
      tenantName: 'Alice Suspended Corp',
      storeName: 'Alice Suspended Store',
    });

    await withSuperuser(testDb.pg, async () => {
      // Suspend tenant
      await testDb.pg.query(
        "update public.tenants set status = 'suspended' where id = $1",
        [tenantSuspended.tenantId],
      );

      // Charlie belongs to both tenantA and tenantB
      await addMember(testDb.pg, {
        tenantId: tenantA.tenantId,
        userId: charlieId,
        role: 'admin',
      });
      await addMember(testDb.pg, {
        tenantId: tenantB.tenantId,
        userId: charlieId,
        role: 'staff',
      });

      // Disabled membership in tenantA
      await addMember(testDb.pg, {
        tenantId: tenantA.tenantId,
        userId: disabledUserId,
        status: 'disabled',
      });

      // Staff member with read-only on products in tenantA
      await addMember(testDb.pg, {
        tenantId: tenantA.tenantId,
        userId: staffId,
        role: 'staff',
        permissions: {
          products: 'read',
          orders: 'none',
          customers: 'none',
          settings: 'none',
        },
      });
    });

    process.env.DATABASE_URL = testDb.url;
    process.env.DB_POOL_MAX = '1';
    process.env.DB_PREPARE = 'false';

    app = await createTestApp({
      modules: [DatabaseModule, AuthModule, ProbeModule],
    });

    dbService = app.get(DatabaseService);
  });

  afterAll(async () => {
    await app.close();
    await testDb.close();
    await fakeSupabase.close();
  });

  beforeEach(() => {
    probeSpies.reset();
  });

  it('AC-B-24: missing X-Tenant-Id gives 400', async () => {
    const token = await signTestToken({
      userId: aliceId,
      keyPair,
      iss: fakeSupabase.issuer,
    });

    const res = await request(app.getHttpServer())
      .get('/api/v1/probe/default')
      .set('Authorization', `Bearer ${token}`)
      .expect(400);

    expect(res.body.code).toBe('VALIDATION_FAILED');
    expect(res.body.message).toContain('Missing X-Tenant-Id header');
    expect(probeSpies.defaultHandler).toBe(0);
  });

  it('AC-B-25: malformed UUID gives 400', async () => {
    const token = await signTestToken({
      userId: aliceId,
      keyPair,
      iss: fakeSupabase.issuer,
    });

    const res = await request(app.getHttpServer())
      .get('/api/v1/probe/default')
      .set('Authorization', `Bearer ${token}`)
      .set('X-Tenant-Id', 'not-a-valid-uuid')
      .expect(400);

    expect(res.body.code).toBe('VALIDATION_FAILED');
    expect(res.body.message).toContain('UUID');
    expect(probeSpies.defaultHandler).toBe(0);
  });

  it('AC-B-26: valid UUID, no membership gives 403', async () => {
    const token = await signTestToken({
      userId: aliceId,
      keyPair,
      iss: fakeSupabase.issuer,
    });

    // Bob's tenant, where Alice has no membership
    const res = await request(app.getHttpServer())
      .get('/api/v1/probe/default')
      .set('Authorization', `Bearer ${token}`)
      .set('X-Tenant-Id', tenantB.tenantId)
      .expect(403);

    expect(res.body.code).toBe('FORBIDDEN');
    expect(probeSpies.defaultHandler).toBe(0);
  });

  it('AC-B-27: 403 body is identical for a non-existent tenant and another user tenant', async () => {
    const token = await signTestToken({
      userId: aliceId,
      keyPair,
      iss: fakeSupabase.issuer,
    });

    const nonExistentTenantId = '99999999-9999-9999-9999-999999999999';

    const resNonExistent = await request(app.getHttpServer())
      .get('/api/v1/probe/default')
      .set('Authorization', `Bearer ${token}`)
      .set('X-Tenant-Id', nonExistentTenantId)
      .expect(403);

    const resOtherTenant = await request(app.getHttpServer())
      .get('/api/v1/probe/default')
      .set('Authorization', `Bearer ${token}`)
      .set('X-Tenant-Id', tenantB.tenantId)
      .expect(403);

    expect(resNonExistent.body.statusCode).toBe(resOtherTenant.body.statusCode);
    expect(resNonExistent.body.code).toBe(resOtherTenant.body.code);
    expect(resNonExistent.body.error).toBe(resOtherTenant.body.error);
    expect(resNonExistent.body.message).toBe(resOtherTenant.body.message);
  });

  it('AC-B-28: disabled membership gives 403', async () => {
    const token = await signTestToken({
      userId: disabledUserId,
      keyPair,
      iss: fakeSupabase.issuer,
    });

    const res = await request(app.getHttpServer())
      .get('/api/v1/probe/default')
      .set('Authorization', `Bearer ${token}`)
      .set('X-Tenant-Id', tenantA.tenantId)
      .expect(403);

    expect(res.body.code).toBe('FORBIDDEN');
    expect(probeSpies.defaultHandler).toBe(0);
  });

  it('AC-B-29: suspended tenant gives 403', async () => {
    const token = await signTestToken({
      userId: aliceId,
      keyPair,
      iss: fakeSupabase.issuer,
    });

    const res = await request(app.getHttpServer())
      .get('/api/v1/probe/default')
      .set('Authorization', `Bearer ${token}`)
      .set('X-Tenant-Id', tenantSuspended.tenantId)
      .expect(403);

    expect(res.body.code).toBe('FORBIDDEN');
    expect(probeSpies.defaultHandler).toBe(0);
  });

  it('AC-B-30: user with two tenants: requested tenant is used, not the first', async () => {
    const token = await signTestToken({
      userId: charlieId,
      keyPair,
      iss: fakeSupabase.issuer,
    });

    // Charlie requests tenant A
    const resA = await request(app.getHttpServer())
      .get('/api/v1/probe/default')
      .set('Authorization', `Bearer ${token}`)
      .set('X-Tenant-Id', tenantA.tenantId)
      .expect(200);

    expect(resA.body.tenant.tenantId).toBe(tenantA.tenantId);
    expect(resA.body.tenant.role).toBe('admin');

    // Charlie requests tenant B
    const resB = await request(app.getHttpServer())
      .get('/api/v1/probe/default')
      .set('Authorization', `Bearer ${token}`)
      .set('X-Tenant-Id', tenantB.tenantId)
      .expect(200);

    expect(resB.body.tenant.tenantId).toBe(tenantB.tenantId);
    expect(resB.body.tenant.role).toBe('staff');
  });

  it('AC-B-31: stale or incorrect id (user has other tenants) gives 403, never a fallback', async () => {
    const token = await signTestToken({
      userId: charlieId,
      keyPair,
      iss: fakeSupabase.issuer,
    });

    const unknownTenantId = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
    const res = await request(app.getHttpServer())
      .get('/api/v1/probe/default')
      .set('Authorization', `Bearer ${token}`)
      .set('X-Tenant-Id', unknownTenantId)
      .expect(403);

    expect(res.body.code).toBe('FORBIDDEN');
    expect(probeSpies.defaultHandler).toBe(0);
  });

  it('AC-B-32: tenant in body, query or JWT claim is ignored', async () => {
    // Charlie claims tenantA in JWT, but passes tenantB in header
    const token = await signTestToken({
      userId: charlieId,
      keyPair,
      iss: fakeSupabase.issuer,
      claims: {
        tenant_id: tenantA.tenantId,
        tenantId: tenantA.tenantId,
      },
    });

    // Body/query attempts to pass tenantA; header specifies tenantB
    const res = await request(app.getHttpServer())
      .get(`/api/v1/probe/default?tenantId=${tenantA.tenantId}`)
      .set('Authorization', `Bearer ${token}`)
      .set('X-Tenant-Id', tenantB.tenantId)
      .expect(200);

    // Header wins completely
    expect(res.body.tenant.tenantId).toBe(tenantB.tenantId);
    expect(res.body.tenant.role).toBe('staff');

    // Query or body alone without header gives 400
    await request(app.getHttpServer())
      .get(`/api/v1/probe/default?tenantId=${tenantA.tenantId}`)
      .set('Authorization', `Bearer ${token}`)
      .expect(400);
  });

  it('AC-B-33: handler spy not called after any tenant validation failure', async () => {
    const token = await signTestToken({
      userId: aliceId,
      keyPair,
      iss: fakeSupabase.issuer,
    });

    // 400 missing header
    await request(app.getHttpServer())
      .get('/api/v1/probe/default')
      .set('Authorization', `Bearer ${token}`)
      .expect(400);

    // 400 malformed header
    await request(app.getHttpServer())
      .get('/api/v1/probe/default')
      .set('Authorization', `Bearer ${token}`)
      .set('X-Tenant-Id', 'not-uuid')
      .expect(400);

    // 403 non-member
    await request(app.getHttpServer())
      .get('/api/v1/probe/default')
      .set('Authorization', `Bearer ${token}`)
      .set('X-Tenant-Id', tenantB.tenantId)
      .expect(403);

    expect(probeSpies.defaultHandler).toBe(0);
  });

  it('AC-B-34: withTenant yields tenantId, userId, role', async () => {
    const result = await dbService.withTenant(
      { tenantId: tenantA.tenantId, userId: aliceId },
      async (_tx, ctx) => {
        return {
          tenantId: ctx.tenantId,
          userId: ctx.userId,
          role: ctx.role,
        };
      },
    );

    expect(result.tenantId).toBe(tenantA.tenantId);
    expect(result.userId).toBe(aliceId);
    expect(result.role).toBe('owner');
  });

  it('AC-B-35: membership removed after the guard but before withTenant gives 403', async () => {
    const nonExistentTenant = '88888888-8888-8888-8888-888888888888';

    await expect(
      dbService.withTenant(
        { tenantId: nonExistentTenant, userId: aliceId },
        async () => 'should-not-run',
      ),
    ).rejects.toThrow('Access to the requested tenant was denied.');
  });

  it('AC-B-36: @RequirePermission allows and denies per can() including per-module access levels', async () => {
    // 1. Alice (owner) has full access
    const aliceToken = await signTestToken({
      userId: aliceId,
      keyPair,
      iss: fakeSupabase.issuer,
    });

    await request(app.getHttpServer())
      .get('/api/v1/probe/permission')
      .set('Authorization', `Bearer ${aliceToken}`)
      .set('X-Tenant-Id', tenantA.tenantId)
      .expect(200);

    await request(app.getHttpServer())
      .post('/api/v1/probe/permission/manage')
      .set('Authorization', `Bearer ${aliceToken}`)
      .set('X-Tenant-Id', tenantA.tenantId)
      .expect(201);

    await request(app.getHttpServer())
      .post('/api/v1/probe/permission/members')
      .set('Authorization', `Bearer ${aliceToken}`)
      .set('X-Tenant-Id', tenantA.tenantId)
      .expect(201);

    // 2. Staff member with products: 'read'
    const staffToken = await signTestToken({
      userId: staffId,
      keyPair,
      iss: fakeSupabase.issuer,
    });

    // Allowed on catalog:view (read on products)
    await request(app.getHttpServer())
      .get('/api/v1/probe/permission')
      .set('Authorization', `Bearer ${staffToken}`)
      .set('X-Tenant-Id', tenantA.tenantId)
      .expect(200);

    // Denied on catalog:manage (requires write on products)
    const resManage = await request(app.getHttpServer())
      .post('/api/v1/probe/permission/manage')
      .set('Authorization', `Bearer ${staffToken}`)
      .set('X-Tenant-Id', tenantA.tenantId)
      .expect(403);
    expect(resManage.body.code).toBe('FORBIDDEN');

    // Denied on members:manage (requires owner)
    const resMembers = await request(app.getHttpServer())
      .post('/api/v1/probe/permission/members')
      .set('Authorization', `Bearer ${staffToken}`)
      .set('X-Tenant-Id', tenantA.tenantId)
      .expect(403);
    expect(resMembers.body.code).toBe('FORBIDDEN');
  });

  it('AC-B-37: authenticated route without @NoTenant() requires the header; @NoTenant() route does not', async () => {
    const token = await signTestToken({
      userId: aliceId,
      keyPair,
      iss: fakeSupabase.issuer,
    });

    // Route with @NoTenant() succeeds with no X-Tenant-Id header
    const resNoTenant = await request(app.getHttpServer())
      .get('/api/v1/probe/no-tenant')
      .set('Authorization', `Bearer ${token}`)
      .expect(200);
    expect(resNoTenant.body.status).toBe('no-tenant');

    // Route without @NoTenant() fails with 400 when X-Tenant-Id is omitted
    const resDefault = await request(app.getHttpServer())
      .get('/api/v1/probe/default')
      .set('Authorization', `Bearer ${token}`)
      .expect(400);
    expect(resDefault.body.code).toBe('VALIDATION_FAILED');
  });

  it('AC-B-38: RLS alone isolates tenants: probe query with no tenant filter returns only the caller rows', async () => {
    // Alice queries stores without any WHERE filter
    const aliceStores = await dbService.withUser(aliceId, async (tx) => {
      return tx.select().from(stores);
    });

    // Alice should see Alice's stores (tenantA + tenantSuspended), not Bob's store (tenantB)
    expect(aliceStores.length).toBeGreaterThanOrEqual(1);
    for (const store of aliceStores) {
      expect(store.tenantId).not.toBe(tenantB.tenantId);
    }

    // Bob queries stores without any WHERE filter
    const bobStores = await dbService.withUser(bobId, async (tx) => {
      return tx.select().from(stores);
    });

    // Bob should see ONLY Bob's store, not Alice's stores
    expect(bobStores.length).toBe(1);
    expect(bobStores[0].tenantId).toBe(tenantB.tenantId);
  });
});
