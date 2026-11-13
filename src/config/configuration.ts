import {
  NodeEnv,
  validateEnv,
  type EnvironmentVariables,
} from './env.validation.js';

/** Typed, centralized application configuration. Read it through ConfigService<AppConfig, true>. */
export interface AppConfig {
  env: NodeEnv;
  port: number;
  apiPrefix: string;
  corsOrigins: string[];
  swaggerEnabled: boolean;
  supabase: {
    url: string;
    anonKey: string;
    serviceRoleKey: string;
    jwksUrl?: string;
    jwtSecret?: string;
  };
  auth: { bffSecret?: string; rateLimitSecret?: string };
  databaseUrl: string;
  database: {
    url: string;
    poolMax: number;
    prepare: boolean;
    connectTimeoutSeconds: number;
  };
  throttle: { ttlMs: number; limit: number };
}

/** Pure mapping from validated environment variables to AppConfig. */
export function buildConfig(env: EnvironmentVariables): AppConfig {
  return {
    env: env.NODE_ENV,
    port: env.PORT,
    apiPrefix: env.API_PREFIX,
    corsOrigins: env.CORS_ORIGINS.split(',')
      .map((origin) => origin.trim())
      .filter(Boolean),
    // Swagger is on by default except in production, where it must be enabled explicitly.
    swaggerEnabled: env.SWAGGER_ENABLED ?? env.NODE_ENV !== NodeEnv.Production,
    supabase: {
      url: env.SUPABASE_URL.replace(/\/$/, ''),
      anonKey: env.SUPABASE_ANON_KEY,
      serviceRoleKey: env.SUPABASE_SERVICE_ROLE_KEY,
      jwksUrl: env.SUPABASE_JWKS_URL,
      jwtSecret: env.SUPABASE_JWT_SECRET,
    },
    auth: {
      bffSecret: env.AUTH_BFF_SECRET,
      rateLimitSecret: env.RATE_LIMIT_SECRET,
    },
    databaseUrl: env.DATABASE_URL,
    database: {
      url: env.DATABASE_URL,
      poolMax: env.DB_POOL_MAX,
      prepare: env.DB_PREPARE,
      connectTimeoutSeconds: env.DB_CONNECT_TIMEOUT_SECONDS,
    },
    throttle: {
      ttlMs: env.THROTTLE_TTL_SECONDS * 1000,
      limit: env.THROTTLE_LIMIT,
    },
  };
}

/** ConfigModule `load` factory. Defaults live only in EnvironmentVariables. */
export default (): AppConfig => buildConfig(validateEnv(process.env));
