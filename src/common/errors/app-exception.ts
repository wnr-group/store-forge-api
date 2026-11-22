import { HttpException, HttpStatus } from '@nestjs/common';
import { ErrorCode, type ErrorCodeType } from './error-codes.js';

export interface AppExceptionOptions {
  code: ErrorCodeType;
  message: string;
  fieldErrors?: Record<string, string>;
}

export class AppException extends HttpException {
  readonly code: ErrorCodeType;
  readonly fieldErrors?: Record<string, string>;

  constructor(status: HttpStatus, options: AppExceptionOptions) {
    super(
      {
        statusCode: status,
        message: options.message,
        code: options.code,
        ...(options.fieldErrors ? { fieldErrors: options.fieldErrors } : {}),
      },
      status,
    );
    this.code = options.code;
    this.fieldErrors = options.fieldErrors;
  }
}

export const unauthenticated = (message = 'Invalid or expired session.') =>
  new AppException(HttpStatus.UNAUTHORIZED, {
    code: ErrorCode.UNAUTHENTICATED,
    message,
  });

export const forbidden = (message = 'Forbidden.') =>
  new AppException(HttpStatus.FORBIDDEN, {
    code: ErrorCode.FORBIDDEN,
    message,
  });

export const validationFailed = (
  message: string,
  fieldErrors?: Record<string, string>,
) =>
  new AppException(HttpStatus.BAD_REQUEST, {
    code: ErrorCode.VALIDATION_FAILED,
    message,
    fieldErrors,
  });

export const notFound = (message = 'Not found.') =>
  new AppException(HttpStatus.NOT_FOUND, {
    code: ErrorCode.NOT_FOUND,
    message,
  });

export const conflict = (message: string) =>
  new AppException(HttpStatus.CONFLICT, {
    code: ErrorCode.CONFLICT,
    message,
  });

export const rateLimited = (message = 'Too many requests.') =>
  new AppException(HttpStatus.TOO_MANY_REQUESTS, {
    code: ErrorCode.RATE_LIMITED,
    message,
  });
