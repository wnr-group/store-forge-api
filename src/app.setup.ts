import {
  ConsoleLogger,
  HttpStatus,
  ValidationPipe,
  type INestApplication,
  type ValidationError,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import type { NextFunction, Request, Response } from 'express';
import helmet from 'helmet';
import { AppException, ErrorCode } from './common/errors/index.js';
import { AllExceptionsFilter } from './common/filters/all-exceptions.filter.js';
import type { AppConfig } from './config/configuration.js';
import { NodeEnv } from './config/env.validation.js';

export const SWAGGER_PATH = 'api/docs';

/** Structured logs: one JSON line per event in production, readable text otherwise. */
export function createLogger(nodeEnv: string): ConsoleLogger {
  return new ConsoleLogger({
    json: nodeEnv === NodeEnv.Production,
    colors: nodeEnv !== NodeEnv.Production,
  });
}

function formatValidationErrors(
  errors: ValidationError[],
  parentKey = '',
): Record<string, string> {
  const result: Record<string, string> = {};
  for (const error of errors) {
    const key = parentKey ? `${parentKey}.${error.property}` : error.property;
    if (error.constraints && Object.keys(error.constraints).length > 0) {
      result[key] = Object.values(error.constraints)[0];
    }
    if (error.children && error.children.length > 0) {
      Object.assign(result, formatValidationErrors(error.children, key));
    }
  }
  return result;
}

/**
 * Everything that makes the app behave like the real API: prefix, validation, error shape,
 * security headers, CORS and Swagger. Shared by main.ts and the e2e tests so tests exercise
 * the same pipeline that production runs.
 */
export function configureApp(app: INestApplication): void {
  const config = app.get<ConfigService<AppConfig, true>>(ConfigService);
  const apiPrefix = config.get('apiPrefix', { infer: true });
  const swaggerEnabled = config.get('swaggerEnabled', { infer: true });

  const trustProxy = config.get('rateLimit.trustProxy', { infer: true });
  const expressApp = app.getHttpAdapter()?.getInstance?.();
  if (expressApp && typeof expressApp.set === 'function') {
    if (typeof trustProxy === 'number' && trustProxy > 0) {
      expressApp.set('trust proxy', trustProxy);
    } else {
      expressApp.set('trust proxy', false);
    }
  }

  app.setGlobalPrefix(apiPrefix);

  // Security headers. Swagger UI needs inline scripts/styles, so only its path gets a relaxed CSP.
  const strict = helmet();
  const docs = helmet({ contentSecurityPolicy: false });
  app.use((req: Request, res: Response, next: NextFunction) =>
    swaggerEnabled && req.path.startsWith(`/${SWAGGER_PATH}`)
      ? docs(req, res, next)
      : strict(req, res, next),
  );

  app.enableCors({ origin: config.get('corsOrigins', { infer: true }) });

  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true, // strip properties without a validation decorator
      forbidNonWhitelisted: true, // ...and reject the request instead of silently dropping them
      transform: true, // payloads become DTO instances; query/path strings are converted to declared types
      exceptionFactory: (errors: ValidationError[]) => {
        const fieldErrors = formatValidationErrors(errors);
        return new AppException(HttpStatus.BAD_REQUEST, {
          code: ErrorCode.VALIDATION_FAILED,
          message: 'Validation failed',
          fieldErrors,
        });
      },
    }),
  );
  app.useGlobalFilters(new AllExceptionsFilter());

  if (swaggerEnabled) {
    const document = SwaggerModule.createDocument(
      app,
      new DocumentBuilder()
        .setTitle('Store Forge API')
        .setDescription(
          [
            'Dedicated NestJS backend for the Store Forge e-commerce template engine.',
            `All routes are served under /${apiPrefix}.`,
            'Errors share one shape: { statusCode, error, message, path, timestamp }.',
            'Authentication is not implemented yet; only public endpoints exist.',
          ].join('\n\n'),
        )
        .setVersion('0.1.0')
        .build(),
    );
    SwaggerModule.setup(SWAGGER_PATH, app, document);
  }
}
