import type { INestApplication } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import {
  IS_PUBLIC_KEY,
  NO_TENANT_KEY,
  REQUIRE_LIVE_AUTH_KEY,
  REQUIRE_PERMISSION_KEY,
  REQUIRE_PLATFORM_ADMIN_KEY,
  REQUIRE_SUPER_ADMIN_KEY,
} from './probe/probe.decorators.js';

export interface RouteMetadata {
  path: string;
  method: string;
  isPublic?: boolean;
  noTenant?: boolean;
  requirePlatformAdmin?: boolean;
  requireSuperAdmin?: boolean;
  requirePermission?: string;
  requireLiveAuth?: boolean;
}

export function extractRouteInventory(app: INestApplication): RouteMetadata[] {
  const reflector = app.get(Reflector);
  const expressApp = app.getHttpAdapter().getInstance() as {
    _router?: {
      stack?: Array<Record<string, unknown>>;
    };
    router?: {
      stack?: Array<Record<string, unknown>>;
    };
  };
  const server = app.getHttpServer() as Record<string, unknown>;
  const router =
    expressApp?._router ??
    (server?._events as { request?: { _router?: typeof expressApp._router } })
      ?.request?._router ??
    expressApp?.router;
  const routes: RouteMetadata[] = [];

  if (!router?.stack) return routes;

  function processStack(stack: Array<Record<string, unknown>>) {
    for (const layer of stack) {
      if (layer.route && typeof layer.route === 'object') {
        const routeObj = layer.route as {
          path: string;
          methods: Record<string, boolean>;
          stack?: Array<{ handle?: Function }>;
        };
        const path = routeObj.path;
        const methods = Object.keys(routeObj.methods).map((m) =>
          m.toUpperCase(),
        );
        for (const method of methods) {
          const handler = routeObj.stack?.[0]?.handle;
          routes.push({
            path,
            method,
            isPublic: handler
              ? reflector.get(IS_PUBLIC_KEY, handler)
              : undefined,
            noTenant: handler
              ? reflector.get(NO_TENANT_KEY, handler)
              : undefined,
            requirePlatformAdmin: handler
              ? reflector.get(REQUIRE_PLATFORM_ADMIN_KEY, handler)
              : undefined,
            requireSuperAdmin: handler
              ? reflector.get(REQUIRE_SUPER_ADMIN_KEY, handler)
              : undefined,
            requirePermission: handler
              ? reflector.get(REQUIRE_PERMISSION_KEY, handler)
              : undefined,
            requireLiveAuth: handler
              ? reflector.get(REQUIRE_LIVE_AUTH_KEY, handler)
              : undefined,
          });
        }
      } else if (
        layer.name === 'router' &&
        (layer.handle as Record<string, unknown>)?.stack
      ) {
        processStack(
          (layer.handle as { stack: Array<Record<string, unknown>> }).stack,
        );
      }
    }
  }

  processStack(router.stack as Array<Record<string, unknown>>);
  return routes;
}

/**
 * Asserts that no registered route illegally combines @Public() with protected decorators.
 */
export function validateRouteInventoryPolicy(routes: RouteMetadata[]): void {
  for (const route of routes) {
    if (route.isPublic) {
      if (
        route.requirePlatformAdmin ||
        route.requireSuperAdmin ||
        route.requirePermission ||
        route.requireLiveAuth
      ) {
        throw new Error(
          `Route ${route.method} ${route.path} illegally combines @Public() with protected decorators.`,
        );
      }
    }
  }
}
