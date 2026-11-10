import {
  ConsoleLogger,
  ValidationPipe,
  type INestApplication,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import type { NextFunction, Request, Response } from 'express';
import helmet from 'helmet';
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

/** The OpenAPI document, generated from the controllers and DTOs. Also used by the coverage test. */
export function buildOpenApiDocument(app: INestApplication, apiPrefix: string) {
  return SwaggerModule.createDocument(
    app,
    new DocumentBuilder()
      .setTitle('Store Forge API')
      .setDescription(
        [
          `All routes are served under /${apiPrefix}.`,
          'Authentication is **Supabase Auth**: sign in with the Supabase SDK and send the access token as `Authorization: Bearer <token>`. This API verifies the token; it never issues one.',
          'Organization-scoped routes act on the organization named by the `X-Organization-Id` header (checked against your memberships) or, without it, your first organization.',
          'Success envelope: `{ success, message, data, meta? }`. Error envelope: `{ success:false, message, error:{ code, details }, timestamp, path }`.',
        ].join('\n\n'),
      )
      .setVersion('1.0.0')
      .addBearerAuth({
        type: 'http',
        scheme: 'bearer',
        bearerFormat: 'JWT',
        description: 'Supabase access token',
      })
      .build(),
  );
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

  // Behind a proxy (Vercel / Render / Fly) the client address is the first X-Forwarded-For hop;
  // rate limiting keys on it.
  if (config.get('env', { infer: true }) === NodeEnv.Production) {
    (
      app.getHttpAdapter().getInstance() as {
        set: (key: string, value: unknown) => void;
      }
    ).set('trust proxy', 1);
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

  app.enableCors({
    origin: config.get('corsOrigins', { infer: true }),
    credentials: true,
    methods: ['GET', 'POST', 'PATCH', 'PUT', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Authorization', 'Content-Type', 'X-Organization-Id'],
    maxAge: 600,
  });

  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true, // strip properties without a validation decorator
      forbidNonWhitelisted: true, // ...and reject the request instead of silently dropping them
      transform: true, // payloads become DTO instances; query/path strings are converted to declared types
    }),
  );
  app.useGlobalFilters(new AllExceptionsFilter());

  if (swaggerEnabled) {
    SwaggerModule.setup(
      SWAGGER_PATH,
      app,
      buildOpenApiDocument(app, apiPrefix),
      {
        swaggerOptions: { persistAuthorization: true },
      },
    );
  }
}
