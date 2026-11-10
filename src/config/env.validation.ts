import { plainToInstance, Transform } from 'class-transformer';
import {
  IsBoolean,
  IsEnum,
  IsInt,
  IsNotEmpty,
  IsOptional,
  IsString,
  IsUrl,
  Matches,
  Max,
  Min,
  MinLength,
  validateSync,
} from 'class-validator';

export enum NodeEnv {
  Development = 'development',
  Production = 'production',
  Test = 'test',
}

/** The only login role the API may use (created by the Next.js repo's migration drizzle/0004_app_role.sql). */
export const APP_DB_ROLE = 'storeforge_app';

/** Unset variables and empty strings (`VAR=` in .env) both mean "not set". */
const emptyToUndefined = ({ value }: { value: unknown }) =>
  value === '' ? undefined : value;

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

  // --- Supabase Auth ---------------------------------------------------------------------------
  @IsUrl({ require_tld: false, protocols: ['http', 'https'] })
  SUPABASE_URL!: string;

  @IsString()
  @MinLength(20)
  SUPABASE_ANON_KEY!: string;

  /** Auth Admin API only (create/delete users, set passwords). Never used for database queries. */
  @IsString()
  @MinLength(20)
  SUPABASE_SERVICE_ROLE_KEY!: string;

  /** Defaults to `${SUPABASE_URL}/auth/v1/.well-known/jwks.json`. */
  @IsOptional()
  @Transform(emptyToUndefined)
  @IsUrl({ require_tld: false, protocols: ['http', 'https'] })
  SUPABASE_JWKS_URL?: string;

  /** Only for legacy projects that still sign access tokens with a shared HS256 secret. */
  @IsOptional()
  @Transform(emptyToUndefined)
  @IsString()
  @MinLength(16)
  SUPABASE_JWT_SECRET?: string;

  // --- Session / BFF ---------------------------------------------------------------------------
  /**
   * Shared secret of the trusted server-side caller (the Next.js app, which relays the session cookies). Sent as
   * `X-Internal-Auth`. Without it a caller cannot supply the client address used for login rate limiting, and a
   * request without a browser `Origin` is refused on the cookie-session routes.
   */
  @IsOptional()
  @Transform(emptyToUndefined)
  @IsString()
  @MinLength(32)
  AUTH_BFF_SECRET?: string;

  /** Keys the hashes behind login rate limiting. Defaults to the service-role key (which never leaves the server). */
  @IsOptional()
  @Transform(emptyToUndefined)
  @IsString()
  @MinLength(16)
  RATE_LIMIT_SECRET?: string;

  // --- PostgreSQL ------------------------------------------------------------------------------
  @IsString()
  @Matches(/^postgres(ql)?:\/\//, {
    message: 'DATABASE_URL must be a postgres:// or postgresql:// URL',
  })
  DATABASE_URL!: string;

  // --- Rate limiting (global default; sensitive routes set their own) -------------------------
  @Transform(({ value }) => (value === '' ? undefined : Number(value)))
  @IsInt()
  @Min(1)
  THROTTLE_TTL_SECONDS: number = 60;

  @Transform(({ value }) => (value === '' ? undefined : Number(value)))
  @IsInt()
  @Min(1)
  THROTTLE_LIMIT: number = 120;
}

/**
 * Defence in depth: ordinary queries must never run as the owner role, which BYPASSES row level security.
 * Supavisor prefixes the project ref, so the user looks like "<role>.<ref>".
 */
export function privilegedDatabaseUserProblem(url: string): string | null {
  try {
    const user = decodeURIComponent(new URL(url).username);
    if (user === 'postgres' || user.startsWith('postgres.'))
      return `DATABASE_URL: must connect as the ${APP_DB_ROLE} role, not the postgres owner role (which bypasses row level security)`;
    return null;
  } catch {
    return 'DATABASE_URL: not a valid URL';
  }
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
  const roleProblem = privilegedDatabaseUserProblem(validated.DATABASE_URL);
  if (roleProblem)
    throw new Error(`Invalid environment configuration - ${roleProblem}.`);
  if (
    validated.NODE_ENV === NodeEnv.Production &&
    validated.CORS_ORIGINS.split(',').some((o) => o.trim() === '*')
  ) {
    throw new Error(
      'Invalid environment configuration - CORS_ORIGINS: "*" is not allowed. List exact origins.',
    );
  }
  return validated;
}
