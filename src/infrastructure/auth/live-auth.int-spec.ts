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
import { createPlatformAdmin } from '../../../test/support/database/fixtures.js';
import {
  ProbeController,
  probeSpies,
} from '../../../test/support/probe/probe.controller.js';
import { ProbeModule } from '../../../test/support/probe/probe.module.js';
import { AuthModule } from './auth.module.js';
import { expectLiveAuthRequired } from './decorators.js';
import { LiveAuthService } from './live-auth.service.js';

describe('Live Auth Guard and Service (AC-B-16 to AC-B-21, LIVE)', () => {
  let app: INestApplication;
  let testDb: TestDatabase;
  let fakeSupabase: FakeSupabaseServer;
  let keyPair: TestKeyPair;
  let liveAuthService: LiveAuthService;
  let validUserId: string;
  let validToken: string;

  beforeAll(async () => {
    testDb = await createTestDatabase();
    process.env.DATABASE_URL = testDb.url;
    process.env.DB_POOL_MAX = '1';
    process.env.DB_PREPARE = 'false';

    validUserId = await createPlatformAdmin(testDb.pg, {
      email: 'liveadmin@example.test',
      role: 'super_admin',
    });

    keyPair = await generateTestKeyPair('live-key');
    fakeSupabase = await createFakeSupabase({ keys: [keyPair.publicJwk] });

    process.env.SUPABASE_URL = fakeSupabase.url;
    process.env.SUPABASE_ANON_KEY = 'test-anon-key';

    app = await createTestApp({
      modules: [AuthModule, ProbeModule],
    });

    liveAuthService = app.get(LiveAuthService);

    validToken = await signTestToken({
      userId: validUserId,
      keyPair,
      iss: fakeSupabase.issuer,
    });
  });

  afterAll(async () => {
    await app.close();
    await fakeSupabase.close();
    await testDb.close();
  });

  beforeEach(() => {
    fakeSupabase.resetUserCalls();
    fakeSupabase.setDelayMs(0);
    probeSpies.reset();
  });

  it('AC-B-16: ordinary authenticated reads make zero /auth/v1/user calls', async () => {
    const res = await request(app.getHttpServer())
      .get('/api/v1/probe/no-tenant')
      .set('Authorization', `Bearer ${validToken}`)
      .expect(200);

    expect(res.body.status).toBe('no-tenant');
    expect(res.body.auth.userId).toBe(validUserId);
    expect(fakeSupabase.userCalls()).toBe(0);
  });

  it('AC-B-17: @RequireLiveAuth passes for a valid user', async () => {
    fakeSupabase.setUserResponse(200, { id: validUserId });

    const res = await request(app.getHttpServer())
      .post('/api/v1/probe/live')
      .set('Authorization', `Bearer ${validToken}`)
      .expect(201);

    expect(res.body.status).toBe('live-ok');
    expect(fakeSupabase.userCalls()).toBe(1);
    expect(probeSpies.liveHandler).toBe(1);
  });

  it('AC-B-18: invalid, deleted or disabled user (401, 403, id mismatch) rejected', async () => {
    // 401 from Supabase
    fakeSupabase.setUserResponse(401, { message: 'Invalid session' });
    const res401 = await request(app.getHttpServer())
      .post('/api/v1/probe/live')
      .set('Authorization', `Bearer ${validToken}`)
      .expect(401);
    expect(res401.body.code).toBe('UNAUTHENTICATED');
    expect(res401.body.message).toBe('Invalid or expired session.');

    // 403 from Supabase (disabled/banned)
    fakeSupabase.setUserResponse(403, { message: 'User banned' });
    const res403 = await request(app.getHttpServer())
      .post('/api/v1/probe/live')
      .set('Authorization', `Bearer ${validToken}`)
      .expect(401);
    expect(res403.body.code).toBe('UNAUTHENTICATED');
    expect(res403.body.message).toBe('Invalid or expired session.');

    // ID mismatch from Supabase
    fakeSupabase.setUserResponse(200, {
      id: '99999999-9999-9999-9999-999999999999',
    });
    const resMismatch = await request(app.getHttpServer())
      .post('/api/v1/probe/live')
      .set('Authorization', `Bearer ${validToken}`)
      .expect(401);
    expect(resMismatch.body.code).toBe('UNAUTHENTICATED');
    expect(resMismatch.body.message).toBe('Invalid or expired session.');
  });

  it('AC-B-19: Supabase timeout or network error fails closed', async () => {
    // Simulate timeout
    liveAuthService.setTimeoutMs(50);
    fakeSupabase.setDelayMs(200);

    const resTimeout = await request(app.getHttpServer())
      .post('/api/v1/probe/live')
      .set('Authorization', `Bearer ${validToken}`)
      .expect(401);
    expect(resTimeout.body.code).toBe('UNAUTHENTICATED');
    expect(resTimeout.body.message).toBe('Invalid or expired session.');

    // Reset delay and simulate 500 error
    fakeSupabase.setDelayMs(0);
    liveAuthService.setTimeoutMs(3000);
    fakeSupabase.setUserResponse(500, { message: 'Supabase 500 outage' });

    const res500 = await request(app.getHttpServer())
      .post('/api/v1/probe/live')
      .set('Authorization', `Bearer ${validToken}`)
      .expect(401);
    expect(res500.body.code).toBe('UNAUTHENTICATED');
    expect(res500.body.message).toBe('Invalid or expired session.');
  });

  it('AC-B-20: protected handler spy never called when the live check fails', async () => {
    fakeSupabase.setUserResponse(401, { message: 'Invalid session' });
    probeSpies.reset();

    const res = await request(app.getHttpServer())
      .post('/api/v1/probe/live')
      .set('Authorization', `Bearer ${validToken}`)
      .expect(401);

    expect(res.body.code).toBe('UNAUTHENTICATED');
    expect(probeSpies.liveHandler).toBe(0);
  });

  it('AC-B-21: expectLiveAuthRequired(route) fails for an undecorated route', () => {
    // Decorated route succeeds
    expect(() =>
      expectLiveAuthRequired(ProbeController.prototype, 'postLive'),
    ).not.toThrow();

    // Undecorated route throws
    expect(() =>
      expectLiveAuthRequired(ProbeController.prototype, 'getNoTenant'),
    ).toThrowError(/missing required @RequireLiveAuth\(\) decorator/);
  });
});
