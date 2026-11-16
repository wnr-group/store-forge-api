import { Reflector } from '@nestjs/core';
import { REQUIRE_LIVE_AUTH_KEY } from './decorators.js';

const reflector = new Reflector();

/**
 * Asserts that a controller method or handler has the @RequireLiveAuth() decorator (AC-B-21).
 * Fails with an Error if the decorator is absent.
 */
export function expectLiveAuthRequired(
  target: Function | object,
  propertyKey?: string,
): void {
  let isDecorated = false;

  if (propertyKey && typeof target === 'object' && target !== null) {
    const fn = (target as Record<string, unknown>)[propertyKey];
    if (typeof fn === 'function') {
      isDecorated =
        (reflector.get<boolean>(REQUIRE_LIVE_AUTH_KEY, fn) ??
          reflector.get<boolean>(REQUIRE_LIVE_AUTH_KEY, target.constructor)) ===
        true;
    }
  } else if (typeof target === 'function') {
    isDecorated =
      reflector.get<boolean>(REQUIRE_LIVE_AUTH_KEY, target) === true;
  }

  if (!isDecorated) {
    const name = propertyKey ?? (target as Function).name ?? 'anonymous';
    throw new Error(
      `Route handler "${name}" is missing required @RequireLiveAuth() decorator`,
    );
  }
}
