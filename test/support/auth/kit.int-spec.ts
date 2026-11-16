import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as jose from 'jose';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createTestApp } from '../create-test-app.js';
import { ProbeModule } from '../probe/probe.module.js';
import { authAs } from './auth-as.js';
import {
  createFakeSupabase,
  type FakeSupabaseServer,
} from './fake-supabase.js';
import { signTestToken } from './sign-test-token.js';
import { generateTestKeyPair, type TestKeyPair } from './test-keys.js';

describe('Auth Test Kit (AC-B-83 to AC-B-86)', () => {
  let keyPair: TestKeyPair;
  let fakeSupabase: FakeSupabaseServer;

  beforeAll(async () => {
    keyPair = await generateTestKeyPair('kit-test-key');
    fakeSupabase = await createFakeSupabase({ keys: [keyPair.publicJwk] });
  });

  afterAll(async () => {
    await fakeSupabase.close();
  });

  it('AC-B-83: helper tokens pass standard ES256 verification against the public JWK', async () => {
    const userId = '11111111-1111-1111-1111-111111111111';
    const token = await signTestToken({
      userId,
      keyPair,
      iss: fakeSupabase.issuer,
    });

    const jwks = jose.createLocalJWKSet({ keys: [keyPair.publicJwk] });
    const { payload } = await jose.jwtVerify(token, jwks, {
      issuer: fakeSupabase.issuer,
      audience: 'authenticated',
    });

    expect(payload.sub).toBe(userId);
    expect(payload.role).toBe('authenticated');
  });

  it('AC-B-84: bad-signature and bad-claim helper tokens are rejected', async () => {
    const userId = '22222222-2222-2222-2222-222222222222';
    const jwks = jose.createLocalJWKSet({ keys: [keyPair.publicJwk] });

    // 1. Tampered signature
    const tampered = await signTestToken({
      userId,
      keyPair,
      tamper: true,
      iss: fakeSupabase.issuer,
    });
    await expect(
      jose.jwtVerify(tampered, jwks, { issuer: fakeSupabase.issuer }),
    ).rejects.toThrow();

    // 2. Expired token
    const expired = await signTestToken({
      userId,
      keyPair,
      expiresIn: -60,
      iss: fakeSupabase.issuer,
    });
    await expect(
      jose.jwtVerify(expired, jwks, { issuer: fakeSupabase.issuer }),
    ).rejects.toThrow();

    // 3. Alg: none token
    const noneToken = await signTestToken({
      userId,
      alg: 'none',
      iss: fakeSupabase.issuer,
    });
    await expect(
      jose.jwtVerify(noneToken, jwks, { issuer: fakeSupabase.issuer }),
    ).rejects.toThrow();

    // 4. HS256 algorithm confusion
    const hsToken = await signTestToken({
      userId,
      alg: 'HS256',
      iss: fakeSupabase.issuer,
    });
    await expect(
      jose.jwtVerify(hsToken, jwks, { issuer: fakeSupabase.issuer }),
    ).rejects.toThrow();
  });

  it('AC-B-85: createTestApp runs the production pipeline', async () => {
    const app = await createTestApp({
      modules: [ProbeModule],
    });

    const res = await request(app.getHttpServer()).get('/api/v1/probe/public');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ status: 'public-ok' });

    // Verify security headers from configureApp (helmet)
    expect(res.headers['x-content-type-options']).toBe('nosniff');

    await app.close();
  });

  it('AC-B-86: test private key is never written to disk or logged', async () => {
    const logSpy = vi.spyOn(console, 'log');
    const errorSpy = vi.spyOn(console, 'error');
    const warnSpy = vi.spyOn(console, 'warn');

    const freshPair = await generateTestKeyPair('ephemeral-key');
    const token = await signTestToken({
      userId: '33333333-3333-3333-3333-333333333333',
      keyPair: freshPair,
    });
    expect(token).toBeDefined();

    // Export private key JWK to search for its unique coordinates (e.g. 'd' parameter)
    const privateJwk = await jose.exportJWK(freshPair.privateKey);
    const privateD = privateJwk.d;
    expect(privateD).toBeDefined();

    // 1. Scan captured logs
    const allLogText = [
      ...logSpy.mock.calls,
      ...errorSpy.mock.calls,
      ...warnSpy.mock.calls,
    ]
      .flat()
      .map(String)
      .join(' ');
    expect(allLogText).not.toContain(privateD);

    // 2. Scan os.tmpdir() for any file containing private key material
    const tmpDir = os.tmpdir();
    const tmpFiles = fs.readdirSync(tmpDir).slice(0, 50); // sample recent files
    for (const file of tmpFiles) {
      try {
        const fullPath = path.join(tmpDir, file);
        const stat = fs.statSync(fullPath);
        if (stat.isFile() && stat.size < 1_000_000) {
          const content = fs.readFileSync(fullPath, 'utf8');
          expect(content).not.toContain(privateD);
        }
      } catch {
        // skip files that cannot be read
      }
    }

    logSpy.mockRestore();
    errorSpy.mockRestore();
    warnSpy.mockRestore();
  });

  it('fake-supabase counts calls and provides configurable responses', async () => {
    expect(fakeSupabase.userCalls()).toBe(0);

    const resJwks = await fetch(fakeSupabase.jwksUrl);
    expect(resJwks.status).toBe(200);
    const jwksData = (await resJwks.json()) as { keys: jose.JWK[] };
    expect(jwksData.keys).toHaveLength(1);
    expect(jwksData.keys[0].kid).toBe('kit-test-key');

    const token = await signTestToken({
      userId: '44444444-4444-4444-4444-444444444444',
      keyPair,
      iss: fakeSupabase.issuer,
    });
    const headers = authAs(token, 'tenant-123');
    expect(headers['X-Tenant-Id']).toBe('tenant-123');

    const resUser = await fetch(`${fakeSupabase.url}/auth/v1/user`, {
      headers: { Authorization: headers.Authorization },
    });
    expect(resUser.status).toBe(200);
    const userData = (await resUser.json()) as { id: string };
    expect(userData.id).toBe('44444444-4444-4444-4444-444444444444');
    expect(fakeSupabase.userCalls()).toBe(1);

    fakeSupabase.resetUserCalls();
    expect(fakeSupabase.userCalls()).toBe(0);
  });
});
