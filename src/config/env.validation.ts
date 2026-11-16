import { plainToInstance, Transform } from 'class-transformer';
import {
  IsBoolean,
  IsEnum,
  IsInt,
  IsNotEmpty,
  IsOptional,
  IsString,
  Matches,
  Max,
  Min,
  validateSync,
} from 'class-validator';
import {
  compareProjectRefs,
  databaseProjectRef,
  supabaseProjectRef,
} from './project-ref.js';

export enum NodeEnv {
  Development = 'development',
  Production = 'production',
  Test = 'test',
}

const toBoolean = ({ value }: { value: unknown }) =>
  typeof value === 'string' ? value.trim().toLowerCase() === 'true' : value;

/**
 * Every environment variable the app reads. Add new variables here (and to
 * .env.example) so a misconfigured deployment fails at startup, not at runtime.
 */
export class EnvironmentVariables {
  @IsEnum(NodeEnv)
  NODE_ENV: NodeEnv = NodeEnv.Development;

  @Transform(({ value }) => (value === '' ? undefined : Number(value)))
  @IsInt()
  @Min(1)
  @Max(65535)
  PORT: number = 4000;

  @IsString()
  @Matches(/^[a-z0-9]([a-z0-9/_-]*[a-z0-9])?$/i, {
    message:
      'API_PREFIX must not start or end with "/" and may only contain letters, digits, "/", "_" and "-"',
  })
  API_PREFIX: string = 'api/v1';

  @IsString()
  @IsNotEmpty()
  CORS_ORIGINS: string = 'http://localhost:3000';

  @IsOptional()
  @Transform(toBoolean)
  @IsBoolean()
  SWAGGER_ENABLED?: boolean;

  @IsOptional()
  @IsString()
  DATABASE_URL?: string;

  @IsOptional()
  @Transform(({ value }) =>
    value === '' || value === undefined ? undefined : Number(value),
  )
  @IsInt()
  @Min(1)
  @Max(100)
  DB_POOL_MAX: number = 5;

  @IsOptional()
  @Transform(toBoolean)
  @IsBoolean()
  DB_PREPARE: boolean = false;

  @IsOptional()
  @Transform(({ value }) =>
    value === '' || value === undefined ? undefined : Number(value),
  )
  @IsInt()
  @Min(1)
  DB_CONNECT_TIMEOUT_SECONDS: number = 10;

  @IsOptional()
  @IsString()
  SUPABASE_URL?: string;

  @IsOptional()
  @IsString()
  SUPABASE_ANON_KEY?: string;

  @IsOptional()
  @Transform(({ value }) =>
    value === '' || value === undefined ? undefined : Number(value),
  )
  @IsInt()
  @Min(0)
  @Max(10)
  TRUST_PROXY: number = 0;

  @IsOptional()
  @Transform(({ value }) =>
    value === '' || value === undefined ? undefined : Number(value),
  )
  @IsInt()
  @Min(1)
  PUBLIC_RATE_LIMIT: number = 60;

  @IsOptional()
  @Transform(({ value }) =>
    value === '' || value === undefined ? undefined : Number(value),
  )
  @IsInt()
  @Min(1)
  PUBLIC_RATE_WINDOW_SECONDS: number = 60;

  @IsOptional()
  @Transform(({ value }) =>
    value === '' || value === undefined ? undefined : Number(value),
  )
  @IsInt()
  @Min(1)
  READY_RATE_LIMIT: number = 30;

  @IsOptional()
  @Transform(({ value }) =>
    value === '' || value === undefined ? undefined : Number(value),
  )
  @IsInt()
  @Min(1)
  READY_RATE_WINDOW_SECONDS: number = 60;

  @IsOptional()
  @Transform(({ value }) =>
    value === '' || value === undefined ? undefined : Number(value),
  )
  @IsInt()
  @Min(1)
  HEALTH_DB_TIMEOUT_MS: number = 3000;

  @IsOptional()
  @IsString()
  AUTH_TEST_JWKS?: string;
}

/**
 * Used by ConfigModule. Throws with the NAMES of invalid variables and the
 * reason, never their values, so a failed start cannot leak a secret into logs.
 */
export function validateEnv(
  config: Record<string, unknown>,
): EnvironmentVariables {
  const validated = plainToInstance(EnvironmentVariables, config, {
    exposeDefaultValues: true,
  });
  const errors = validateSync(validated, { skipMissingProperties: false });
  if (errors.length > 0) {
    const details = errors.map(
      (e) => `${e.property}: ${Object.values(e.constraints ?? {}).join(', ')}`,
    );
    throw new Error(
      `Invalid environment configuration - ${details.join('; ')}. See .env.example.`,
    );
  }

  if (
    validated.NODE_ENV === NodeEnv.Production &&
    validated.CORS_ORIGINS.split(',').some((o) => o.trim() === '*')
  ) {
    throw new Error(
      'Invalid environment configuration - CORS_ORIGINS: "*" is not allowed. List exact origins.',
    );
  }

  if (validated.NODE_ENV !== NodeEnv.Test) {
    if (!validated.DATABASE_URL || validated.DATABASE_URL.trim() === '') {
      throw new Error(
        'Invalid environment configuration - DATABASE_URL is required when NODE_ENV is not test. See .env.example.',
      );
    }
    if (!validated.SUPABASE_URL || validated.SUPABASE_URL.trim() === '') {
      throw new Error(
        'Invalid environment configuration - SUPABASE_URL is required when NODE_ENV is not test. See .env.example.',
      );
    }
    if (
      !validated.SUPABASE_ANON_KEY ||
      validated.SUPABASE_ANON_KEY.trim() === ''
    ) {
      throw new Error(
        'Invalid environment configuration - SUPABASE_ANON_KEY is required when NODE_ENV is not test. See .env.example.',
      );
    }
  }

  if (validated.SUPABASE_URL && validated.SUPABASE_URL.trim() !== '') {
    try {
      new URL(validated.SUPABASE_URL);
    } catch {
      throw new Error(
        'Invalid environment configuration - SUPABASE_URL is not a valid URL. See .env.example.',
      );
    }
  }

  if (
    validated.AUTH_TEST_JWKS &&
    validated.AUTH_TEST_JWKS.trim() !== '' &&
    validated.NODE_ENV !== NodeEnv.Test
  ) {
    throw new Error(
      'Invalid environment configuration - AUTH_TEST_JWKS is only allowed when NODE_ENV is test. See .env.example.',
    );
  }

  if (validated.DATABASE_URL && validated.DATABASE_URL.trim() !== '') {
    let parsedUrl: URL;
    try {
      parsedUrl = new URL(validated.DATABASE_URL);
    } catch {
      throw new Error(
        'Invalid environment configuration - DATABASE_URL is not a valid PostgreSQL connection URL. See .env.example.',
      );
    }

    if (
      parsedUrl.protocol !== 'postgres:' &&
      parsedUrl.protocol !== 'postgresql:'
    ) {
      throw new Error(
        'Invalid environment configuration - DATABASE_URL must use postgres: or postgresql: scheme. See .env.example.',
      );
    }

    const username = decodeURIComponent(parsedUrl.username);
    if (!/^storeforge_app(\..+)?$/.test(username)) {
      throw new Error(
        'Invalid environment configuration - DATABASE_URL username must match /^storeforge_app(\\..+)?$/ (must be storeforge_app or storeforge_app.<ref>). See .env.example.',
      );
    }
  }

  if (
    validated.DATABASE_URL &&
    validated.DATABASE_URL.trim() !== '' &&
    validated.SUPABASE_URL &&
    validated.SUPABASE_URL.trim() !== ''
  ) {
    const dbRef = databaseProjectRef(validated.DATABASE_URL);
    const sbRef = supabaseProjectRef(validated.SUPABASE_URL);
    const comparison = compareProjectRefs(dbRef, sbRef);
    if (comparison === 'mismatch') {
      throw new Error(
        'Invalid environment configuration - DATABASE_URL and SUPABASE_URL refer to different Supabase projects. See .env.example.',
      );
    }
    if (comparison === 'skipped') {
      console.warn(
        'Warning: Project reference cross-check skipped: unable to derive project ref from DATABASE_URL and/or SUPABASE_URL',
      );
    }
  }

  return validated;
}
