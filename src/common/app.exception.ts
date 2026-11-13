import { HttpException } from '@nestjs/common';
import {
  DEFAULT_ERROR_CODE,
  ERROR_STATUS,
  type ErrorKind,
} from './constants/error-codes.js';

/**
 * An error whose message is safe to show to API clients (port of the Next.js `AppError`).
 * `details` carries field errors (`{ slug: "This slug is already in use." }`) or other safe structured data.
 */
export class AppException extends HttpException {
  readonly kind: ErrorKind;
  readonly code: string;
  readonly details: unknown;

  constructor(
    kind: ErrorKind,
    message: string,
    options: { code?: string; details?: unknown } = {},
  ) {
    super(message, ERROR_STATUS[kind]);
    this.kind = kind;
    this.code = options.code ?? DEFAULT_ERROR_CODE[kind];
    this.details = options.details ?? null;
  }
}

export const notFound = (message: string, code = 'NOT_FOUND') =>
  new AppException('NOT_FOUND', message, { code });
export const forbidden = (
  message = 'You do not have permission to do that.',
  code = 'FORBIDDEN',
) => new AppException('FORBIDDEN', message, { code });
export const invalid = (
  message: string,
  fieldErrors?: Record<string, string>,
  code = 'VALIDATION_ERROR',
) =>
  new AppException('VALIDATION', message, {
    code,
    details: fieldErrors ?? null,
  });
export const conflict = (
  message: string,
  fieldErrors?: Record<string, string>,
  code = 'CONFLICT',
) =>
  new AppException('CONFLICT', message, { code, details: fieldErrors ?? null });
