import { ServiceUnavailableException } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { DatabaseService } from '../../database/database.service.js';
import { HealthController } from './health.controller.js';
import { HealthService } from './health.service.js';

async function build(ping: boolean) {
  const moduleRef = await Test.createTestingModule({
    controllers: [HealthController],
    providers: [
      HealthService,
      {
        provide: DatabaseService,
        useValue: { ping: vi.fn().mockResolvedValue(ping) },
      },
    ],
  }).compile();
  return moduleRef.get(HealthController);
}

describe('HealthController', () => {
  it('reports the service as running without touching the database', async () => {
    const controller = await build(false);
    expect(controller.check()).toEqual({
      status: 'ok',
      service: 'store-forge-api',
    });
  });

  it('reports readiness when the database answers', async () => {
    const controller = await build(true);
    await expect(controller.ready()).resolves.toEqual({
      status: 'ok',
      service: 'store-forge-api',
      database: 'up',
    });
  });

  it('answers 503 when the database is unreachable', async () => {
    const controller = await build(false);
    await expect(controller.ready()).rejects.toBeInstanceOf(
      ServiceUnavailableException,
    );
  });
});
