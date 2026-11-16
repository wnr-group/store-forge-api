import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as jose from 'jose';
import { unauthenticated } from '../../common/errors/app-exception.js';
import type { AppConfig } from '../../config/configuration.js';
import type { AuthenticatedUser } from './auth.types.js';

const UUID_REGEX =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const COOLDOWN_MS = 5000;
const CACHE_TTL_MS = 10 * 60 * 1000; // 10 minutes

@Injectable()
export class JwksService {
  private readonly logger = new Logger(JwksService.name);
  private readonly issuer: string;
  private readonly jwksUrl: string;
  private readonly keyCache = new Map<
    string,
    { key: jose.CryptoKey; cachedAt: number }
  >();
  private lastUnknownKidRefetchTime = 0;

  constructor(private readonly config: ConfigService<AppConfig, true>) {
    const supabaseUrl = this.config.get('auth.supabaseUrl', { infer: true });
    this.issuer = `${supabaseUrl}/auth/v1`;
    this.jwksUrl = `${this.issuer}/.well-known/jwks.json`;

    // Test environment can provide inline test JWKS
    const testJwks = this.config.get('auth.testJwks', { infer: true });
    if (testJwks) {
      try {
        const parsed = JSON.parse(testJwks) as { keys: jose.JWK[] };
        this.loadJwks(parsed.keys).catch(() => {});
      } catch {
        // ignore malformed test JWKS
      }
    }
  }

  private async loadJwks(keys: jose.JWK[]): Promise<void> {
    for (const jwk of keys) {
      if (jwk.kid && jwk.alg === 'ES256') {
        try {
          const cryptoKey = (await jose.importJWK(
            jwk,
            'ES256',
          )) as jose.CryptoKey;
          this.keyCache.set(jwk.kid, {
            key: cryptoKey,
            cachedAt: Date.now(),
          });
        } catch (err) {
          this.logger.warn(
            `Failed to import JWK with kid ${jwk.kid}: ${String(err)}`,
          );
        }
      }
    }
  }

  /** Test-only helper to reset the unknown-kid cooldown. */
  resetCooldown(): void {
    this.lastUnknownKidRefetchTime = 0;
  }

  /**
   * Fetches JWKS keys from the Supabase endpoint.
   * If a fetch error occurs and cached keys exist, cached keys are retained (AC-B-14).
   * If no cached keys exist and fetch fails, fails closed (AC-B-13).
   */
  async fetchJwks(force = false): Promise<void> {
    if (!force && this.keyCache.size > 0) {
      const oldest = Math.min(
        ...Array.from(this.keyCache.values()).map((v) => v.cachedAt),
      );
      if (Date.now() - oldest < CACHE_TTL_MS) {
        return;
      }
    }

    try {
      const res = await fetch(this.jwksUrl);
      if (!res.ok) {
        throw new Error(`HTTP ${res.status} fetching JWKS`);
      }
      const data = (await res.json()) as { keys?: jose.JWK[] };
      if (!data.keys || !Array.isArray(data.keys)) {
        throw new Error('Invalid JWKS payload structure');
      }
      await this.loadJwks(data.keys);
    } catch (err) {
      this.logger.error(`JWKS fetch failure: ${String(err)}`);
      if (this.keyCache.size === 0) {
        throw unauthenticated(
          'Unable to verify token signature: JWKS unreachable.',
        );
      }
    }
  }

  /**
   * Verifies an incoming JWT token against the project JWKS keys (AC-B-01 to AC-B-15).
   */
  async verifyToken(token: string): Promise<AuthenticatedUser> {
    let header: jose.ProtectedHeaderParameters;
    try {
      header = jose.decodeProtectedHeader(token);
    } catch {
      throw unauthenticated('Invalid or malformed token.');
    }

    // AC-B-02, AC-B-03: only ES256 allowed (rejects none, HS256, etc.)
    if (header.alg !== 'ES256') {
      throw unauthenticated('Invalid token algorithm.');
    }

    if (!header.kid) {
      throw unauthenticated('Missing key ID in token header.');
    }

    let cached = this.keyCache.get(header.kid);

    // Initial load if cache is empty
    if (!cached && this.keyCache.size === 0) {
      try {
        await this.fetchJwks(true);
      } catch {
        // handled below if still not found
      }
      cached = this.keyCache.get(header.kid);
    }

    // AC-B-11, AC-B-12, AC-B-15: unknown kid triggers refetch respecting cooldown
    if (!cached) {
      const now = Date.now();
      if (now - this.lastUnknownKidRefetchTime >= COOLDOWN_MS) {
        this.lastUnknownKidRefetchTime = now;
        try {
          await this.fetchJwks(true);
        } catch {
          // fetchJwks logs error; check if key was found
        }
        cached = this.keyCache.get(header.kid);
        if (cached) {
          // Key was found (legitimate key rotation); clear unknown-kid cooldown
          this.lastUnknownKidRefetchTime = 0;
        }
      }
    }

    if (!cached) {
      throw unauthenticated('Invalid token: unknown or unrecognized key ID.');
    }

    let payload: jose.JWTPayload;
    try {
      const result = await jose.jwtVerify(token, cached.key, {
        issuer: this.issuer,
        audience: 'authenticated', // AC-B-06
      });
      payload = result.payload;
    } catch (err) {
      // AC-B-04, AC-B-05, AC-B-07: signature, issuer, expiry verification failures
      throw unauthenticated(
        `Invalid or expired session: ${(err as Error).message}`,
      );
    }

    // AC-B-08: sub must be a valid UUID
    if (typeof payload.sub !== 'string' || !UUID_REGEX.test(payload.sub)) {
      throw unauthenticated('Invalid token subject: sub must be a valid UUID.');
    }

    // AC-B-09: role must not be 'anon' or 'service_role'
    const role = typeof payload.role === 'string' ? payload.role : '';
    if (role === 'anon' || role === 'service_role' || role === '') {
      throw unauthenticated(`Unauthorized token role: ${role || 'missing'}.`);
    }

    return {
      userId: payload.sub,
      role,
      email: typeof payload.email === 'string' ? payload.email : undefined,
      appMetadata:
        typeof payload.app_metadata === 'object' &&
        payload.app_metadata !== null
          ? (payload.app_metadata as Record<string, unknown>)
          : undefined,
      userMetadata:
        typeof payload.user_metadata === 'object' &&
        payload.user_metadata !== null
          ? (payload.user_metadata as Record<string, unknown>)
          : undefined,
    };
  }
}
