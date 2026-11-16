import { describe, expect, it, vi } from 'vitest';
import { buildConfig } from './configuration.js';
import { NodeEnv, validateEnv } from './env.validation.js';

const VALID_DEV_DB_URL =
  'postgresql://storeforge_app:secret@localhost:5432/postgres';
const VALID_DEV_SUPABASE_URL = 'https://abc123.supabase.co';
const VALID_DEV_ANON_KEY = 'anon-key-secret';

const validDevEnv = (overrides: Record<string, unknown> = {}) => ({
  DATABASE_URL: VALID_DEV_DB_URL,
  SUPABASE_URL: VALID_DEV_SUPABASE_URL,
  SUPABASE_ANON_KEY: VALID_DEV_ANON_KEY,
  ...overrides,
});

describe('validateEnv', () => {
  it('applies local-development defaults when valid configuration is provided', () => {
    const env = validateEnv(validDevEnv());
    expect(env.NODE_ENV).toBe(NodeEnv.Development);
    expect(env.PORT).toBe(4000);
    expect(env.API_PREFIX).toBe('api/v1');
    expect(env.CORS_ORIGINS).toBe('http://localhost:3000');
    expect(env.DB_POOL_MAX).toBe(5);
    expect(env.DB_PREPARE).toBe(false);
    expect(env.DB_CONNECT_TIMEOUT_SECONDS).toBe(10);
    expect(env.TRUST_PROXY).toBe(0);
    expect(env.PUBLIC_RATE_LIMIT).toBe(60);
    expect(env.PUBLIC_RATE_WINDOW_SECONDS).toBe(60);
    expect(env.READY_RATE_LIMIT).toBe(30);
    expect(env.READY_RATE_WINDOW_SECONDS).toBe(60);
    expect(env.HEALTH_DB_TIMEOUT_MS).toBe(3000);
  });

  it('allows empty environment under NODE_ENV=test without DATABASE_URL or Supabase credentials', () => {
    const env = validateEnv({ NODE_ENV: NodeEnv.Test });
    expect(env.NODE_ENV).toBe(NodeEnv.Test);
    expect(env.DATABASE_URL).toBeUndefined();
    expect(env.SUPABASE_URL).toBeUndefined();
    expect(env.SUPABASE_ANON_KEY).toBeUndefined();
    expect(env.DB_POOL_MAX).toBe(5);
    expect(env.DB_PREPARE).toBe(false);
    expect(env.DB_CONNECT_TIMEOUT_SECONDS).toBe(10);
  });

  it('converts PORT from a string to a number', () => {
    expect(validateEnv(validDevEnv({ PORT: '5050' })).PORT).toBe(5050);
  });

  it('rejects an invalid NODE_ENV, naming the variable', () => {
    expect(() => validateEnv(validDevEnv({ NODE_ENV: 'staging' }))).toThrow(
      /NODE_ENV/,
    );
  });

  it('rejects a non-numeric or out-of-range PORT', () => {
    expect(() => validateEnv(validDevEnv({ PORT: 'abc' }))).toThrow(/PORT/);
    expect(() => validateEnv(validDevEnv({ PORT: '70000' }))).toThrow(/PORT/);
  });

  it('rejects an API_PREFIX with leading or trailing slashes', () => {
    expect(() => validateEnv(validDevEnv({ API_PREFIX: '/api/v1' }))).toThrow(
      /API_PREFIX/,
    );
    expect(() => validateEnv(validDevEnv({ API_PREFIX: 'api/v1/' }))).toThrow(
      /API_PREFIX/,
    );
  });

  it('rejects a wildcard CORS origin in production', () => {
    expect(() =>
      validateEnv(
        validDevEnv({
          NODE_ENV: 'production',
          CORS_ORIGINS: '*',
        }),
      ),
    ).toThrow(/CORS_ORIGINS/);
  });

  it('never includes the offending value in the error message', () => {
    expect(() =>
      validateEnv(validDevEnv({ PORT: 'super-secret-value' })),
    ).not.toThrow(/super-secret-value/);
  });

  describe('DATABASE_URL validation (D-010, D-011, D-016)', () => {
    it('AC-A-06: accepts storeforge_app and storeforge_app.<ref>', () => {
      const urlDirect =
        'postgresql://storeforge_app:pass@db.local:5432/postgres';
      const urlPooler =
        'postgresql://storeforge_app.abc123:pass@aws-0-ap-south-1.pooler.supabase.com:6543/postgres';
      const urlPostgresScheme =
        'postgres://storeforge_app:pass@db.local:5432/postgres';

      expect(
        validateEnv(validDevEnv({ DATABASE_URL: urlDirect })).DATABASE_URL,
      ).toBe(urlDirect);
      expect(
        validateEnv(
          validDevEnv({
            DATABASE_URL: urlPooler,
            SUPABASE_URL: 'https://abc123.supabase.co',
          }),
        ).DATABASE_URL,
      ).toBe(urlPooler);
      expect(
        validateEnv(validDevEnv({ DATABASE_URL: urlPostgresScheme }))
          .DATABASE_URL,
      ).toBe(urlPostgresScheme);
    });

    it('AC-A-07: rejects postgres, postgres.<ref>, non-postgres scheme, missing (non-test)', () => {
      // Missing in non-test
      expect(() =>
        validateEnv({
          NODE_ENV: NodeEnv.Development,
          SUPABASE_URL: VALID_DEV_SUPABASE_URL,
          SUPABASE_ANON_KEY: VALID_DEV_ANON_KEY,
        }),
      ).toThrow(/DATABASE_URL/);
      expect(() =>
        validateEnv({
          NODE_ENV: NodeEnv.Production,
          SUPABASE_URL: VALID_DEV_SUPABASE_URL,
          SUPABASE_ANON_KEY: VALID_DEV_ANON_KEY,
        }),
      ).toThrow(/DATABASE_URL/);
      expect(() => validateEnv(validDevEnv({ DATABASE_URL: '' }))).toThrow(
        /DATABASE_URL/,
      );

      // Superuser postgres
      expect(() =>
        validateEnv(
          validDevEnv({
            DATABASE_URL: 'postgresql://postgres:secret@host:5432/postgres',
          }),
        ),
      ).toThrow(/DATABASE_URL/);

      // Superuser postgres.<ref>
      expect(() =>
        validateEnv(
          validDevEnv({
            DATABASE_URL:
              'postgresql://postgres.xrkwyjnjemyxrbdbfmcn:secret@host:6543/postgres',
          }),
        ),
      ).toThrow(/DATABASE_URL/);

      // Non-postgres scheme
      expect(() =>
        validateEnv(
          validDevEnv({
            DATABASE_URL: 'mysql://storeforge_app:secret@host:3306/db',
          }),
        ),
      ).toThrow(/DATABASE_URL/);

      // Invalid URL format
      expect(() =>
        validateEnv(
          validDevEnv({
            DATABASE_URL: 'not-a-valid-url',
          }),
        ),
      ).toThrow(/DATABASE_URL/);
    });

    it('AC-A-08: validation errors name the variable and never contain the value', () => {
      const canaryPassword = 'SuperSecretCanaryPassword123!';
      const invalidUrl = `postgresql://postgres:${encodeURIComponent(canaryPassword)}@host:5432/postgres`;

      try {
        validateEnv(validDevEnv({ DATABASE_URL: invalidUrl }));
        expect.unreachable('Should have thrown an error');
      } catch (err: unknown) {
        const message = (err as Error).message;
        expect(message).toContain('DATABASE_URL');
        expect(message).not.toContain(canaryPassword);
        expect(message).not.toContain('postgres:');
      }
    });

    it('handles encoded characters in password correctly', () => {
      const url =
        'postgresql://storeforge_app:p%40ss%3Aword%21@localhost:5432/db';
      expect(validateEnv(validDevEnv({ DATABASE_URL: url })).DATABASE_URL).toBe(
        url,
      );
    });

    it('rejects case mismatch like STOREFORGE_APP', () => {
      expect(() =>
        validateEnv(
          validDevEnv({
            DATABASE_URL: 'postgresql://STOREFORGE_APP:pass@host:5432/postgres',
          }),
        ),
      ).toThrow(/DATABASE_URL/);
    });
  });

  describe('DB pool configuration', () => {
    it('accepts valid pool parameters and transforms correctly', () => {
      const env = validateEnv(
        validDevEnv({
          DB_POOL_MAX: '10',
          DB_PREPARE: 'true',
          DB_CONNECT_TIMEOUT_SECONDS: '30',
        }),
      );
      expect(env.DB_POOL_MAX).toBe(10);
      expect(env.DB_PREPARE).toBe(true);
      expect(env.DB_CONNECT_TIMEOUT_SECONDS).toBe(30);
    });

    it('rejects DB_POOL_MAX of 0 or > 100', () => {
      expect(() => validateEnv(validDevEnv({ DB_POOL_MAX: '0' }))).toThrow(
        /DB_POOL_MAX/,
      );

      expect(() => validateEnv(validDevEnv({ DB_POOL_MAX: '101' }))).toThrow(
        /DB_POOL_MAX/,
      );
    });
  });

  describe('Rate limit and trust proxy configuration (AC-B-71)', () => {
    it('AC-B-71: accepts valid custom rate limits and windows', () => {
      const env = validateEnv(
        validDevEnv({
          TRUST_PROXY: '3',
          PUBLIC_RATE_LIMIT: '100',
          PUBLIC_RATE_WINDOW_SECONDS: '120',
          READY_RATE_LIMIT: '50',
          READY_RATE_WINDOW_SECONDS: '30',
          HEALTH_DB_TIMEOUT_MS: '5000',
        }),
      );
      expect(env.TRUST_PROXY).toBe(3);
      expect(env.PUBLIC_RATE_LIMIT).toBe(100);
      expect(env.PUBLIC_RATE_WINDOW_SECONDS).toBe(120);
      expect(env.READY_RATE_LIMIT).toBe(50);
      expect(env.READY_RATE_WINDOW_SECONDS).toBe(30);
      expect(env.HEALTH_DB_TIMEOUT_MS).toBe(5000);
    });

    it('AC-B-71: rejects invalid TRUST_PROXY (-1, 1.5, abc, 11)', () => {
      expect(() => validateEnv(validDevEnv({ TRUST_PROXY: '-1' }))).toThrow(
        /TRUST_PROXY/,
      );
      expect(() => validateEnv(validDevEnv({ TRUST_PROXY: '1.5' }))).toThrow(
        /TRUST_PROXY/,
      );
      expect(() => validateEnv(validDevEnv({ TRUST_PROXY: 'abc' }))).toThrow(
        /TRUST_PROXY/,
      );
      expect(() => validateEnv(validDevEnv({ TRUST_PROXY: '11' }))).toThrow(
        /TRUST_PROXY/,
      );
    });

    it('AC-B-71: rejects rate limits or windows less than 1', () => {
      expect(() =>
        validateEnv(validDevEnv({ PUBLIC_RATE_LIMIT: '0' })),
      ).toThrow(/PUBLIC_RATE_LIMIT/);
      expect(() =>
        validateEnv(validDevEnv({ PUBLIC_RATE_WINDOW_SECONDS: '0' })),
      ).toThrow(/PUBLIC_RATE_WINDOW_SECONDS/);
      expect(() => validateEnv(validDevEnv({ READY_RATE_LIMIT: '0' }))).toThrow(
        /READY_RATE_LIMIT/,
      );
      expect(() =>
        validateEnv(validDevEnv({ READY_RATE_WINDOW_SECONDS: '0' })),
      ).toThrow(/READY_RATE_WINDOW_SECONDS/);
      expect(() =>
        validateEnv(validDevEnv({ HEALTH_DB_TIMEOUT_MS: '0' })),
      ).toThrow(/HEALTH_DB_TIMEOUT_MS/);
    });
  });

  describe('AUTH_TEST_JWKS validation (AC-B-82)', () => {
    it('AC-B-82: allows AUTH_TEST_JWKS under NODE_ENV=test', () => {
      const env = validateEnv({
        NODE_ENV: NodeEnv.Test,
        AUTH_TEST_JWKS: '{"keys":[]}',
      });
      expect(env.AUTH_TEST_JWKS).toBe('{"keys":[]}');
    });

    it('AC-B-82: fails startup naming AUTH_TEST_JWKS outside NODE_ENV=test', () => {
      expect(() =>
        validateEnv(
          validDevEnv({
            NODE_ENV: NodeEnv.Development,
            AUTH_TEST_JWKS: '{"keys":[]}',
          }),
        ),
      ).toThrow(/AUTH_TEST_JWKS/);

      expect(() =>
        validateEnv(
          validDevEnv({
            NODE_ENV: NodeEnv.Production,
            AUTH_TEST_JWKS: '{"keys":[]}',
          }),
        ),
      ).toThrow(/AUTH_TEST_JWKS/);
    });
  });

  describe('Supabase settings and project-ref cross checks (AC-B-88)', () => {
    it('AC-B-88: requires SUPABASE_URL and SUPABASE_ANON_KEY in non-test mode', () => {
      expect(() =>
        validateEnv({
          DATABASE_URL: VALID_DEV_DB_URL,
          SUPABASE_ANON_KEY: VALID_DEV_ANON_KEY,
        }),
      ).toThrow(/SUPABASE_URL/);

      expect(() =>
        validateEnv({
          DATABASE_URL: VALID_DEV_DB_URL,
          SUPABASE_URL: VALID_DEV_SUPABASE_URL,
        }),
      ).toThrow(/SUPABASE_ANON_KEY/);
    });

    it('AC-B-88: rejects invalid SUPABASE_URL format', () => {
      expect(() =>
        validateEnv(validDevEnv({ SUPABASE_URL: 'not-a-url' })),
      ).toThrow(/SUPABASE_URL/);
    });

    it('AC-B-88: passes when project refs match', () => {
      const env = validateEnv(
        validDevEnv({
          DATABASE_URL:
            'postgresql://storeforge_app.myproject:secret@pooler.supabase.com:6543/postgres',
          SUPABASE_URL: 'https://myproject.supabase.co',
        }),
      );
      expect(env.DATABASE_URL).toContain('myproject');
      expect(env.SUPABASE_URL).toBe('https://myproject.supabase.co');
    });

    it('AC-B-88: matches project refs case-insensitively', () => {
      const env = validateEnv(
        validDevEnv({
          DATABASE_URL:
            'postgresql://storeforge_app.MYPROJECT:secret@pooler.supabase.com:6543/postgres',
          SUPABASE_URL: 'https://myproject.supabase.co',
        }),
      );
      expect(env.SUPABASE_URL).toBe('https://myproject.supabase.co');
    });

    it('AC-B-88: fails startup when project refs mismatch without leaking values', () => {
      const secretRefA = 'projectalpha123';
      const secretRefB = 'projectbeta456';
      try {
        validateEnv(
          validDevEnv({
            DATABASE_URL: `postgresql://storeforge_app.${secretRefA}:secret@pooler.supabase.com:6543/postgres`,
            SUPABASE_URL: `https://${secretRefB}.supabase.co`,
          }),
        );
        expect.unreachable('Should have thrown mismatch error');
      } catch (err: unknown) {
        const message = (err as Error).message;
        expect(message).toContain(
          'DATABASE_URL and SUPABASE_URL refer to different Supabase projects',
        );
        expect(message).not.toContain(secretRefA);
        expect(message).not.toContain(secretRefB);
      }
    });

    it('AC-B-88: skips check with warning when project ref is not derivable', () => {
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
      const env = validateEnv(
        validDevEnv({
          DATABASE_URL:
            'postgresql://storeforge_app:secret@localhost:5432/postgres',
          SUPABASE_URL: 'https://custom-domain.example.com',
        }),
      );
      expect(env.DATABASE_URL).toBeDefined();
      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining('Project reference cross-check skipped'),
      );
      warnSpy.mockRestore();
    });
  });
});

describe('buildConfig', () => {
  it('splits and trims CORS origins', () => {
    const config = buildConfig(
      validateEnv(
        validDevEnv({
          CORS_ORIGINS: ' http://a.test , http://b.test ',
        }),
      ),
    );
    expect(config.corsOrigins).toEqual(['http://a.test', 'http://b.test']);
  });

  it('enables Swagger outside production and disables it in production by default', () => {
    expect(
      buildConfig(
        validateEnv(
          validDevEnv({
            NODE_ENV: 'development',
          }),
        ),
      ).swaggerEnabled,
    ).toBe(true);
    expect(
      buildConfig(
        validateEnv(
          validDevEnv({
            NODE_ENV: 'production',
          }),
        ),
      ).swaggerEnabled,
    ).toBe(false);
  });

  it('lets SWAGGER_ENABLED override the default', () => {
    expect(
      buildConfig(
        validateEnv(
          validDevEnv({
            NODE_ENV: 'production',
            SWAGGER_ENABLED: 'true',
          }),
        ),
      ).swaggerEnabled,
    ).toBe(true);
    expect(
      buildConfig(
        validateEnv(
          validDevEnv({
            NODE_ENV: 'development',
            SWAGGER_ENABLED: 'false',
          }),
        ),
      ).swaggerEnabled,
    ).toBe(false);
  });

  it('maps database, auth, rateLimit, and health configuration correctly', () => {
    const config = buildConfig(
      validateEnv(
        validDevEnv({
          DB_POOL_MAX: '8',
          DB_PREPARE: 'true',
          DB_CONNECT_TIMEOUT_SECONDS: '15',
          TRUST_PROXY: '2',
          PUBLIC_RATE_LIMIT: '50',
          PUBLIC_RATE_WINDOW_SECONDS: '45',
          READY_RATE_LIMIT: '25',
          READY_RATE_WINDOW_SECONDS: '50',
          HEALTH_DB_TIMEOUT_MS: '4000',
        }),
      ),
    );
    expect(config.database).toEqual({
      url: VALID_DEV_DB_URL,
      poolMax: 8,
      prepare: true,
      connectTimeoutSeconds: 15,
    });
    expect(config.auth).toEqual({
      supabaseUrl: VALID_DEV_SUPABASE_URL,
      supabaseAnonKey: VALID_DEV_ANON_KEY,
      testJwks: undefined,
    });
    expect(config.rateLimit).toEqual({
      trustProxy: 2,
      publicLimit: 50,
      publicWindowSeconds: 45,
      readyLimit: 25,
      readyWindowSeconds: 50,
    });
    expect(config.health).toEqual({
      dbTimeoutMs: 4000,
    });
  });
});
