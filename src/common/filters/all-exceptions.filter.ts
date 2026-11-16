import {
  ArgumentsHost,
  Catch,
  ExceptionFilter,
  HttpException,
  HttpStatus,
  Logger,
} from '@nestjs/common';
import type { Request, Response } from 'express';
import { AppException } from '../errors/app-exception.js';
import { ErrorCode, STATUS_TO_ERROR_CODE } from '../errors/error-codes.js';

export interface ErrorResponseBody {
  statusCode: number;
  error: string;
  message: string | string[];
  path: string;
  timestamp: string;
  code: string;
  fieldErrors?: Record<string, string>;
}

/**
 * One error shape for every failure: { statusCode, error, message, path, timestamp, code, fieldErrors? }.
 * HttpExceptions (including validation errors) keep their message. Anything else is
 * logged server-side and returned as a generic 500, so internals never leak to clients.
 */
@Catch()
export class AllExceptionsFilter implements ExceptionFilter {
  private readonly logger = new Logger(AllExceptionsFilter.name);

  catch(exception: unknown, host: ArgumentsHost): void {
    const ctx = host.switchToHttp();
    const request = ctx.getRequest<Request>();
    const response = ctx.getResponse<Response>();

    // Full path without query string (which can carry tokens or sensitive search terms)
    const path = request.originalUrl.split('?')[0];
    let statusCode = HttpStatus.INTERNAL_SERVER_ERROR;
    let error = 'Internal Server Error';
    let message: string | string[] = 'Internal server error';
    let code: string = ErrorCode.UNKNOWN;
    let fieldErrors: Record<string, string> | undefined;

    if (exception instanceof AppException) {
      statusCode = exception.getStatus();
      code = exception.code;
      fieldErrors = exception.fieldErrors;
      const body = exception.getResponse();
      if (typeof body === 'object' && body !== null) {
        message =
          (body as { message?: string | string[] }).message ??
          exception.message;
      } else {
        message = exception.message;
      }
      error = HttpStatus[statusCode] ?? 'Error';
    } else if (exception instanceof HttpException) {
      statusCode = exception.getStatus();
      const body = exception.getResponse();
      code = STATUS_TO_ERROR_CODE[statusCode] ?? ErrorCode.UNKNOWN;

      if (typeof body === 'object' && body !== null) {
        const obj = body as Record<string, unknown>;
        if (typeof obj.code === 'string') {
          code = obj.code;
        }
        if (typeof obj.fieldErrors === 'object' && obj.fieldErrors !== null) {
          fieldErrors = obj.fieldErrors as Record<string, string>;
        }
        error =
          typeof obj.error === 'string'
            ? obj.error
            : (HttpStatus[statusCode] ?? exception.name);
        message = (obj.message as string | string[]) ?? exception.message;
      } else if (typeof body === 'string') {
        message = body;
        error = HttpStatus[statusCode] ?? exception.name;
      }
    } else {
      // Log the error class and stack; never log request body, headers or query string
      this.logger.error(
        `Unhandled exception on ${request.method} ${path}`,
        exception instanceof Error ? exception.stack : String(exception),
      );
    }

    const payload: ErrorResponseBody = {
      statusCode,
      error,
      message,
      path,
      timestamp: new Date().toISOString(),
      code,
      ...(fieldErrors ? { fieldErrors } : {}),
    };
    response.status(statusCode).json(payload);
  }
}
