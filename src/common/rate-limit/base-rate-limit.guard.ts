import {
  ExecutionContext,
  HttpStatus,
  Injectable,
  Logger,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import {
  InjectThrottlerOptions,
  InjectThrottlerStorage,
  ThrottlerGuard,
  type ThrottlerLimitDetail,
  type ThrottlerModuleOptions,
  type ThrottlerRequest,
  type ThrottlerStorage,
} from '@nestjs/throttler';
import type { Request } from 'express';
import { AppException, ErrorCode } from '../errors/index.js';
import { getClientIp } from './client-ip.js';

@Injectable()
export abstract class BaseRateLimitGuard extends ThrottlerGuard {
  protected abstract readonly throttlerName: string;
  protected override readonly logger = new Logger(this.constructor.name);

  constructor(
    @InjectThrottlerOptions() options: ThrottlerModuleOptions,
    @InjectThrottlerStorage() storageService: ThrottlerStorage,
    reflector: Reflector,
  ) {
    super(options, storageService, reflector);
  }

  /**
   * Generates a cache key based on the throttler name and client tracker.
   * Deliberately ignores controller class and route handler names so all routes sharing
   * this guard share the same bucket (AC-B-64).
   */
  protected override generateKey(
    _context: ExecutionContext,
    tracker: string,
    throttlerName: string,
  ): string {
    return `${throttlerName}:${tracker}`;
  }

  /**
   * Tracks requests by client IP respecting Express trust proxy settings (AC-B-65, AC-B-67, AC-B-68, AC-B-69).
   */
  protected override async getTracker(
    req: Record<string, unknown>,
  ): Promise<string> {
    return getClientIp(req as unknown as Request);
  }

  /**
   * Intercepts request processing:
   * 1. Only handles the throttler matching this.throttlerName.
   * 2. Catches storage errors and fails open with a server log (AC-B-70).
   */
  protected override async handleRequest(
    requestProps: ThrottlerRequest,
  ): Promise<boolean> {
    if (requestProps.throttler.name !== this.throttlerName) {
      return true;
    }

    try {
      return await super.handleRequest(requestProps);
    } catch (err: unknown) {
      if (
        err instanceof AppException ||
        (err as { status?: number })?.status === 429
      ) {
        throw err;
      }
      this.logger.error(
        `Rate limiter [${this.throttlerName}] failed open due to storage error: ${
          err instanceof Error ? err.message : String(err)
        }`,
        err instanceof Error ? err.stack : undefined,
      );
      return true;
    }
  }

  /**
   * Throws 429 RATE_LIMITED AppException and sets standard Retry-After response header in integer seconds (AC-B-60, AC-B-63, AC-B-66).
   */
  protected override async throwThrottlingException(
    context: ExecutionContext,
    throttlerLimitDetail: ThrottlerLimitDetail,
  ): Promise<void> {
    const { res } = this.getRequestResponse(context);
    const retryAfter = Math.max(
      1,
      throttlerLimitDetail.timeToBlockExpire ||
        throttlerLimitDetail.timeToExpire ||
        1,
    );

    if (res && typeof res.setHeader === 'function') {
      res.setHeader('Retry-After', String(retryAfter));
    } else if (res && typeof res.header === 'function') {
      res.header('Retry-After', String(retryAfter));
    }

    throw new AppException(HttpStatus.TOO_MANY_REQUESTS, {
      code: ErrorCode.RATE_LIMITED,
      message: 'Too many requests. Please try again later.',
    });
  }
}
