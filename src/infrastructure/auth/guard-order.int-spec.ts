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
  createTenantWithOwner,
  createUser,
} from '../../../test/support/database/fixtures.js';
import { ProbeModule } from '../../../test/support/probe/probe.module.js';
import {
  extractRouteInventory,
  validateRouteInventoryPolicy,
} from '../../../test/support/route-inventory.js';

describe('Global Guard Registration & Guard Order (AC-B-16, AC-B-20, AC-B-37, ORD)', () => {
  let app: INestApplication;
  let testDb: TestDatabase;
  let fakeSupabase: FakeSupabaseServer;
  let keyPair: TestKeyPair;
  let ownerId: string;
  let tenant: { tenantId: string; storeId: string; storeSlug: string };
  const recordedGuards: string[] = [];

  beforeAll(async () => {
    testDb = await createTestDatabase();

    keyPair = await generateTestKeyPair('guard-order-key');
    fakeSupabase = await createFakeSupabase({ keys: [keyPair.publicJwk] });
    process.env.SUPABASE_URL = fakeSupabase.url;
    process.env.SUPABASE_ANON_KEY = 'test-anon-key';

    ownerId = await createUser(testDb.pg, {
      email: 'order.owner@example.test',
      fullName: 'Order Owner',
    });

    tenant = await createTenantWithOwner(testDb.pg, {
      ownerId,
      storeSlug: 'order-corp',
      tenantName: 'Order Corp',
      storeName: 'Order Store',
    });

    process.env.DATABASE_URL = testDb.url;
    process.env.DB_POOL_MAX = '1';
    process.env.DB_PREPARE = 'false';

    // createTestApp automatically imports AppModule (which registers the 6 guards globally)
    app = await createTestApp({
      modules: [ProbeModule],
      recordGuardOrder: recordedGuards,
    });
  });

  afterAll(async () => {
    await app.close();
    await testDb.close();
    await fakeSupabase.close();
  });

  beforeEach(() => {
    recordedGuards.length = 0;
  });

  it('runs all 6 global guards in the exact mandated order on a protected route', async () => {
    const token = await signTestToken({
      userId: ownerId,
      keyPair,
      iss: fakeSupabase.issuer,
    });

    const res = await request(app.getHttpServer())
      .get('/api/v1/probe/default')
      .set('Authorization', `Bearer ${token}`)
      .set('X-Tenant-Id', tenant.tenantId)
      .expect(200);

    expect(res.body.status).toBe('authenticated-default');
    expect(recordedGuards).toEqual([
      'AuthGuard',
      'TenantGuard',
      'PlatformAdminGuard',
      'SuperAdminGuard',
      'PermissionGuard',
      'LiveAuthGuard',
    ]);
  });

  it('fails fast at AuthGuard: subsequent guards are never called when token is missing', async () => {
    const res = await request(app.getHttpServer())
      .get('/api/v1/probe/default')
      .expect(401);

    expect(res.body.code).toBe('UNAUTHENTICATED');
    expect(recordedGuards).toEqual(['AuthGuard']);
  });

  it('fails at TenantGuard: subsequent guards are never called when X-Tenant-Id is missing', async () => {
    const token = await signTestToken({
      userId: ownerId,
      keyPair,
      iss: fakeSupabase.issuer,
    });

    const res = await request(app.getHttpServer())
      .get('/api/v1/probe/default')
      .set('Authorization', `Bearer ${token}`)
      .expect(400);

    expect(res.body.code).toBe('VALIDATION_FAILED');
    expect(recordedGuards).toEqual(['AuthGuard', 'TenantGuard']);
  });

  it('public route passes all guards without requiring credentials', async () => {
    const res = await request(app.getHttpServer())
      .get('/api/v1/probe/public')
      .expect(200);

    expect(res.body.status).toBe('public-ok');
    // Each guard ran and evaluated isPublic = true
    expect(recordedGuards).toEqual([
      'AuthGuard',
      'TenantGuard',
      'PlatformAdminGuard',
      'SuperAdminGuard',
      'PermissionGuard',
      'LiveAuthGuard',
    ]);
  });

  it('route inventory adheres to decorator policy (no @Public combined with protected)', () => {
    const inventory = extractRouteInventory(app);
    expect(inventory.length).toBeGreaterThan(0);
    expect(() => validateRouteInventoryPolicy(inventory)).not.toThrow();
  });
});
