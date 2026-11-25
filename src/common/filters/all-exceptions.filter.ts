import {
  ArgumentsHost,
  Catch,
  ExceptionFilter,
  HttpException,
  HttpStatus,
  Logger,
} from '@nestjs/common';
import { reportServerError } from '../error-sink.js';
import { currentRequestMeta } from '../request-meta.js';
import { templateOf } from '../../modules/monitoring/error-sanitizer.js';
import { ThrottlerException } from '@nestjs/throttler';
import type { Request, Response } from 'express';
import { AppException } from '../app.exception.js';
import {
  DEFAULT_ERROR_CODE,
  type ErrorKind,
} from '../constants/error-codes.js';
import { mapDbError } from '../db-errors.js';

export interface ErrorResponseBody {
  success: false;
  message: string;
  error: { code: string; details: unknown };
  timestamp: string;
  path: string;
}

const GENERIC = 'Something went wrong. Please try again.';

const KIND_BY_STATUS: Record<number, ErrorKind> = {
  400: 'VALIDATION',
  401: 'UNAUTHENTICATED',
  403: 'FORBIDDEN',
  404: 'NOT_FOUND',
  409: 'CONFLICT',
  422: 'VALIDATION',
  429: 'RATE_LIMITED',
};

/**
 * One error envelope for every failure: { success:false, message, error:{ code, details }, timestamp, path }.
 *
 * - `AppException`s carry a client-safe message, a stable machine code and optional field errors.
 * - Validation failures become `VALIDATION_ERROR` with the list of problems in `details`.
 * - Known database constraint violations are translated to safe messages (see db-errors.ts).
 * - Anything else is logged server-side (never the body, headers or query string) and returned as a generic 500,
 *   so database errors and stack traces never reach clients.
 */
@Catch()
export class AllExceptionsFilter implements ExceptionFilter {
  private readonly logger = new Logger(AllExceptionsFilter.name);

  catch(raw: unknown, host: ArgumentsHost): void {
    const ctx = host.switchToHttp();
    const request = ctx.getRequest<Request>();
    const response = ctx.getResponse<Response>();

    // Full path including the global prefix; the query string is dropped (it can carry tokens or search terms).
    const path = request.originalUrl.split('?')[0];
    const exception = raw instanceof HttpException ? raw : mapDbError(raw);
    const { status, code, message, details } = this.describe(exception);

    // An UNAVAILABLE AppException is an expected, already-explained condition (for example a feature whose server-side
    // key is not configured). The code that raises it logs its own category-only event and the HTTP request logger
    // records the 503, so no generic "unhandled" error line (with a stack) is added. Every other 5xx is logged as before.
    const expected =
      exception instanceof AppException && exception.kind === 'UNAVAILABLE';
    if (status >= 500 && !expected) {
      this.logger.error(
        `Unhandled exception on ${request.method} ${path}`,
        exception instanceof Error ? exception.stack : String(exception),
      );
    }

    const payload: ErrorResponseBody = {
      success: false,
      message,
      error: { code, details },
      timestamp: new Date().toISOString(),
      path,
    };
    const send = () => response.status(status).json(payload);

    // Monitoring: remember unhandled server errors (route template, class and a sanitised message only). The write is awaited before the
    // answer goes out, because a serverless function may be frozen once the response is sent; it is time-limited and never throws.
    const recorded =
      status >= 500 && !expected
        ? reportServerError({
            method: request.method,
            route:
              (request as { route?: { path?: string } }).route?.path ??
              templateOf(path),
            status,
            error: exception,
            requestId: currentRequestMeta()?.requestId ?? null,
          })
        : undefined;
    if (recorded) void recorded.then(send, send);
    else send();
  }

  private describe(exception: unknown): {
    status: number;
    code: string;
    message: string;
    details: unknown;
  } {
    if (exception instanceof AppException) {
      return {
        status: exception.getStatus(),
        code: exception.code,
        message: exception.message,
        details: exception.details,
      };
    }
    if (exception instanceof ThrottlerException) {
      return {
        status: HttpStatus.TOO_MANY_REQUESTS,
        code: DEFAULT_ERROR_CODE.RATE_LIMITED,
        message: 'Too many requests. Please wait a moment and try again.',
        details: null,
      };
    }
    if (exception instanceof HttpException) {
      const status = exception.getStatus();
      const kind = KIND_BY_STATUS[status];
      const body = exception.getResponse();
      const problems =
        typeof body === 'object' &&
        body !== null &&
        Array.isArray((body as { message?: unknown }).message)
          ? (body as { message: string[] }).message
          : null;
      if (problems) {
        return {
          status: HttpStatus.BAD_REQUEST,
          code: 'VALIDATION_ERROR',
          message: 'Please check the details you entered.',
          details: problems,
        };
      }
      const text =
        typeof body === 'string'
          ? body
          : ((body as { message?: string }).message ?? exception.message);
      return {
        status,
        code: kind ? DEFAULT_ERROR_CODE[kind] : `HTTP_${status}`,
        // 4xx messages written by us or Nest are safe; anything else gets the generic text.
        message: kind ? text : GENERIC,
        details: null,
      };
    }
    return {
      status: HttpStatus.INTERNAL_SERVER_ERROR,
      code: DEFAULT_ERROR_CODE.UNKNOWN,
      message: GENERIC,
      details: null,
    };
  }
}
