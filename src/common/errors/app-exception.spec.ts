import { HttpStatus } from '@nestjs/common';
import { describe, expect, it } from 'vitest';
import {
  AppException,
  conflict,
  forbidden,
  notFound,
  rateLimited,
  unauthenticated,
  validationFailed,
} from './app-exception.js';
import { ErrorCode, STATUS_TO_ERROR_CODE } from './error-codes.js';

describe('AppException and ErrorCodes (AC-B-39, AC-B-41)', () => {
  it('AC-B-39: seven codes map to exact statuses', () => {
    expect(STATUS_TO_ERROR_CODE[400]).toBe(ErrorCode.VALIDATION_FAILED);
    expect(STATUS_TO_ERROR_CODE[401]).toBe(ErrorCode.UNAUTHENTICATED);
    expect(STATUS_TO_ERROR_CODE[403]).toBe(ErrorCode.FORBIDDEN);
    expect(STATUS_TO_ERROR_CODE[404]).toBe(ErrorCode.NOT_FOUND);
    expect(STATUS_TO_ERROR_CODE[409]).toBe(ErrorCode.CONFLICT);
    expect(STATUS_TO_ERROR_CODE[429]).toBe(ErrorCode.RATE_LIMITED);
    expect(STATUS_TO_ERROR_CODE[500]).toBe(ErrorCode.UNKNOWN);

    expect(unauthenticated().getStatus()).toBe(HttpStatus.UNAUTHORIZED);
    expect(unauthenticated().code).toBe(ErrorCode.UNAUTHENTICATED);

    expect(forbidden().getStatus()).toBe(HttpStatus.FORBIDDEN);
    expect(forbidden().code).toBe(ErrorCode.FORBIDDEN);

    expect(validationFailed('bad').getStatus()).toBe(HttpStatus.BAD_REQUEST);
    expect(validationFailed('bad').code).toBe(ErrorCode.VALIDATION_FAILED);

    expect(notFound().getStatus()).toBe(HttpStatus.NOT_FOUND);
    expect(notFound().code).toBe(ErrorCode.NOT_FOUND);

    expect(conflict('dup').getStatus()).toBe(HttpStatus.CONFLICT);
    expect(conflict('dup').code).toBe(ErrorCode.CONFLICT);

    expect(rateLimited().getStatus()).toBe(HttpStatus.TOO_MANY_REQUESTS);
    expect(rateLimited().code).toBe(ErrorCode.RATE_LIMITED);

    const generic500 = new AppException(HttpStatus.INTERNAL_SERVER_ERROR, {
      code: ErrorCode.UNKNOWN,
      message: 'Unknown error',
    });
    expect(generic500.getStatus()).toBe(HttpStatus.INTERNAL_SERVER_ERROR);
    expect(generic500.code).toBe(ErrorCode.UNKNOWN);
  });

  it('AC-B-41: fieldErrors is present only when provided', () => {
    const withoutFieldErrors = validationFailed('Invalid payload');
    expect(withoutFieldErrors.fieldErrors).toBeUndefined();

    const withFieldErrors = validationFailed('Invalid payload', {
      email: 'Must be an email',
    });
    expect(withFieldErrors.fieldErrors).toEqual({
      email: 'Must be an email',
    });
  });
});
