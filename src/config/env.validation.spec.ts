import { buildConfig } from './configuration.js';
import { NodeEnv, validateEnv } from './env.validation.js';

describe('validateEnv', () => {
  it('applies local-development defaults for an empty environment', () => {
    const env = validateEnv({});
    expect(env.NODE_ENV).toBe(NodeEnv.Development);
    expect(env.PORT).toBe(4000);
    expect(env.API_PREFIX).toBe('api/v1');
    expect(env.CORS_ORIGINS).toBe('http://localhost:3000');
  });

  it('converts PORT from a string to a number', () => {
    expect(validateEnv({ PORT: '5050' }).PORT).toBe(5050);
  });

  it('rejects an invalid NODE_ENV, naming the variable', () => {
    expect(() => validateEnv({ NODE_ENV: 'staging' })).toThrow(/NODE_ENV/);
  });

  it('rejects a non-numeric or out-of-range PORT', () => {
    expect(() => validateEnv({ PORT: 'abc' })).toThrow(/PORT/);
    expect(() => validateEnv({ PORT: '70000' })).toThrow(/PORT/);
  });

  it('rejects an API_PREFIX with leading or trailing slashes', () => {
    expect(() => validateEnv({ API_PREFIX: '/api/v1' })).toThrow(/API_PREFIX/);
    expect(() => validateEnv({ API_PREFIX: 'api/v1/' })).toThrow(/API_PREFIX/);
  });

  it('rejects a wildcard CORS origin in production', () => {
    expect(() =>
      validateEnv({ NODE_ENV: 'production', CORS_ORIGINS: '*' }),
    ).toThrow(/CORS_ORIGINS/);
  });

  it('never includes the offending value in the error message', () => {
    expect(() => validateEnv({ PORT: 'super-secret-value' })).not.toThrow(
      /super-secret-value/,
    );
  });
});

describe('buildConfig', () => {
  it('splits and trims CORS origins', () => {
    const config = buildConfig(
      validateEnv({ CORS_ORIGINS: ' http://a.test , http://b.test ' }),
    );
    expect(config.corsOrigins).toEqual(['http://a.test', 'http://b.test']);
  });

  it('enables Swagger outside production and disables it in production by default', () => {
    expect(
      buildConfig(validateEnv({ NODE_ENV: 'development' })).swaggerEnabled,
    ).toBe(true);
    expect(
      buildConfig(validateEnv({ NODE_ENV: 'production' })).swaggerEnabled,
    ).toBe(false);
  });

  it('lets SWAGGER_ENABLED override the default', () => {
    expect(
      buildConfig(
        validateEnv({ NODE_ENV: 'production', SWAGGER_ENABLED: 'true' }),
      ).swaggerEnabled,
    ).toBe(true);
    expect(
      buildConfig(
        validateEnv({ NODE_ENV: 'development', SWAGGER_ENABLED: 'false' }),
      ).swaggerEnabled,
    ).toBe(false);
  });
});
