import { ConfigService } from '@nestjs/config';
import { describe, expect, it, vi } from 'vitest';
import type { DatabaseService } from '../../infrastructure/database/database.service.js';
import { HealthService } from './health.service.js';

describe('HealthService (AC-B-54 to AC-B-57)', () => {
  it('AC-B-54: check() returns liveness status without contacting database', () => {
    const pingMock = vi.fn();
    const mockDb = { ping: pingMock } as unknown as DatabaseService;
    const mockConfig = {
      get: vi.fn().mockReturnValue(3000),
    } as unknown as ConfigService<any, true>;
    const service = new HealthService(mockDb, mockConfig);

    const result = service.check();
    expect(result).toEqual({ status: 'ok', service: 'store-forge-api' });
    expect(pingMock).not.toHaveBeenCalled();
  });

  it('AC-B-55: readiness() returns { status: "ok" } when ping succeeds', async () => {
    const pingMock = vi.fn().mockResolvedValue(true);
    const mockDb = {
      ping: pingMock,
    } as unknown as DatabaseService;
    const mockConfig = {
      get: vi.fn().mockReturnValue(3000),
    } as unknown as ConfigService<any, true>;
    const service = new HealthService(mockDb, mockConfig);

    const result = await service.readiness();
    expect(result).toEqual({ status: 'ok' });
    expect(pingMock).toHaveBeenCalledWith(3000);
  });

  it('AC-B-56: readiness() returns { status: "unavailable" } when ping fails', async () => {
    const pingMock = vi.fn().mockResolvedValue(false);
    const mockDb = {
      ping: pingMock,
    } as unknown as DatabaseService;
    const mockConfig = {
      get: vi.fn().mockReturnValue(3000),
    } as unknown as ConfigService<any, true>;
    const service = new HealthService(mockDb, mockConfig);

    const result = await service.readiness();
    expect(result).toEqual({ status: 'unavailable' });
  });

  it('AC-B-57: readiness honours the configured timeout parameter', async () => {
    const customTimeout = 1500;
    const pingMock = vi.fn().mockResolvedValue(true);
    const mockDb = {
      ping: pingMock,
    } as unknown as DatabaseService;
    const mockConfig = {
      get: vi.fn().mockImplementation((key: string) => {
        if (key === 'health.dbTimeoutMs') return customTimeout;
        return undefined;
      }),
    } as unknown as ConfigService<any, true>;

    const service = new HealthService(mockDb, mockConfig);
    await service.readiness();

    expect(pingMock).toHaveBeenCalledWith(customTimeout);
  });
});
