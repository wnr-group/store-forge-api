/** Coarse error kinds (same set as the Next.js app's AppError) and the HTTP status each maps to. */
export const ERROR_STATUS = {
  UNAUTHENTICATED: 401,
  FORBIDDEN: 403,
  NOT_FOUND: 404,
  VALIDATION: 400,
  CONFLICT: 409,
  RATE_LIMITED: 429,
  UNKNOWN: 500,
} as const;

export type ErrorKind = keyof typeof ERROR_STATUS;

/** Default machine-readable code per kind; specific cases pass their own (e.g. PRODUCT_NOT_FOUND). */
export const DEFAULT_ERROR_CODE: Record<ErrorKind, string> = {
  UNAUTHENTICATED: 'UNAUTHENTICATED',
  FORBIDDEN: 'FORBIDDEN',
  NOT_FOUND: 'NOT_FOUND',
  VALIDATION: 'VALIDATION_ERROR',
  CONFLICT: 'CONFLICT',
  RATE_LIMITED: 'RATE_LIMITED',
  UNKNOWN: 'INTERNAL_ERROR',
};

export const ORGANIZATION_HEADER = 'x-organization-id';
