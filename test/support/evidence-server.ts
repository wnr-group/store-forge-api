import type { INestApplication } from '@nestjs/common';
import { createTestApp } from './create-test-app.js';
import { ProbeModule } from './probe/probe.module.js';

let runningApp: INestApplication | undefined;

export async function startEvidenceServer(port = 4200): Promise<{
  app: INestApplication;
  port: number;
  url: string;
}> {
  if (runningApp) {
    await runningApp.close();
  }

  process.env.NODE_ENV = 'test';
  process.env.SWAGGER_ENABLED = 'true';

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
}
