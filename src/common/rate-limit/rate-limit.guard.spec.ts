import { ExecutionContext, HttpStatus, Logger } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type {
  ThrottlerLimitDetail,
  ThrottlerRequest,
  ThrottlerStorage,
} from '@nestjs/throttler';
import type { Request } from 'express';
import { describe, expect, it, vi } from 'vitest';
import { AppException, ErrorCode } from '../errors/index.js';
import { BaseRateLimitGuard } from './base-rate-limit.guard.js';
import { getClientIp } from './client-ip.js';

class TestRateLimitGuard extends BaseRateLimitGuard {
  protected override readonly throttlerName = 'test-bucket';

  // Expose protected methods for unit testing
  public testGenerateKey(
    context: ExecutionContext,
    tracker: string,
    name: string,
  ): string {
    return this.generateKey(context, tracker, name);
  }

  public async testHandleRequest(
    requestProps: ThrottlerRequest,
  ): Promise<boolean> {
    return this.handleRequest(requestProps);
  }

  public async testThrowThrottlingException(
    context: ExecutionContext,
    detail: ThrottlerLimitDetail,
  ): Promise<void> {
    return this.throwThrottlingException(context, detail);
  }
}

describe('Rate Limit Guard Unit Tests (AC-B-64, AC-B-70)', () => {
  const reflector = new Reflector();

  it('AC-B-64: generateKey ignores class and method names and produces shared bucket key', () => {
    const mockStorage: ThrottlerStorage = {
      increment: vi.fn(),
    };
    const guard = new TestRateLimitGuard(
      { throttlers: [] },
      mockStorage,
      reflector,
    );

    const mockContext1 = {
      getClass: () => ({ name: 'ControllerA' }),
      getHandler: () => ({ name: 'methodA' }),
    } as unknown as ExecutionContext;

    const mockContext2 = {
      getClass: () => ({ name: 'ControllerB' }),
      getHandler: () => ({ name: 'methodB' }),
    } as unknown as ExecutionContext;

    const key1 = guard.testGenerateKey(mockContext1, '127.0.0.1', 'public');
    const key2 = guard.testGenerateKey(mockContext2, '127.0.0.1', 'public');

    expect(key1).toBe('public:127.0.0.1');
    expect(key2).toBe('public:127.0.0.1');
    expect(key1).toBe(key2);
  });

  it('AC-B-70: limiter storage error fails open and logs error', async () => {
    const mockStorage: ThrottlerStorage = {
      increment: vi
        .fn()
        .mockRejectedValue(new Error('Throttler in-memory storage exploded')),
    };
    const guard = new TestRateLimitGuard(
      { throttlers: [] },
      mockStorage,
      reflector,
    );

    const loggerSpy = vi
      .spyOn(Logger.prototype, 'error')
      .mockImplementation(() => {});

    const mockReq = { ip: '127.0.0.1', headers: {} };
    const mockRes = { header: vi.fn(), setHeader: vi.fn() };
    const mockContext = {
      switchToHttp: () => ({
        getRequest: () => mockReq,
        getResponse: () => mockRes,
      }),
      getClass: () => ({ name: 'TestController' }),
      getHandler: () => ({ name: 'testMethod' }),
    } as unknown as ExecutionContext;

    const requestProps: ThrottlerRequest = {
      context: mockContext,
      limit: 10,
      ttl: 60000,
      throttler: { name: 'test-bucket', limit: 10, ttl: 60000 },
      blockDuration: 60000,
      getTracker: async () => '127.0.0.1',
      generateKey: () => 'test-bucket:127.0.0.1',
    };

    // Should return true (fail open) rather than throwing
    const result = await guard.testHandleRequest(requestProps);
    expect(result).toBe(true);

    expect(loggerSpy).toHaveBeenCalledWith(
      expect.stringContaining(
        'Rate limiter [test-bucket] failed open due to storage error',
      ),
      expect.anything(),
    );

    loggerSpy.mockRestore();
  });

  it('AC-B-63, AC-B-66: over limit throws 429 RATE_LIMITED and sets integer Retry-After header', async () => {
    const mockStorage: ThrottlerStorage = {
      increment: vi.fn(),
    };
    const guard = new TestRateLimitGuard(
      { throttlers: [] },
      mockStorage,
      reflector,
    );

    const setHeaderMock = vi.fn();
    const mockContext = {
      switchToHttp: () => ({
        getRequest: () => ({}),
        getResponse: () => ({ setHeader: setHeaderMock }),
      }),
    } as unknown as ExecutionContext;

    const limitDetail: ThrottlerLimitDetail = {
      limit: 10,
      ttl: 60000,
      key: 'test-bucket:127.0.0.1',
      tracker: '127.0.0.1',
      totalHits: 11,
      timeToExpire: 42,
      isBlocked: true,
      timeToBlockExpire: 42,
    };

    await expect(
      guard.testThrowThrottlingException(mockContext, limitDetail),
    ).rejects.toThrow(AppException);

    try {
      await guard.testThrowThrottlingException(mockContext, limitDetail);
    } catch (err: unknown) {
      expect(err).toBeInstanceOf(AppException);
      const appErr = err as AppException;
      expect(appErr.getStatus()).toBe(HttpStatus.TOO_MANY_REQUESTS);
      expect(appErr.code).toBe(ErrorCode.RATE_LIMITED);
    }

    expect(setHeaderMock).toHaveBeenCalledWith('Retry-After', '42');
  });

  it('AC-B-69: getClientIp normalizes IPv6-mapped IPv4 addresses', () => {
    const req1 = { ip: '::ffff:192.0.2.1' } as Request;
    expect(getClientIp(req1)).toBe('192.0.2.1');

    const req2 = { ip: '198.51.100.1' } as Request;
    expect(getClientIp(req2)).toBe('198.51.100.1');

    const req3 = {
      ip: undefined,
      socket: { remoteAddress: '::ffff:127.0.0.1' },
    } as unknown as Request;
    expect(getClientIp(req3)).toBe('127.0.0.1');
  });
});
