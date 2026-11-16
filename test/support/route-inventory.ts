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
  const server = app.getHttpServer();
  // In Express, routes are mounted on router
  const router =
    server._events?.request?._router ??
    (server as Record<string, unknown>)._router;
  const routes: RouteMetadata[] = [];

  if (!router?.stack) return routes;

  for (const layer of router.stack) {
    if (layer.route?.path) {
      const path = layer.route.path;
      const methods = Object.keys(layer.route.methods).map((m) =>
        m.toUpperCase(),
      );
      for (const method of methods) {
        // Look up handler on layer
        const handler = layer.route.stack?.[0]?.handle;
        routes.push({
          path,
          method,
          isPublic: handler ? reflector.get(IS_PUBLIC_KEY, handler) : undefined,
          noTenant: handler ? reflector.get(NO_TENANT_KEY, handler) : undefined,
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
    }
  }

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
