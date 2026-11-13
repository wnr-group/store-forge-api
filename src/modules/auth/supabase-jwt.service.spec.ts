import type { ConfigService } from '@nestjs/config';
import { SignJWT } from 'jose';
import { SupabaseJwtService } from './supabase-jwt.service.js';

const URL_ = 'https://proj.supabase.co';
const ISSUER = `${URL_}/auth/v1`;
const SUB = '11111111-1111-4111-8111-111111111111';
const SECRET = 'a-legacy-shared-secret-of-32-bytes!!';

const config = (jwtSecret?: string) =>
  ({
    get: () => ({
      url: URL_,
      anonKey: 'x'.repeat(30),
      serviceRoleKey: 'y'.repeat(30),
      jwtSecret,
    }),
  }) as unknown as ConfigService<never, true>;

const hs256 = (
  claims: Record<string, unknown> = {},
  secret = SECRET,
  expires: string | number = '1h',
) =>
  new SignJWT({ role: 'authenticated', email: 'a@b.test', ...claims })
    .setProtectedHeader({ alg: 'HS256' })
    .setSubject(SUB)
    .setIssuer(ISSUER)
    .setAudience('authenticated')
    .setExpirationTime(expires)
    .sign(new TextEncoder().encode(secret));

describe('SupabaseJwtService (legacy HS256 projects)', () => {
  it('verifies a token signed with the shared secret and returns the identity', async () => {
    const svc = new SupabaseJwtService(config(SECRET));
    await expect(svc.verify(await hs256())).resolves.toEqual({
      id: SUB,
      email: 'a@b.test',
    });
  });

  it('refuses HS256 tokens when no shared secret is configured (algorithm confusion)', async () => {
    const svc = new SupabaseJwtService(config(undefined));
    await expect(svc.verify(await hs256())).rejects.toMatchObject({
      code: 'INVALID_TOKEN',
    });
  });

  it('refuses a token signed with a different secret', async () => {
    const svc = new SupabaseJwtService(config(SECRET));
    await expect(
      svc.verify(await hs256({}, 'another-secret-another-secret-12345')),
    ).rejects.toMatchObject({ code: 'INVALID_TOKEN' });
  });

  it('refuses the unsigned "none" algorithm', async () => {
    const svc = new SupabaseJwtService(config(SECRET));
    const none = Buffer.from(
      JSON.stringify({ alg: 'none', typ: 'JWT' }),
    ).toString('base64url');
    const body = Buffer.from(
      JSON.stringify({
        sub: SUB,
        role: 'authenticated',
        iss: ISSUER,
        aud: 'authenticated',
        exp: 9999999999,
      }),
    ).toString('base64url');
    await expect(svc.verify(`${none}.${body}.`)).rejects.toMatchObject({
      code: 'INVALID_TOKEN',
    });
  });

  it('distinguishes an expired token so clients can refresh and retry', async () => {
    const svc = new SupabaseJwtService(config(SECRET));
    const expired = await hs256(
      {},
      SECRET,
      Math.floor(Date.now() / 1000) - 3600,
    );
    await expect(svc.verify(expired)).rejects.toMatchObject({
      code: 'TOKEN_EXPIRED',
      status: 401,
    });
  });

  it('rejects the anon / service roles and anonymous users', async () => {
    const svc = new SupabaseJwtService(config(SECRET));
    for (const claims of [
      { role: 'anon' },
      { role: 'service_role' },
      { is_anonymous: true },
    ])
      await expect(
        svc.verify(await hs256(claims)),
        JSON.stringify(claims),
      ).rejects.toMatchObject({ code: 'INVALID_TOKEN' });
  });

  it('treats a missing email as null rather than failing', async () => {
    const svc = new SupabaseJwtService(config(SECRET));
    const token = await new SignJWT({ role: 'authenticated' })
      .setProtectedHeader({ alg: 'HS256' })
      .setSubject(SUB)
      .setIssuer(ISSUER)
      .setAudience('authenticated')
      .setExpirationTime('1h')
      .sign(new TextEncoder().encode(SECRET));
    await expect(svc.verify(token)).resolves.toEqual({ id: SUB, email: null });
  });
});
