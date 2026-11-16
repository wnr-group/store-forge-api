import type { INestApplication } from '@nestjs/common';
import { createTestApp } from './create-test-app.js';
import {
  createTestDatabase,
  type TestDatabase,
} from './database/create-test-database.js';
import { ProbeModule } from './probe/probe.module.js';

let runningApp: INestApplication | undefined;
let testDb: TestDatabase | undefined;

export interface EvidenceServerContext {
  app: INestApplication;
  port: number;
  url: string;
}

export async function startEvidenceServer(
  port = 4200,
): Promise<EvidenceServerContext> {
  if (runningApp) {
    await stopEvidenceServer();
  }

  process.env.NODE_ENV = 'test';
  process.env.SWAGGER_ENABLED = 'true';

  testDb = await createTestDatabase();
  process.env.DATABASE_URL = testDb.url;
  process.env.DB_POOL_MAX = '1';
  process.env.DB_PREPARE = 'false';

  const app = await createTestApp({
    modules: [ProbeModule],
  });

  await app.listen(port);
  runningApp = app;

  return {
    app,
    port,
    url: `http://localhost:${port}`,
  };
}

export async function stopEvidenceServer(): Promise<void> {
  if (runningApp) {
    await runningApp.close();
    runningApp = undefined;
  }
  if (testDb) {
    await testDb.close();
    testDb = undefined;
  }
}
