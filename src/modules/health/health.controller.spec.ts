import { HttpStatus } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import type { Response } from 'express';
import { describe, expect, it, vi } from 'vitest';
import { ReadyRateLimitGuard } from '../../common/rate-limit/ready-rate-limit.guard.js';
import { DatabaseService } from '../../infrastructure/database/database.service.js';
import { HealthController } from './health.controller.js';
import { HealthService } from './health.service.js';

describe('HealthController', () => {
  it('reports the service as running (liveness)', async () => {
    const moduleRef = await Test.createTestingModule({
      controllers: [HealthController],
      providers: [
        HealthService,
        {
          provide: DatabaseService,
          useValue: { ping: vi.fn().mockResolvedValue(true) },
        },
        {
          provide: ConfigService,
          useValue: { get: vi.fn().mockReturnValue(3000) },
        },
      ],
    })
      .overrideGuard(ReadyRateLimitGuard)
      .useValue({ canActivate: () => true })
      .compile();

    expect(moduleRef.get(HealthController).check()).toEqual({
      status: 'ok',
      service: 'store-forge-api',
    });
  });

  it('reports readiness as ok when database is healthy', async () => {
    const mockDb = { ping: vi.fn().mockResolvedValue(true) };
    const moduleRef = await Test.createTestingModule({
      controllers: [HealthController],
      providers: [
        HealthService,
        { provide: DatabaseService, useValue: mockDb },
        {
          provide: ConfigService,
          useValue: { get: vi.fn().mockReturnValue(3000) },
        },
      ],
    })
      .overrideGuard(ReadyRateLimitGuard)
      .useValue({ canActivate: () => true })
      .compile();

    const statusSpy = vi.fn();
    const mockRes = { status: statusSpy } as unknown as Response;
    const result = await moduleRef.get(HealthController).ready(mockRes);

    expect(result).toEqual({ status: 'ok' });
    expect(statusSpy).not.toHaveBeenCalled();
  });

  it('reports readiness as unavailable and sets status 503 when database is down', async () => {
    const mockDb = { ping: vi.fn().mockResolvedValue(false) };
    const moduleRef = await Test.createTestingModule({
      controllers: [HealthController],
      providers: [
        HealthService,
        { provide: DatabaseService, useValue: mockDb },
        {
          provide: ConfigService,
          useValue: { get: vi.fn().mockReturnValue(3000) },
        },
      ],
    })
      .overrideGuard(ReadyRateLimitGuard)
      .useValue({ canActivate: () => true })
      .compile();

    const statusSpy = vi.fn();
    const mockRes = { status: statusSpy } as unknown as Response;
    const result = await moduleRef.get(HealthController).ready(mockRes);

    expect(result).toEqual({ status: 'unavailable' });
    expect(statusSpy).toHaveBeenCalledWith(HttpStatus.SERVICE_UNAVAILABLE);
  });
});
