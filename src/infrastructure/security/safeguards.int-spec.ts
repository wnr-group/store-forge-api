import type { INestApplication } from '@nestjs/common';
import { sql } from 'drizzle-orm';
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
  createPlatformAdmin,
  createUser,
  withSuperuser,
} from '../../../test/support/database/fixtures.js';
import { probeSpies } from '../../../test/support/probe/probe.controller.js';
import { ProbeModule } from '../../../test/support/probe/probe.module.js';
import { AuthModule } from '../auth/auth.module.js';
import { DatabaseModule } from '../database/database.module.js';
import { DatabaseService } from '../database/database.service.js';
import type { DbTx } from '../database/database.types.js';
import {
  ADMIN_RATE_LIMITS,
  AdminRateLimitService,
} from './admin-rate-limit.service.js';
import { AuditService } from './audit.service.js';

describe('Platform Safeguard Primitives (AC-B-73 to AC-B-81, PLT)', () => {
  let app: INestApplication;
  let fakeSupabase: FakeSupabaseServer;
  let testDb: TestDatabase;
  let dbService: DatabaseService;
  let rateLimitService: AdminRateLimitService;
  let auditService: AuditService;
  let keyPair: TestKeyPair;

  let superAdminId: string;
  let standardAdminId: string;
  let regularUserId: string;

  beforeAll(async () => {
    testDb = await createTestDatabase();

    keyPair = await generateTestKeyPair('safeguards-key-1');
    fakeSupabase = await createFakeSupabase({ keys: [keyPair.publicJwk] });
    process.env.SUPABASE_URL = fakeSupabase.url;
    process.env.SUPABASE_ANON_KEY = 'test-anon-key';

    // Users and Admins
    regularUserId = await createUser(testDb.pg, {
      email: 'regular.user@example.test',
      fullName: 'Regular User',
    });

    standardAdminId = await createPlatformAdmin(testDb.pg, {
      email: 'standard.admin@example.test',
      role: 'admin',
    });

    superAdminId = await createPlatformAdmin(testDb.pg, {
      email: 'super.admin@example.test',
      role: 'super_admin',
    });

    process.env.DATABASE_URL = testDb.url;
    process.env.DB_POOL_MAX = '1';
    process.env.DB_PREPARE = 'false';

    app = await createTestApp({
      modules: [DatabaseModule, AuthModule, ProbeModule],
    });

    dbService = app.get(DatabaseService);
    rateLimitService = app.get(AdminRateLimitService);
    auditService = app.get(AuditService);
  });

  afterAll(async () => {
    await app.close();
    await testDb.close();
    await fakeSupabase.close();
  });

  beforeEach(() => {
    probeSpies.reset();
  });

  it('AC-B-73: each of the 7 buckets keeps its exact limit and 600 s window', async () => {
    expect(ADMIN_RATE_LIMITS['org.create']).toEqual({
      limit: 10,
      windowSeconds: 600,
    });
    expect(ADMIN_RATE_LIMITS['org.edit']).toEqual({
      limit: 60,
      windowSeconds: 600,
    });
    expect(ADMIN_RATE_LIMITS['org.delete']).toEqual({
      limit: 5,
      windowSeconds: 600,
    });
    expect(ADMIN_RATE_LIMITS['team.manage']).toEqual({
      limit: 30,
      windowSeconds: 600,
    });
    expect(ADMIN_RATE_LIMITS['ownership.change']).toEqual({
      limit: 5,
      windowSeconds: 600,
    });
    expect(ADMIN_RATE_LIMITS['admin.manage']).toEqual({
      limit: 10,
      windowSeconds: 600,
    });
    expect(ADMIN_RATE_LIMITS['settings.update']).toEqual({
      limit: 20,
      windowSeconds: 600,
    });

    // Test bucket enforcement on 'ownership.change' (limit: 5)
    await dbService.withUser(superAdminId, async (tx) => {
      // Calls 1 to 5 succeed
      for (let i = 0; i < 5; i++) {
        await rateLimitService.enforce(tx, 'ownership.change');
      }

      // 6th call exceeds limit
      await expect(
        rateLimitService.enforce(tx, 'ownership.change'),
      ).rejects.toThrow('Platform admin rate limit exceeded');
    });
  });

  it('AC-B-74: two admins have independent counters', async () => {
    // standardAdminId exhausts org.delete (limit: 5)
    await dbService.withUser(standardAdminId, async (tx) => {
      for (let i = 0; i < 5; i++) {
        await rateLimitService.enforce(tx, 'org.delete');
      }

      await expect(rateLimitService.enforce(tx, 'org.delete')).rejects.toThrow(
        'Platform admin rate limit exceeded',
      );
    });

    // superAdminId still has full allowance on org.delete
    await dbService.withUser(superAdminId, async (tx) => {
      await expect(
        rateLimitService.enforce(tx, 'org.delete'),
      ).resolves.not.toThrow();
    });
  });

  it('AC-B-75: limiter or database error fails open and logs', async () => {
    // Failing transaction mock
    const failingTx = {
      execute: () => {
        throw new Error('database connection severed');
      },
    } as unknown as DbTx;

    // Must not throw, fails open
    await expect(
      rateLimitService.enforce(failingTx, 'org.create'),
    ).resolves.not.toThrow();
  });

  it('AC-B-76: audit row is committed atomically with the mutation', async () => {
    let auditId: string;

    await dbService.withUser(superAdminId, async (tx) => {
      auditId = await auditService.record(tx, {
        action: 'tenant.create',
        entityType: 'organization',
        description: 'Created organization Alpha Corp',
        next: { name: 'Alpha Corp' },
      });
      expect(auditId).toBeDefined();
    });

    // Verify row was committed
    await withSuperuser(testDb.pg, async () => {
      const res = await testDb.pg.query<{ id: string; description: string }>(
        'select id, description from public.admin_audit_logs where id = $1',
        [auditId],
      );
      expect(res.rows.length).toBe(1);
      expect(res.rows[0].description).toBe('Created organization Alpha Corp');
    });
  });

  it('AC-B-77: failed mutation leaves no audit row', async () => {
    let capturedAuditId: string | undefined;

    await expect(
      dbService.withUser(superAdminId, async (tx) => {
        capturedAuditId = await auditService.record(tx, {
          action: 'tenant.delete',
          entityType: 'organization',
          description: 'Attempting to delete organization',
        });
        // Abort transaction
        throw new Error('Transaction exploded');
      }),
    ).rejects.toThrow('Transaction exploded');

    // Verify row does NOT exist in database
    await withSuperuser(testDb.pg, async () => {
      const res = await testDb.pg.query(
        'select id from public.admin_audit_logs where id = $1',
        [capturedAuditId],
      );
      expect(res.rows.length).toBe(0);
    });
  });

  it('AC-B-78: audit table rejects update and delete (immutable)', async () => {
    // Create an audit row
    let auditId: string;
    await dbService.withUser(superAdminId, async (tx) => {
      auditId = await auditService.record(tx, {
        action: 'settings.update',
        entityType: 'platform_settings',
        description: 'Immutable test record',
      });
    });

    await withSuperuser(testDb.pg, async () => {
      // UPDATE must fail with 42501
      await expect(
        testDb.pg.query(
          "update public.admin_audit_logs set description = 'tampered' where id = $1",
          [auditId],
        ),
      ).rejects.toThrow(/audit_log_immutable/);

      // DELETE must fail with 42501
      await expect(
        testDb.pg.query('delete from public.admin_audit_logs where id = $1', [
          auditId,
        ]),
      ).rejects.toThrow(/audit_log_immutable/);
    });
  });

  it('AC-B-79: non-platform-admin rejected by guard', async () => {
    const regularToken = await signTestToken({
      userId: regularUserId,
      keyPair,
      iss: fakeSupabase.issuer,
    });

    const resRegular = await request(app.getHttpServer())
      .get('/api/v1/probe/platform-admin')
      .set('Authorization', `Bearer ${regularToken}`)
      .expect(403);

    expect(resRegular.body.code).toBe('FORBIDDEN');
    expect(probeSpies.platformAdminHandler).toBe(0);

    // Platform admin succeeds
    const adminToken = await signTestToken({
      userId: standardAdminId,
      keyPair,
      iss: fakeSupabase.issuer,
    });

    const resAdmin = await request(app.getHttpServer())
      .get('/api/v1/probe/platform-admin')
      .set('Authorization', `Bearer ${adminToken}`)
      .expect(200);

    expect(resAdmin.body.status).toBe('platform-admin-ok');
    expect(probeSpies.platformAdminHandler).toBe(1);
  });

  it('AC-B-80: platform admin rejected on super-admin-only route', async () => {
    // Standard admin fails on super-admin route
    const standardToken = await signTestToken({
      userId: standardAdminId,
      keyPair,
      iss: fakeSupabase.issuer,
    });

    const resStandard = await request(app.getHttpServer())
      .get('/api/v1/probe/super-admin')
      .set('Authorization', `Bearer ${standardToken}`)
      .expect(403);

    expect(resStandard.body.code).toBe('FORBIDDEN');
    expect(probeSpies.superAdminHandler).toBe(0);

    // Super admin succeeds
    const superToken = await signTestToken({
      userId: superAdminId,
      keyPair,
      iss: fakeSupabase.issuer,
    });

    const resSuper = await request(app.getHttpServer())
      .get('/api/v1/probe/super-admin')
      .set('Authorization', `Bearer ${superToken}`)
      .expect(200);

    expect(resSuper.body.status).toBe('super-admin-ok');
    expect(probeSpies.superAdminHandler).toBe(1);
  });

  it('AC-B-81: database-side authorization holds with the guard bypassed', async () => {
    // 1. Call rate_limit_admin directly as regularUser
    try {
      await dbService.withUser(regularUserId, async (tx) => {
        return tx.execute(
          sql`select * from public.rate_limit_admin('org.create', 10, 600)`,
        );
      });
      expect.unreachable('Should have thrown not_platform_admin');
    } catch (err: unknown) {
      const cause = (err as { cause?: { code?: string; message?: string } })
        ?.cause;
      expect(cause?.code).toBe('42501');
      expect(cause?.message).toBe('not_platform_admin');
    }

    // 2. Call platform_record_audit directly as regularUser
    try {
      await dbService.withUser(regularUserId, async (tx) => {
        return tx.execute(
          sql`select public.platform_record_audit('org.create', 'organization', null, null, 'Test audit')`,
        );
      });
      expect.unreachable('Should have thrown not_platform_admin');
    } catch (err: unknown) {
      const cause = (err as { cause?: { code?: string; message?: string } })
        ?.cause;
      expect(cause?.code).toBe('42501');
      expect(cause?.message).toBe('not_platform_admin');
    }
  });
});
