import {
  type DynamicModule,
  type ExecutionContext,
  type INestApplication,
  type Type,
} from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { AppModule } from '../../src/app.module.js';
import { configureApp } from '../../src/app.setup.js';

export interface CreateTestAppOptions {
  modules?: Array<Type<unknown> | DynamicModule>;
  recordGuardOrder?: string[];
}

export async function createTestApp(
  options: CreateTestAppOptions = {},
): Promise<INestApplication> {
  const moduleRef = await Test.createTestingModule({
    imports: [AppModule, ...(options.modules ?? [])],
  }).compile();

  const app = moduleRef.createNestApplication();
  configureApp(app);
  await app.init();

  if (options.recordGuardOrder) {
    const orderList = options.recordGuardOrder;
    // Check global guards on app config
    const appConfig = (
      app as unknown as {
        config?: {
          getGlobalGuards?: () => Array<{
            canActivate?: (ctx: ExecutionContext) => unknown;
            constructor: { name: string };
          }>;
        };
      }
    ).config;
    const globalGuards = appConfig?.getGlobalGuards?.() ?? [];
    for (const g of globalGuards) {
      const original = g.canActivate?.bind(g);
      const guardName = g.constructor?.name ?? 'AnonymousGuard';
      if (original) {
        g.canActivate = async (context: ExecutionContext) => {
          orderList.push(guardName);
          return original(context);
        };
      }
    }
  }

  return app;
}
