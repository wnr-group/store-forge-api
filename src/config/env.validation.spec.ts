import { describe, expect, it } from 'vitest';
import { buildConfig } from './configuration.js';
import { NodeEnv, validateEnv } from './env.validation.js';

const VALID_DEV_DB_URL =
  'postgresql://storeforge_app:secret@localhost:5432/postgres';

describe('validateEnv', () => {
  it('applies local-development defaults when valid DATABASE_URL is provided', () => {
    const env = validateEnv({ DATABASE_URL: VALID_DEV_DB_URL });
    expect(env.NODE_ENV).toBe(NodeEnv.Development);
    expect(env.PORT).toBe(4000);
    expect(env.API_PREFIX).toBe('api/v1');
    expect(env.CORS_ORIGINS).toBe('http://localhost:3000');
    expect(env.DB_POOL_MAX).toBe(5);
    expect(env.DB_PREPARE).toBe(false);
    expect(env.DB_CONNECT_TIMEOUT_SECONDS).toBe(10);
  });

  it('allows empty environment under NODE_ENV=test without DATABASE_URL', () => {
    const env = validateEnv({ NODE_ENV: NodeEnv.Test });
    expect(env.NODE_ENV).toBe(NodeEnv.Test);
    expect(env.DATABASE_URL).toBeUndefined();
    expect(env.DB_POOL_MAX).toBe(5);
    expect(env.DB_PREPARE).toBe(false);
    expect(env.DB_CONNECT_TIMEOUT_SECONDS).toBe(10);
  });

  it('converts PORT from a string to a number', () => {
    expect(
      validateEnv({ PORT: '5050', DATABASE_URL: VALID_DEV_DB_URL }).PORT,
    ).toBe(5050);
  });

  it('rejects an invalid NODE_ENV, naming the variable', () => {
    expect(() =>
      validateEnv({ NODE_ENV: 'staging', DATABASE_URL: VALID_DEV_DB_URL }),
    ).toThrow(/NODE_ENV/);
  });

  it('rejects a non-numeric or out-of-range PORT', () => {
    expect(() =>
      validateEnv({ PORT: 'abc', DATABASE_URL: VALID_DEV_DB_URL }),
    ).toThrow(/PORT/);
    expect(() =>
      validateEnv({ PORT: '70000', DATABASE_URL: VALID_DEV_DB_URL }),
    ).toThrow(/PORT/);
  });

  it('rejects an API_PREFIX with leading or trailing slashes', () => {
    expect(() =>
      validateEnv({ API_PREFIX: '/api/v1', DATABASE_URL: VALID_DEV_DB_URL }),
    ).toThrow(/API_PREFIX/);
    expect(() =>
      validateEnv({ API_PREFIX: 'api/v1/', DATABASE_URL: VALID_DEV_DB_URL }),
    ).toThrow(/API_PREFIX/);
  });

  it('rejects a wildcard CORS origin in production', () => {
    expect(() =>
      validateEnv({
        NODE_ENV: 'production',
        CORS_ORIGINS: '*',
        DATABASE_URL: VALID_DEV_DB_URL,
      }),
    ).toThrow(/CORS_ORIGINS/);
  });

  it('never includes the offending value in the error message', () => {
    expect(() =>
      validateEnv({
        PORT: 'super-secret-value',
        DATABASE_URL: VALID_DEV_DB_URL,
      }),
    ).not.toThrow(/super-secret-value/);
  });

  describe('DATABASE_URL validation (D-010, D-011, D-016)', () => {
    it('AC-A-06: accepts storeforge_app and storeforge_app.<ref>', () => {
      const urlDirect =
        'postgresql://storeforge_app:pass@db.local:5432/postgres';
      const urlPooler =
        'postgresql://storeforge_app.xrkwyjnjemyxrbdbfmcn:pass@aws-0-ap-south-1.pooler.supabase.com:6543/postgres';
      const urlPostgresScheme =
        'postgres://storeforge_app:pass@db.local:5432/postgres';

      expect(validateEnv({ DATABASE_URL: urlDirect }).DATABASE_URL).toBe(
        urlDirect,
      );
      expect(validateEnv({ DATABASE_URL: urlPooler }).DATABASE_URL).toBe(
        urlPooler,
      );
      expect(
        validateEnv({ DATABASE_URL: urlPostgresScheme }).DATABASE_URL,
      ).toBe(urlPostgresScheme);
    });

    it('AC-A-07: rejects postgres, postgres.<ref>, non-postgres scheme, missing (non-test)', () => {
      // Missing in non-test
      expect(() => validateEnv({ NODE_ENV: NodeEnv.Development })).toThrow(
        /DATABASE_URL/,
      );
      expect(() => validateEnv({ NODE_ENV: NodeEnv.Production })).toThrow(
        /DATABASE_URL/,
      );
      expect(() =>
        validateEnv({ NODE_ENV: NodeEnv.Development, DATABASE_URL: '' }),
      ).toThrow(/DATABASE_URL/);

      // Superuser postgres
      expect(() =>
        validateEnv({
          DATABASE_URL: 'postgresql://postgres:secret@host:5432/postgres',
        }),
      ).toThrow(/DATABASE_URL/);

      // Superuser postgres.<ref>
      expect(() =>
        validateEnv({
          DATABASE_URL:
            'postgresql://postgres.xrkwyjnjemyxrbdbfmcn:secret@host:6543/postgres',
        }),
      ).toThrow(/DATABASE_URL/);

      // Non-postgres scheme
      expect(() =>
        validateEnv({
          DATABASE_URL: 'mysql://storeforge_app:secret@host:3306/db',
        }),
      ).toThrow(/DATABASE_URL/);

      // Invalid URL format
      expect(() =>
        validateEnv({
          DATABASE_URL: 'not-a-valid-url',
        }),
      ).toThrow(/DATABASE_URL/);
    });

    it('AC-A-08: validation errors name the variable and never contain the value', () => {
      const canaryPassword = 'SuperSecretCanaryPassword123!';
      const invalidUrl = `postgresql://postgres:${encodeURIComponent(canaryPassword)}@host:5432/postgres`;

      try {
        validateEnv({ DATABASE_URL: invalidUrl });
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
      expect(validateEnv({ DATABASE_URL: url }).DATABASE_URL).toBe(url);
    });

    it('rejects case mismatch like STOREFORGE_APP', () => {
      expect(() =>
        validateEnv({
          DATABASE_URL: 'postgresql://STOREFORGE_APP:pass@host:5432/postgres',
        }),
      ).toThrow(/DATABASE_URL/);
    });
  });

  describe('DB pool configuration', () => {
    it('accepts valid pool parameters and transforms correctly', () => {
      const env = validateEnv({
        DATABASE_URL: VALID_DEV_DB_URL,
        DB_POOL_MAX: '10',
        DB_PREPARE: 'true',
        DB_CONNECT_TIMEOUT_SECONDS: '30',
      });
      expect(env.DB_POOL_MAX).toBe(10);
      expect(env.DB_PREPARE).toBe(true);
      expect(env.DB_CONNECT_TIMEOUT_SECONDS).toBe(30);
    });

    it('rejects DB_POOL_MAX of 0 or > 100', () => {
      expect(() =>
        validateEnv({
          DATABASE_URL: VALID_DEV_DB_URL,
          DB_POOL_MAX: '0',
        }),
      ).toThrow(/DB_POOL_MAX/);

      expect(() =>
        validateEnv({
          DATABASE_URL: VALID_DEV_DB_URL,
          DB_POOL_MAX: '101',
        }),
      ).toThrow(/DB_POOL_MAX/);
    });
  });
});

describe('buildConfig', () => {
  it('splits and trims CORS origins', () => {
    const config = buildConfig(
      validateEnv({
        CORS_ORIGINS: ' http://a.test , http://b.test ',
        DATABASE_URL: VALID_DEV_DB_URL,
      }),
    );
    expect(config.corsOrigins).toEqual(['http://a.test', 'http://b.test']);
  });

  it('enables Swagger outside production and disables it in production by default', () => {
    expect(
      buildConfig(
        validateEnv({
          NODE_ENV: 'development',
          DATABASE_URL: VALID_DEV_DB_URL,
        }),
      ).swaggerEnabled,
    ).toBe(true);
    expect(
      buildConfig(
        validateEnv({
          NODE_ENV: 'production',
          DATABASE_URL: VALID_DEV_DB_URL,
        }),
      ).swaggerEnabled,
    ).toBe(false);
  });

  it('lets SWAGGER_ENABLED override the default', () => {
    expect(
      buildConfig(
        validateEnv({
          NODE_ENV: 'production',
          SWAGGER_ENABLED: 'true',
          DATABASE_URL: VALID_DEV_DB_URL,
        }),
      ).swaggerEnabled,
    ).toBe(true);
    expect(
      buildConfig(
        validateEnv({
          NODE_ENV: 'development',
          SWAGGER_ENABLED: 'false',
          DATABASE_URL: VALID_DEV_DB_URL,
        }),
      ).swaggerEnabled,
    ).toBe(false);
  });

  it('maps database configuration correctly', () => {
    const config = buildConfig(
      validateEnv({
        DATABASE_URL: VALID_DEV_DB_URL,
        DB_POOL_MAX: '8',
        DB_PREPARE: 'true',
        DB_CONNECT_TIMEOUT_SECONDS: '15',
      }),
    );
    expect(config.database).toEqual({
      url: VALID_DEV_DB_URL,
      poolMax: 8,
      prepare: true,
      connectTimeoutSeconds: 15,
    });
  });
});
