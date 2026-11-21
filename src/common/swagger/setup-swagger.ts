import type { INestApplication } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  DocumentBuilder,
  SwaggerModule,
  type OpenAPIObject,
} from '@nestjs/swagger';
import type { AppConfig } from '../../config/configuration.js';
import { PagedResponseDto } from '../dto/paged-response.dto.js';
import { ErrorResponseDto } from './error-response.dto.js';

export const SWAGGER_PATH = 'api/docs';

export function setupSwagger(app: INestApplication): OpenAPIObject {
  const config = app.get<ConfigService<AppConfig, true>>(ConfigService);
  const apiPrefix = config.get('apiPrefix', { infer: true });

  const documentBuilder = new DocumentBuilder()
    .setTitle('Store Forge API')
    .setDescription(
      [
        'Dedicated NestJS backend for the Store Forge e-commerce template engine.',
        `All routes are served under /${apiPrefix}.`,
        'Authentication is handled via Supabase Auth ES256 JWT tokens passed in the Authorization header as a Bearer token.',
        'Multi-tenant operations require the X-Tenant-Id header containing the active tenant UUID.',
        'Errors share one shape: { statusCode, error, message, path, timestamp, code, fieldErrors? }.',
        'Next.js caller convention: The frontend forwards user session tokens in Authorization and tenant context in X-Tenant-Id.',
      ].join('\n\n'),
    )
    .setVersion('0.1.0')
    .addBearerAuth(
      {
        type: 'http',
        scheme: 'bearer',
        bearerFormat: 'JWT',
        description:
          'Supabase ES256 JWT user session token passed as Bearer <token>',
      },
      'bearer',
    );

  const document = SwaggerModule.createDocument(app, documentBuilder.build(), {
    extraModels: [ErrorResponseDto, PagedResponseDto],
  });

  SwaggerModule.setup(SWAGGER_PATH, app, document);
  return document;
}
