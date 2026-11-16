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
  database: {
    url: string;
    poolMax: number;
    prepare: boolean;
    connectTimeoutSeconds: number;
  };
  auth: {
    supabaseUrl: string;
    supabaseAnonKey: string;
    testJwks?: string;
  };
  rateLimit: {
    trustProxy: number;
    publicLimit: number;
    publicWindowSeconds: number;
    readyLimit: number;
    readyWindowSeconds: number;
  };
  health: {
    dbTimeoutMs: number;
  };
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
    database: {
      url: env.DATABASE_URL ?? '',
      poolMax: env.DB_POOL_MAX,
      prepare: env.DB_PREPARE,
      connectTimeoutSeconds: env.DB_CONNECT_TIMEOUT_SECONDS,
    },
    auth: {
      supabaseUrl: env.SUPABASE_URL ?? '',
      supabaseAnonKey: env.SUPABASE_ANON_KEY ?? '',
      testJwks: env.AUTH_TEST_JWKS,
    },
    rateLimit: {
      trustProxy: env.TRUST_PROXY,
      publicLimit: env.PUBLIC_RATE_LIMIT,
      publicWindowSeconds: env.PUBLIC_RATE_WINDOW_SECONDS,
      readyLimit: env.READY_RATE_LIMIT,
      readyWindowSeconds: env.READY_RATE_WINDOW_SECONDS,
    },
    health: {
      dbTimeoutMs: env.HEALTH_DB_TIMEOUT_MS,
    },
  };
}

/** ConfigModule `load` factory. Defaults live only in EnvironmentVariables. */
export default (): AppConfig => buildConfig(validateEnv(process.env));
