import {
  ConsoleLogger,
  Logger,
  ValidationPipe,
  type INestApplication,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import express from 'express';
import type { NextFunction, Request, RequestHandler, Response } from 'express';
import helmetModule, { type HelmetOptions } from 'helmet';
import { AllExceptionsFilter } from './common/filters/all-exceptions.filter.js';
import type { AppConfig } from './config/configuration.js';
import { NodeEnv } from './config/env.validation.js';

/** helmet's default export is callable under ESM but a namespace under CommonJS typings (Vercel's build), so resolve both. */
type HelmetFn = (options?: Readonly<HelmetOptions>) => RequestHandler;
const helmet = ((helmetModule as unknown as { default?: HelmetFn }).default ??
  helmetModule) as unknown as HelmetFn;

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
          `Every route starts with /${apiPrefix}.`,
          'Signing in is handled by **Supabase Auth**. Sign in with the Supabase SDK and send your access token as `Authorization: Bearer <token>`. This API only checks that the token is genuine, it never creates tokens itself.',
          'Routes that belong to an organization work on the organization named in the `X-Organization-Id` header. The header is checked against the organizations you belong to. If you leave it out, your first organization is used.',
          'Every successful answer looks like this: `{ success, message, data, meta? }`. Every error looks like this: `{ success:false, message, error:{ code, details }, timestamp, path }`.',
        ].join('\n\n'),
      )
      .setVersion('1.0.0')
      .addBearerAuth({
        type: 'http',
        scheme: 'bearer',
        bearerFormat: 'JWT',
        description: 'Your Supabase access token',
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

  // Bulk imports carry up to 500 products / 2000 catalog rows, so ONLY those routes get a 2 MB JSON limit; every other route keeps Nest's 100 KB default.
  // The handler is wrapped on purpose: Nest skips its own default parser when it finds a layer named "jsonParser",
  // which would silently stop every other route from parsing bodies (verified 2026-11-17 on Nest 12.4.2).
  const importJson = express.json({ limit: '2mb' });
  for (const route of ['products/import', 'catalog/import'])
    app.use(
      `/${apiPrefix}/${route}`,
      (req: Request, res: Response, next: NextFunction) =>
        importJson(req, res, next),
    );

  // Razorpay signs the EXACT bytes it sends, so webhook routes receive the raw body (a Buffer in `req.body`) instead of parsed
  // JSON. Same wrapped-handler pattern as above; set here so production, Vercel and the tests all get it.
  const webhookRaw = express.raw({ type: () => true, limit: '1mb' });
  app.use(
    `/${apiPrefix}/webhooks`,
    (req: Request, res: Response, next: NextFunction) =>
      webhookRaw(req, res, next),
  );

  // Security headers. Swagger UI needs inline scripts/styles, so only its path gets a relaxed CSP.
  const strict = helmet();
  const docs = helmet({ contentSecurityPolicy: false });
  app.use((req: Request, res: Response, next: NextFunction) =>
    swaggerEnabled && req.path.startsWith(`/${SWAGGER_PATH}`)
      ? docs(req, res, next)
      : strict(req, res, next),
  );

  // One line per request once the response is sent. Skipped in tests to keep their output clean.
  if (config.get('env', { infer: true }) !== NodeEnv.Test) {
    const httpLogger = new Logger('HTTP');
    app.use((req: Request, res: Response, next: NextFunction) => {
      const started = Date.now();
      res.on('finish', () => {
        httpLogger.log(
          `${req.method} ${req.originalUrl} ${res.statusCode} ${Date.now() - started}ms`,
        );
      });
      next();
    });
  }

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
