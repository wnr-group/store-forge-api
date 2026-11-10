import { Inject, Injectable, Optional } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  createRemoteJWKSet,
  errors,
  jwtVerify,
  type JWTVerifyGetKey,
} from 'jose';
import { AppException } from '../../common/app.exception.js';
import type { AppConfig } from '../../config/configuration.js';

export const JWT_KEY_RESOLVER = Symbol('JWT_KEY_RESOLVER');

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function fullNameClaim(metadata: unknown): string | null {
  const name =
    typeof metadata === 'object' && metadata !== null
      ? (metadata as { full_name?: unknown }).full_name
      : null;
  return typeof name === 'string' && name ? name : null;
}

export interface VerifiedIdentity {
  id: string;
  email: string | null;
  /** Unix seconds. */
  expiresAt: number | undefined;
  /** `user_metadata.full_name` claim (kept in step with the profile on refresh); null when absent. */
  fullName: string | null;
}

/**
 * Verifies Supabase-issued access tokens. NestJS never issues tokens: it only checks that Supabase did.
 *
 * Checked on every token: signature (JWKS, or the shared HS256 secret for legacy projects), issuer
 * (`{SUPABASE_URL}/auth/v1`), audience (`authenticated`), expiry, a UUID `sub`, and `role = authenticated`
 * (so the public anon key, which is also a valid JWT, can never act as a user).
 */
@Injectable()
export class SupabaseJwtService {
  private readonly issuer: string;
  private readonly getKey: JWTVerifyGetKey;
  private readonly algorithms: string[];

  constructor(
    config: ConfigService<AppConfig, true>,
    @Optional() @Inject(JWT_KEY_RESOLVER) resolver?: JWTVerifyGetKey,
  ) {
    const {
      url,
      jwtSecret: secret,
      jwksUrl: configuredJwks,
    } = config.get('supabase', { infer: true });
    this.issuer = `${url}/auth/v1`;
    const jwksUrl = configuredJwks ?? `${this.issuer}/.well-known/jwks.json`;

    if (resolver) {
      this.getKey = resolver;
      this.algorithms = ['RS256', 'ES256', 'EdDSA', 'HS256'];
      return;
    }
    const jwks = createRemoteJWKSet(new URL(jwksUrl), {
      cooldownDuration: 30_000,
      cacheMaxAge: 10 * 60_000,
    });
    const hmacKey = secret ? new TextEncoder().encode(secret) : null;
    this.algorithms = hmacKey
      ? ['RS256', 'ES256', 'EdDSA', 'HS256']
      : ['RS256', 'ES256', 'EdDSA'];
    this.getKey = (header, token) =>
      (header.alg === 'HS256' && hmacKey
        ? Promise.resolve(hmacKey)
        : jwks(header, token)) as ReturnType<JWTVerifyGetKey>;
  }

  async verify(token: string): Promise<VerifiedIdentity> {
    try {
      const { payload } = await jwtVerify(token, this.getKey, {
        issuer: this.issuer,
        audience: 'authenticated',
        algorithms: this.algorithms,
        clockTolerance: 5,
      });
      if (typeof payload.sub !== 'string' || !UUID.test(payload.sub))
        throw new Error('invalid sub');
      if (payload.role !== 'authenticated')
        throw new Error('not an authenticated user token');
      if (payload.is_anonymous === true)
        throw new Error('anonymous users are not allowed');
      return {
        id: payload.sub,
        email: typeof payload.email === 'string' ? payload.email : null,
        expiresAt: typeof payload.exp === 'number' ? payload.exp : undefined,
        fullName: fullNameClaim(payload.user_metadata),
      };
    } catch (error) {
      if (error instanceof errors.JWTExpired) {
        throw new AppException(
          'UNAUTHENTICATED',
          'Your session has expired. Please sign in again.',
          { code: 'TOKEN_EXPIRED' },
        );
      }
      throw new AppException('UNAUTHENTICATED', 'Invalid access token.', {
        code: 'INVALID_TOKEN',
      });
    }
  }
}
