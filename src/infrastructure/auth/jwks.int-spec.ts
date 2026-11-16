import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
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
import { ProbeModule } from '../../../test/support/probe/probe.module.js';
import { AuthModule } from './auth.module.js';
import { JwksService } from './jwks.service.js';

describe('JWKS Service and Auth Guard (AC-B-01 to AC-B-15, JWT)', () => {
  let app: INestApplication;
  let fakeSupabase: FakeSupabaseServer;
  let keyPair1: TestKeyPair;
  let keyPair2: TestKeyPair;
  const validUserId = '11111111-1111-1111-1111-111111111111';

  beforeAll(async () => {
    keyPair1 = await generateTestKeyPair('key-1');
    keyPair2 = await generateTestKeyPair('key-2');
    fakeSupabase = await createFakeSupabase({ keys: [keyPair1.publicJwk] });

    process.env.SUPABASE_URL = fakeSupabase.url;
    process.env.SUPABASE_ANON_KEY = 'test-anon-key';

    app = await createTestApp({
      modules: [AuthModule, ProbeModule],
    });
  });

  afterAll(async () => {
    await app.close();
    await fakeSupabase.close();
  });

  it('AC-B-01: valid ES256 token is accepted; userId = sub', async () => {
    const token = await signTestToken({
      userId: validUserId,
      keyPair: keyPair1,
      iss: fakeSupabase.issuer,
    });

    const res = await request(app.getHttpServer())
      .get('/api/v1/probe/no-tenant')
      .set('Authorization', `Bearer ${token}`)
      .expect(200);

    expect(res.body.status).toBe('no-tenant');
    expect(res.body.auth.userId).toBe(validUserId);
    expect(res.body.auth.role).toBe('authenticated');
  });

  it('AC-B-02: HS256 token signed with public key material is rejected', async () => {
    const token = await signTestToken({
      userId: validUserId,
      alg: 'HS256',
      iss: fakeSupabase.issuer,
    });

    const res = await request(app.getHttpServer())
      .get('/api/v1/probe/no-tenant')
      .set('Authorization', `Bearer ${token}`)
      .expect(401);

    expect(res.body.code).toBe('UNAUTHENTICATED');
  });

  it('AC-B-03: alg: none is rejected', async () => {
    const token = await signTestToken({
      userId: validUserId,
      alg: 'none',
      iss: fakeSupabase.issuer,
    });

    const res = await request(app.getHttpServer())
      .get('/api/v1/probe/no-tenant')
      .set('Authorization', `Bearer ${token}`)
      .expect(401);

    expect(res.body.code).toBe('UNAUTHENTICATED');
  });

  it('AC-B-04: tampered signature is rejected', async () => {
    const token = await signTestToken({
      userId: validUserId,
      keyPair: keyPair1,
      tamper: true,
      iss: fakeSupabase.issuer,
    });

    const res = await request(app.getHttpServer())
      .get('/api/v1/probe/no-tenant')
      .set('Authorization', `Bearer ${token}`)
      .expect(401);

    expect(res.body.code).toBe('UNAUTHENTICATED');
  });

  it('AC-B-05: wrong issuer is rejected', async () => {
    const token = await signTestToken({
      userId: validUserId,
      keyPair: keyPair1,
      iss: 'https://impostor.supabase.co/auth/v1',
    });

    const res = await request(app.getHttpServer())
      .get('/api/v1/probe/no-tenant')
      .set('Authorization', `Bearer ${token}`)
      .expect(401);

    expect(res.body.code).toBe('UNAUTHENTICATED');
  });

  it('AC-B-06: wrong audience is rejected', async () => {
    const token = await signTestToken({
      userId: validUserId,
      keyPair: keyPair1,
      aud: 'wrong-audience',
      iss: fakeSupabase.issuer,
    });

    const res = await request(app.getHttpServer())
      .get('/api/v1/probe/no-tenant')
      .set('Authorization', `Bearer ${token}`)
      .expect(401);

    expect(res.body.code).toBe('UNAUTHENTICATED');
  });

  it('AC-B-07: expired token is rejected (and valid right before expiry)', async () => {
    // Expired by 10s
    const expiredToken = await signTestToken({
      userId: validUserId,
      keyPair: keyPair1,
      expiresIn: -10,
      iss: fakeSupabase.issuer,
    });

    const resExpired = await request(app.getHttpServer())
      .get('/api/v1/probe/no-tenant')
      .set('Authorization', `Bearer ${expiredToken}`)
      .expect(401);
    expect(resExpired.body.code).toBe('UNAUTHENTICATED');

    // Valid for 60s
    const validToken = await signTestToken({
      userId: validUserId,
      keyPair: keyPair1,
      expiresIn: 60,
      iss: fakeSupabase.issuer,
    });

    const resValid = await request(app.getHttpServer())
      .get('/api/v1/probe/no-tenant')
      .set('Authorization', `Bearer ${validToken}`)
      .expect(200);
    expect(resValid.body.auth.userId).toBe(validUserId);
  });

  it('AC-B-08: non-UUID sub is rejected', async () => {
    const token = await signTestToken({
      userId: 'not-a-valid-uuid',
      keyPair: keyPair1,
      iss: fakeSupabase.issuer,
    });

    const res = await request(app.getHttpServer())
      .get('/api/v1/probe/no-tenant')
      .set('Authorization', `Bearer ${token}`)
      .expect(401);

    expect(res.body.code).toBe('UNAUTHENTICATED');
  });

  it('AC-B-09: role anon and service_role are rejected', async () => {
    // anon role
    const anonToken = await signTestToken({
      userId: validUserId,
      keyPair: keyPair1,
      role: 'anon',
      iss: fakeSupabase.issuer,
    });

    const resAnon = await request(app.getHttpServer())
      .get('/api/v1/probe/no-tenant')
      .set('Authorization', `Bearer ${anonToken}`)
      .expect(401);
    expect(resAnon.body.code).toBe('UNAUTHENTICATED');

    // service_role
    const serviceRoleToken = await signTestToken({
      userId: validUserId,
      keyPair: keyPair1,
      role: 'service_role',
      iss: fakeSupabase.issuer,
    });

    const resService = await request(app.getHttpServer())
      .get('/api/v1/probe/no-tenant')
      .set('Authorization', `Bearer ${serviceRoleToken}`)
      .expect(401);
    expect(resService.body.code).toBe('UNAUTHENTICATED');
  });

  it('AC-B-10: missing or malformed Authorization gives 401 UNAUTHENTICATED', async () => {
    // Missing header
    const resMissing = await request(app.getHttpServer())
      .get('/api/v1/probe/no-tenant')
      .expect(401);
    expect(resMissing.body.code).toBe('UNAUTHENTICATED');

    // Non-Bearer scheme
    const resBasic = await request(app.getHttpServer())
      .get('/api/v1/probe/no-tenant')
      .set('Authorization', 'Basic dXNlcjpwYXNz')
      .expect(401);
    expect(resBasic.body.code).toBe('UNAUTHENTICATED');

    // Empty Bearer token
    const resEmpty = await request(app.getHttpServer())
      .get('/api/v1/probe/no-tenant')
      .set('Authorization', 'Bearer ')
      .expect(401);
    expect(resEmpty.body.code).toBe('UNAUTHENTICATED');
  });

  it('AC-B-11: unknown kid triggers JWKS refetch; rotated key then accepted', async () => {
    // Token signed with rotated key2 (currently not in JWKS)
    const tokenRotated = await signTestToken({
      userId: validUserId,
      keyPair: keyPair2,
      kid: 'key-2',
      iss: fakeSupabase.issuer,
    });

    // Update fakeSupabase JWKS endpoint with rotated key
    fakeSupabase.setJwks([keyPair1.publicJwk, keyPair2.publicJwk]);

    // Request triggers refetch and succeeds
    const res = await request(app.getHttpServer())
      .get('/api/v1/probe/no-tenant')
      .set('Authorization', `Bearer ${tokenRotated}`)
      .expect(200);

    expect(res.body.auth.userId).toBe(validUserId);
  });

  it('AC-B-12: persistently unknown kid is rejected', async () => {
    const unknownPair = await generateTestKeyPair('never-registered-key');
    const token = await signTestToken({
      userId: validUserId,
      keyPair: unknownPair,
      kid: 'never-registered-key',
      iss: fakeSupabase.issuer,
    });

    const res = await request(app.getHttpServer())
      .get('/api/v1/probe/no-tenant')
      .set('Authorization', `Bearer ${token}`)
      .expect(401);

    expect(res.body.code).toBe('UNAUTHENTICATED');
  });

  it('AC-B-14: cached key still verifies during a brief JWKS outage', async () => {
    // keyPair1 is cached from earlier calls
    const token = await signTestToken({
      userId: validUserId,
      keyPair: keyPair1,
      iss: fakeSupabase.issuer,
    });

    // Simulate JWKS outage (500)
    fakeSupabase.setJwksResponse(500, { error: 'JWKS endpoint down' });

    // Verifies against cache without failing
    const res = await request(app.getHttpServer())
      .get('/api/v1/probe/no-tenant')
      .set('Authorization', `Bearer ${token}`)
      .expect(200);

    expect(res.body.auth.userId).toBe(validUserId);

    // Restore JWKS
    fakeSupabase.setJwks([keyPair1.publicJwk, keyPair2.publicJwk]);
  });

  it('AC-B-13: JWKS unreachable and nothing cached: rejected (fail closed)', async () => {
    app.get(JwksService).resetCooldown();
    const newPair = await generateTestKeyPair('outage-key');
    const token = await signTestToken({
      userId: validUserId,
      keyPair: newPair,
      kid: 'outage-key',
      iss: fakeSupabase.issuer,
    });

    // Simulate JWKS outage for unknown key
    fakeSupabase.setJwksResponse(500, { error: 'JWKS endpoint down' });

    const res = await request(app.getHttpServer())
      .get('/api/v1/probe/no-tenant')
      .set('Authorization', `Bearer ${token}`)
      .expect(401);

    expect(res.body.code).toBe('UNAUTHENTICATED');

    fakeSupabase.setJwks([keyPair1.publicJwk, keyPair2.publicJwk]);
  });

  it('AC-B-15: repeated unknown kid refetches at most once per cooldown', async () => {
    app.get(JwksService).resetCooldown();
    fakeSupabase.resetJwksCalls();

    const unknownPair = await generateTestKeyPair('cooldown-key');
    const token = await signTestToken({
      userId: validUserId,
      keyPair: unknownPair,
      kid: 'cooldown-key',
      iss: fakeSupabase.issuer,
    });

    // Send first request with unknown kid: triggers 1 refetch
    await request(app.getHttpServer())
      .get('/api/v1/probe/no-tenant')
      .set('Authorization', `Bearer ${token}`)
      .expect(401);

    expect(fakeSupabase.jwksCalls()).toBe(1);

    // Send second rapid request: cooldown prevents second refetch
    const res2 = await request(app.getHttpServer())
      .get('/api/v1/probe/no-tenant')
      .set('Authorization', `Bearer ${token}`)
      .expect(401);

    expect(res2.body.code).toBe('UNAUTHENTICATED');
    expect(fakeSupabase.jwksCalls()).toBe(1);
  });
});
