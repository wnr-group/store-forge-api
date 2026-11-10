import 'reflect-metadata';
import { Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module.js';
import { configureApp, createLogger, SWAGGER_PATH } from './app.setup.js';
import type { AppConfig } from './config/configuration.js';

async function bootstrap() {
  const app = await NestFactory.create(AppModule, {
    logger: createLogger(process.env.NODE_ENV ?? 'development'),
    bufferLogs: true,
  });
  configureApp(app);
  app.enableShutdownHooks();

  const config = app.get<ConfigService<AppConfig, true>>(ConfigService);
  const port = config.get('port', { infer: true });
  await app.listen(port);

  const logger = new Logger('Bootstrap');
  logger.log(
    `API listening on port ${port} under /${config.get('apiPrefix', { infer: true })}`,
  );
  if (config.get('swaggerEnabled', { infer: true }))
    logger.log(`Swagger UI at /${SWAGGER_PATH}`);
}
await bootstrap();
