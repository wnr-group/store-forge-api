// Source of the Vercel function. `npm run build:vercel` bundles it (with all dependencies) into dist/server.mjs.
import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { AppModule } from '../dist/app.module.js';
import { configureApp, createLogger } from '../dist/app.setup.js';

let ready;

function bootstrap() {
  ready ??= (async () => {
    const app = await NestFactory.create(AppModule, {
      logger: createLogger(process.env.NODE_ENV ?? 'production'),
    });
    configureApp(app);
    await app.init();
    return app.getHttpAdapter().getInstance();
  })().catch((err) => {
    ready = undefined; // retry on the next request instead of caching a failed start
    throw err;
  });
  return ready;
}

export default async function handler(req, res) {
  const server = await bootstrap();
  return server(req, res);
}
