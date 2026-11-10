import { Test } from '@nestjs/testing';
import { HealthController } from './health.controller.js';
import { HealthService } from './health.service.js';

describe('HealthController', () => {
  it('reports the service as running', async () => {
    const moduleRef = await Test.createTestingModule({
      controllers: [HealthController],
      providers: [HealthService],
    }).compile();

    expect(moduleRef.get(HealthController).check()).toEqual({
      status: 'ok',
      service: 'store-forge-api',
    });
  });
});
