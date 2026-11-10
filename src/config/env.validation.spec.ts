import { TEST_ENV } from '../../test/support/test-env.js';
import { buildConfig } from './configuration.js';
import { NodeEnv, validateEnv } from './env.validation.js';

describe('validateEnv', () => {
  it('applies local-development defaults for an empty environment', () => {
    const env = validateEnv({ ...TEST_ENV });
    expect(env.NODE_ENV).toBe(NodeEnv.Development);
    expect(env.PORT).toBe(4000);
    expect(env.API_PREFIX).toBe('api/v1');
    expect(env.CORS_ORIGINS).toBe('http://localhost:3000');
  });

  it('converts PORT from a string to a number', () => {
    expect(validateEnv({ ...TEST_ENV, PORT: '5050' }).PORT).toBe(5050);
  });

  it('rejects an invalid NODE_ENV, naming the variable', () => {
    expect(() => validateEnv({ ...TEST_ENV, NODE_ENV: 'staging' })).toThrow(
      /NODE_ENV/,
    );
  });

  it('rejects a non-numeric or out-of-range PORT', () => {
    expect(() => validateEnv({ ...TEST_ENV, PORT: 'abc' })).toThrow(/PORT/);
    expect(() => validateEnv({ ...TEST_ENV, PORT: '70000' })).toThrow(/PORT/);
  });

  it('rejects an API_PREFIX with leading or trailing slashes', () => {
    expect(() => validateEnv({ ...TEST_ENV, API_PREFIX: '/api/v1' })).toThrow(
      /API_PREFIX/,
    );
    expect(() => validateEnv({ ...TEST_ENV, API_PREFIX: 'api/v1/' })).toThrow(
      /API_PREFIX/,
    );
  });

  it('rejects a wildcard CORS origin in production', () => {
    expect(() =>
      validateEnv({ ...TEST_ENV, NODE_ENV: 'production', CORS_ORIGINS: '*' }),
    ).toThrow(/CORS_ORIGINS/);
  });

  it('never includes the offending value in the error message', () => {
    expect(() =>
      validateEnv({ ...TEST_ENV, PORT: 'super-secret-value' }),
    ).not.toThrow(/super-secret-value/);
  });
});

describe('buildConfig', () => {
  it('splits and trims CORS origins', () => {
    const config = buildConfig(
      validateEnv({
        ...TEST_ENV,
        CORS_ORIGINS: ' http://a.test , http://b.test ',
      }),
    );
    expect(config.corsOrigins).toEqual(['http://a.test', 'http://b.test']);
  });

  it('enables Swagger outside production and disables it in production by default', () => {
    expect(
      buildConfig(validateEnv({ ...TEST_ENV, NODE_ENV: 'development' }))
        .swaggerEnabled,
    ).toBe(true);
    expect(
      buildConfig(validateEnv({ ...TEST_ENV, NODE_ENV: 'production' }))
        .swaggerEnabled,
    ).toBe(false);
  });

  it('lets SWAGGER_ENABLED override the default', () => {
    expect(
      buildConfig(
        validateEnv({
          ...TEST_ENV,
          NODE_ENV: 'production',
          SWAGGER_ENABLED: 'true',
        }),
      ).swaggerEnabled,
    ).toBe(true);
    expect(
      buildConfig(
        validateEnv({
          ...TEST_ENV,
          NODE_ENV: 'development',
          SWAGGER_ENABLED: 'false',
        }),
      ).swaggerEnabled,
    ).toBe(false);
  });
});

describe('validateEnv - Supabase and database settings', () => {
  it('requires the Supabase and database variables, naming them', () => {
    expect(() => validateEnv({})).toThrow(/SUPABASE_URL/);
    expect(() => validateEnv({})).toThrow(/DATABASE_URL/);
  });

  it('refuses a DATABASE_URL that connects as the postgres owner role (it bypasses RLS)', () => {
    for (const url of [
      'postgresql://postgres:pw@db.example.supabase.co:5432/postgres',
      'postgresql://postgres.abcdref:pw@aws-0.pooler.supabase.com:6543/postgres',
    ]) {
      expect(() => validateEnv({ ...TEST_ENV, DATABASE_URL: url })).toThrow(
        /storeforge_app/,
      );
    }
  });

  it('treats empty optional values as unset and defaults the JWKS URL later', () => {
    const env = validateEnv({
      ...TEST_ENV,
      SUPABASE_JWKS_URL: '',
      SUPABASE_JWT_SECRET: '',
    });
    expect(env.SUPABASE_JWKS_URL).toBeUndefined();
    expect(env.SUPABASE_JWT_SECRET).toBeUndefined();
  });

  it('never prints secret values when validation fails', () => {
    expect(() =>
      validateEnv({ ...TEST_ENV, SUPABASE_SERVICE_ROLE_KEY: 'short-secret' }),
    ).not.toThrow(/short-secret/);
  });

  it('maps to AppConfig without a trailing slash on the Supabase URL', () => {
    const config = buildConfig(
      validateEnv({ ...TEST_ENV, SUPABASE_URL: 'https://x.supabase.co/' }),
    );
    expect(config.supabase.url).toBe('https://x.supabase.co');
    expect(config.throttle).toEqual({ ttlMs: 60_000, limit: 120 });
  });
});
