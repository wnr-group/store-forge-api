import { AppException } from '../app.exception.js';
import { DEFAULT_ERROR_CODE, ERROR_STATUS } from './error-codes.js';

/** AC-REG-14: the new kind is purely additive. These are the mappings that existed before it. */
const EXISTING_STATUS = {
  UNAUTHENTICATED: 401,
  FORBIDDEN: 403,
  NOT_FOUND: 404,
  VALIDATION: 400,
  CONFLICT: 409,
  RATE_LIMITED: 429,
  UNKNOWN: 500,
} as const;

const EXISTING_CODE = {
  UNAUTHENTICATED: 'UNAUTHENTICATED',
  FORBIDDEN: 'FORBIDDEN',
  NOT_FOUND: 'NOT_FOUND',
  VALIDATION: 'VALIDATION_ERROR',
  CONFLICT: 'CONFLICT',
  RATE_LIMITED: 'RATE_LIMITED',
  UNKNOWN: 'INTERNAL_ERROR',
} as const;

describe('error kinds', () => {
  it('keeps every existing kind exactly as it was', () => {
    for (const [kind, status] of Object.entries(EXISTING_STATUS))
      expect(ERROR_STATUS[kind as keyof typeof EXISTING_STATUS], kind).toBe(
        status,
      );
    for (const [kind, code] of Object.entries(EXISTING_CODE))
      expect(DEFAULT_ERROR_CODE[kind as keyof typeof EXISTING_CODE], kind).toBe(
        code,
      );
  });

  it('adds exactly one kind, UNAVAILABLE, and nothing else', () => {
    expect(Object.keys(ERROR_STATUS).sort()).toEqual(
      [...Object.keys(EXISTING_STATUS), 'UNAVAILABLE'].sort(),
    );
    expect(Object.keys(DEFAULT_ERROR_CODE).sort()).toEqual(
      Object.keys(ERROR_STATUS).sort(),
    );
    expect(ERROR_STATUS.UNAVAILABLE).toBe(503);
    expect(DEFAULT_ERROR_CODE.UNAVAILABLE).toBe('SERVICE_UNAVAILABLE');
  });

  it('an UNAVAILABLE exception answers 503 and carries the specific code it is given', () => {
    const plain = new AppException('UNAVAILABLE', 'Try again later.');
    expect(plain.getStatus()).toBe(503);
    expect(plain.code).toBe('SERVICE_UNAVAILABLE');

    const payments = new AppException(
      'UNAVAILABLE',
      'Payment settings are temporarily unavailable. Please contact support.',
      { code: 'PAYMENTS_UNAVAILABLE' },
    );
    expect(payments.getStatus()).toBe(503);
    expect(payments.code).toBe('PAYMENTS_UNAVAILABLE');
    expect(payments.details).toBeNull();
  });

  it('existing exceptions still answer with their old statuses', () => {
    expect(new AppException('FORBIDDEN', 'x').getStatus()).toBe(403);
    expect(new AppException('VALIDATION', 'x').getStatus()).toBe(400);
    expect(new AppException('RATE_LIMITED', 'x').getStatus()).toBe(429);
  });
});
