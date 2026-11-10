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
  };
}

/** ConfigModule `load` factory. Defaults live only in EnvironmentVariables. */
export default (): AppConfig => buildConfig(validateEnv(process.env));
