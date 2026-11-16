import * as jose from 'jose';
import { getDefaultTestKeyPair, type TestKeyPair } from './test-keys.js';

export interface SignTestTokenOptions {
  userId: string;
  role?: string;
  aud?: string;
  iss?: string;
  kid?: string;
  alg?: string;
  expiresIn?: string | number;
  claims?: Record<string, unknown>;
  keyPair?: TestKeyPair;
  tamper?: boolean;
  hmacKey?: string | Uint8Array;
}

export async function signTestToken(
  options: SignTestTokenOptions,
): Promise<string> {
  const alg = options.alg ?? 'ES256';

  // Support for alg: 'none' (AC-B-03)
  if (alg === 'none') {
    const header = Buffer.from(
      JSON.stringify({ alg: 'none', typ: 'JWT' }),
    ).toString('base64url');
    const now = Math.floor(Date.now() / 1000);
    const exp =
      typeof options.expiresIn === 'number'
        ? now + options.expiresIn
        : now + 3600;
    const payload = Buffer.from(
      JSON.stringify({
        sub: options.userId,
        role: options.role ?? 'authenticated',
        aud: options.aud ?? 'authenticated',
        iss: options.iss ?? 'https://test.supabase.co/auth/v1',
        iat: now,
        exp,
        ...options.claims,
      }),
    ).toString('base64url');
    return `${header}.${payload}.`;
  }

  // Support for HS256 algorithm confusion (AC-B-02)
  if (alg === 'HS256') {
    const secret =
      options.hmacKey instanceof Uint8Array
        ? options.hmacKey
        : new TextEncoder().encode(
            typeof options.hmacKey === 'string'
              ? options.hmacKey
              : 'public-key-material',
          );
    const jwt = new jose.SignJWT({
      role: options.role ?? 'authenticated',
      ...options.claims,
    })
      .setProtectedHeader({
        alg: 'HS256',
        typ: 'JWT',
        kid: options.kid ?? 'test-key-1',
      })
      .setSubject(options.userId)
      .setAudience(options.aud ?? 'authenticated')
      .setIssuer(options.iss ?? 'https://test.supabase.co/auth/v1')
      .setIssuedAt();

    if (typeof options.expiresIn === 'number') {
      jwt.setExpirationTime(Math.floor(Date.now() / 1000) + options.expiresIn);
    } else {
      jwt.setExpirationTime(options.expiresIn ?? '1h');
    }

    return await jwt.sign(secret);
  }

  // Standard ES256 signing
  const keyPair = options.keyPair ?? (await getDefaultTestKeyPair());
  const jwt = new jose.SignJWT({
    role: options.role ?? 'authenticated',
    ...options.claims,
  })
    .setProtectedHeader({
      alg: 'ES256',
      typ: 'JWT',
      kid: options.kid ?? keyPair.kid,
    })
    .setSubject(options.userId)
    .setAudience(options.aud ?? 'authenticated')
    .setIssuer(options.iss ?? 'https://test.supabase.co/auth/v1')
    .setIssuedAt();

  if (typeof options.expiresIn === 'number') {
    jwt.setExpirationTime(Math.floor(Date.now() / 1000) + options.expiresIn);
  } else {
    jwt.setExpirationTime(options.expiresIn ?? '1h');
  }

  const token = await jwt.sign(keyPair.privateKey);

  if (options.tamper) {
    const parts = token.split('.');
    const lastChar = parts[2].slice(-1);
    const replacement = lastChar === 'a' ? 'b' : 'a';
    parts[2] = parts[2].slice(0, -1) + replacement;
    return parts.join('.');
  }

  return token;
}
