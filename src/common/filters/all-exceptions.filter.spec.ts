import {
  BadRequestException,
  ForbiddenException,
  HttpException,
  Logger,
  ServiceUnavailableException,
  type ArgumentsHost,
} from '@nestjs/common';
import { ThrottlerException } from '@nestjs/throttler';
import { HealthController } from '../../modules/health/health.controller.js';
import type { HealthService } from '../../modules/health/health.service.js';
import { AppException } from '../app.exception.js';
import { ERROR_STATUS } from '../constants/error-codes.js';
import { mapDbError } from '../db-errors.js';
import { AllExceptionsFilter } from './all-exceptions.filter.js';

function run(exception: unknown, url = '/api/v1/products/123?token=secret') {
  let status = 0;
  let body: Record<string, unknown> = {};
  const host = {
    switchToHttp: () => ({
      getRequest: () => ({ originalUrl: url, method: 'GET' }),
      getResponse: () => ({
        status: (s: number) => {
          status = s;
          return { json: (b: Record<string, unknown>) => (body = b) };
        },
      }),
    }),
  } as unknown as ArgumentsHost;
  new AllExceptionsFilter().catch(exception, host);
  return { status, body };
}

describe('AllExceptionsFilter', () => {
  beforeAll(() => {
    // The filter logs unexpected errors on purpose; keep the test output readable.
    Logger.overrideLogger(false);
  });

  it('formats AppExceptions in the standard error envelope', () => {
    const { status, body } = run(
      new AppException('NOT_FOUND', 'Product not found', {
        code: 'PRODUCT_NOT_FOUND',
      }),
    );
    expect(status).toBe(404);
    expect(body).toMatchObject({
      success: false,
      message: 'Product not found',
      error: { code: 'PRODUCT_NOT_FOUND', details: null },
      path: '/api/v1/products/123',
    });
    expect(new Date(body.timestamp as string).toString()).not.toBe(
      'Invalid Date',
    );
  });

  it('maps every kind to its HTTP status', () => {
    const cases = {
      UNAUTHENTICATED: 401,
      FORBIDDEN: 403,
      NOT_FOUND: 404,
      VALIDATION: 400,
      CONFLICT: 409,
      RATE_LIMITED: 429,
      UNKNOWN: 500,
    } as const;
    for (const [kind, expected] of Object.entries(cases))
      expect(
        run(new AppException(kind as keyof typeof cases, 'x')).status,
        kind,
      ).toBe(expected);
  });

  it('turns class-validator failures into VALIDATION_ERROR with the list in details', () => {
    const { status, body } = run(
      new BadRequestException(['name must be a string', 'price is required']),
    );
    expect(status).toBe(400);
    expect(body.error).toEqual({
      code: 'VALIDATION_ERROR',
      details: ['name must be a string', 'price is required'],
    });
  });

  it('keeps messages of plain Nest HTTP errors but gives them stable codes', () => {
    const { status, body } = run(new ForbiddenException('Nope'));
    expect(status).toBe(403);
    expect(body).toMatchObject({
      message: 'Nope',
      error: { code: 'FORBIDDEN' },
    });
  });

  it('reports throttling as RATE_LIMITED', () => {
    expect(run(new ThrottlerException())).toMatchObject({
      status: 429,
      body: { error: { code: 'RATE_LIMITED' } },
    });
  });

  it('never leaks database errors or stack traces: unknown errors become a generic 500', () => {
    const leak = Object.assign(
      new Error(
        'duplicate key value violates unique constraint "pg_internal_idx" at db.secret.host:5432',
      ),
      {
        stack:
          'Error: ... at /srv/app/node_modules/postgres/src/connection.js:1',
      },
    );
    const { status, body } = run(leak);
    expect(status).toBe(500);
    expect(body.message).toBe('Something went wrong. Please try again.');
    expect(JSON.stringify(body)).not.toMatch(
      /duplicate key|pg_internal|secret|node_modules|postgres/,
    );
  });

  it('translates known constraint violations into safe, specific conflicts', () => {
    const cause = new Error(
      'duplicate key value violates unique constraint "customers_tenant_id_email_key"',
    );
    const { status, body } = run(
      Object.assign(new Error('Failed query: insert into customers ...'), {
        cause,
      }),
    );
    expect(status).toBe(409);
    expect(body).toMatchObject({
      message: 'A customer with that email already exists.',
      error: {
        code: 'CUSTOMER_EMAIL_TAKEN',
        details: {
          email: 'A customer with this email address already exists.',
        },
      },
    });
    expect(JSON.stringify(body)).not.toContain('Failed query');
  });

  it('maps row level security and permission errors to 403', () => {
    expect(
      run(
        new Error(
          'new row violates row-level security policy for table "products"',
        ),
      ).status,
    ).toBe(403);
    expect(
      run(new Error('permission denied for table platform_admins')).status,
    ).toBe(403);
  });

  it('drops the query string from the reported path', () => {
    expect(
      run(new HttpException('x', 418), '/api/v1/x?password=hunter2').body.path,
    ).toBe('/api/v1/x');
  });
});

describe('AllExceptionsFilter: the generic 5xx error log', () => {
  const errorLog = () =>
    vi.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('still logs an UNKNOWN (500) AppException once, with its stack, exactly as before', () => {
    const spy = errorLog();
    const exception = new AppException('UNKNOWN', 'Something failed.');
    const { status } = run(exception);
    expect(status).toBe(500);
    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy).toHaveBeenCalledWith(
      'Unhandled exception on GET /api/v1/products/123',
      exception.stack,
    );
  });

  it('still logs an unexpected error once, with its stack, exactly as before', () => {
    const spy = errorLog();
    const failure = new Error('boom');
    const { status, body } = run(failure);
    expect(status).toBe(500);
    expect(body.message).toBe('Something went wrong. Please try again.');
    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy).toHaveBeenCalledWith(
      'Unhandled exception on GET /api/v1/products/123',
      failure.stack,
    );
  });

  it('still logs the health readiness 503 once, with its stack, exactly as before', async () => {
    const spy = errorLog();
    const controller = new HealthController({
      readiness: () =>
        Promise.resolve({
          status: 'ok',
          service: 'store-forge-api',
          database: 'down',
        }),
    } as unknown as HealthService);
    let thrown: unknown;
    try {
      await controller.ready();
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toBeInstanceOf(ServiceUnavailableException);

    const { status, body } = run(thrown);
    expect(status).toBe(503);
    expect(body.error).toEqual({ code: 'HTTP_503', details: null });
    expect(body.message).toBe('Something went wrong. Please try again.');
    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy).toHaveBeenCalledWith(
      'Unhandled exception on GET /api/v1/products/123',
      (thrown as Error).stack,
    );
  });

  it('adds no generic error log for an UNAVAILABLE AppException, and still answers 503 with its own code', () => {
    const spy = errorLog();
    const { status, body } = run(
      new AppException(
        'UNAVAILABLE',
        'Payment settings are temporarily unavailable. Please contact support.',
        { code: 'PAYMENTS_UNAVAILABLE' },
      ),
    );
    expect(status).toBe(503);
    expect(body).toMatchObject({
      success: false,
      message:
        'Payment settings are temporarily unavailable. Please contact support.',
      error: { code: 'PAYMENTS_UNAVAILABLE', details: null },
      path: '/api/v1/products/123',
    });
    expect(spy).not.toHaveBeenCalled();
  });

  it('adds none for an UNAVAILABLE exception with the default code either', () => {
    const spy = errorLog();
    const { status, body } = run(new AppException('UNAVAILABLE', 'Later.'));
    expect(status).toBe(503);
    expect(body.error).toEqual({ code: 'SERVICE_UNAVAILABLE', details: null });
    expect(spy).not.toHaveBeenCalled();
  });

  it('exempts nothing else: every other kind answering 5xx is still logged', () => {
    for (const [kind, expected] of Object.entries(ERROR_STATUS)) {
      if (expected < 500 || kind === 'UNAVAILABLE') continue;
      const spy = errorLog();
      run(new AppException(kind as keyof typeof ERROR_STATUS, 'x'));
      expect(spy, kind).toHaveBeenCalledTimes(1);
      spy.mockRestore();
    }
  });

  it('never logs a client error (4xx), as before', () => {
    const spy = errorLog();
    run(new AppException('FORBIDDEN', 'No.'));
    run(new AppException('NOT_FOUND', 'No.'));
    expect(spy).not.toHaveBeenCalled();
  });
});

describe('mapDbError', () => {
  it('passes unknown errors through unchanged', () => {
    const e = new Error('something else');
    expect(mapDbError(e)).toBe(e);
  });

  it('recognises each known constraint', () => {
    const codes: Record<string, string> = {
      products_tenant_id_slug_key: 'PRODUCT_SLUG_TAKEN',
      products_tenant_id_sku_key: 'SKU_TAKEN',
      product_variants_tenant_id_sku_key: 'SKU_TAKEN',
      categories_tenant_id_slug_key: 'CATEGORY_SLUG_TAKEN',
      collections_tenant_id_slug_key: 'COLLECTION_SLUG_TAKEN',
      stores_slug_key: 'STORE_SLUG_TAKEN',
      products_quantity_check: 'NEGATIVE_STOCK',
      inventory_adjustments_quantity_after_check: 'NEGATIVE_STOCK',
      product_variants_product_id_options_key: 'DUPLICATE_VARIANT',
      products_pkey: 'ID_TAKEN',
    };
    for (const [constraint, code] of Object.entries(codes))
      expect(
        (mapDbError(new Error(`violates "${constraint}"`)) as AppException)
          .code,
        constraint,
      ).toBe(code);
  });
});
