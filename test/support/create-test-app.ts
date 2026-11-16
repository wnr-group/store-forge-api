import {
  type DynamicModule,
  type ExecutionContext,
  type INestApplication,
  type Type,
} from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
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

  if (options.recordGuardOrder) {
    const orderList = options.recordGuardOrder;
    const container = (
      moduleRef as unknown as {
        container: {
          getModules: () => Map<
            string,
            {
              providers: Map<
                unknown,
                {
                  instance?: {
                    canActivate?: (context: ExecutionContext) => unknown;
                  };
                }
              >;
            }
          >;
        };
      }
    ).container;

    if (container?.getModules) {
      for (const [, nestModule] of container.getModules()) {
        for (const [token, provider] of nestModule.providers) {
          if (token === APP_GUARD && provider.instance) {
            const instance = provider.instance;
            const canActivateFn = instance.canActivate;
            if (typeof canActivateFn === 'function') {
              const original = canActivateFn.bind(instance);
              const guardName = instance.constructor.name;
              instance.canActivate = async (context: ExecutionContext) => {
                orderList.push(guardName);
                return original(context);
              };
            }
          }
        }
      }
    }
  }

  await app.init();
  return app;
}
