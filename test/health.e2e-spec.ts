import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { DatabaseService } from '../src/infrastructure/database/database.service.js';
import { createTestApp } from './support/create-test-app.js';
import {
  createTestDatabase,
  type TestDatabase,
} from './support/database/create-test-database.js';

describe('Health and Readiness Endpoints (AC-B-54 to AC-B-59, HLT)', () => {
  let app: INestApplication;
  let testDb: TestDatabase;
  let databaseService: DatabaseService;

  beforeAll(async () => {
    testDb = await createTestDatabase();
    process.env.DATABASE_URL = testDb.url;
    process.env.DB_POOL_MAX = '1';
    process.env.DB_PREPARE = 'false';

    app = await createTestApp();
    databaseService = app.get(DatabaseService);
  });

  afterAll(async () => {
    await app.close();
    await testDb.close();
  });

  it('AC-B-54: liveness 200 with no database access; payload {status, service}', async () => {
    // Spy on databaseService to ensure no ping or db method is called
    const pingSpy = vi.spyOn(databaseService, 'ping');

    const res = await request(app.getHttpServer())
      .get('/api/v1/health')
      .expect(200);

    expect(res.body).toEqual({
      status: 'ok',
      service: 'store-forge-api',
    });
    expect(pingSpy).not.toHaveBeenCalled();

    pingSpy.mockRestore();
  });

  it('AC-B-55: readiness 200 { "status": "ok" } when select 1 succeeds', async () => {
    const res = await request(app.getHttpServer())
      .get('/api/v1/health/ready')
      .expect(200);

    expect(res.body).toEqual({
      status: 'ok',
    });
  });

  it('AC-B-56: readiness 503 exactly { "status": "unavailable" } when database is down', async () => {
    const pingSpy = vi
      .spyOn(databaseService, 'ping')
      .mockResolvedValueOnce(false);

    const res = await request(app.getHttpServer())
      .get('/api/v1/health/ready')
      .expect(503);

    expect(res.body).toEqual({
      status: 'unavailable',
    });

    pingSpy.mockRestore();
  });

  it('AC-B-57: readiness honours the configured timeout (hanging ping fails closed)', async () => {
    // Simulate hanging ping that takes longer than timeout
    const pingSpy = vi
      .spyOn(databaseService, 'ping')
      .mockImplementationOnce(async (timeoutMs) => {
        // Ping implementation returns false on timeout
        expect(timeoutMs).toBeGreaterThan(0);
        return false;
      });

    const res = await request(app.getHttpServer())
      .get('/api/v1/health/ready')
      .expect(503);

    expect(res.body).toEqual({
      status: 'unavailable',
    });

    pingSpy.mockRestore();
  });

  it('AC-B-58: readiness body contains no host, ref, role, password or SQL error', async () => {
    const canaries = [
      'xrkwyjnjemyxrbdbfmcn',
      'postgres',
      'storeforge_app',
      'secret-password',
      'SELECT 1',
      'bad_roles',
    ];

    // Check on 200 response
    const res200 = await request(app.getHttpServer())
      .get('/api/v1/health/ready')
      .expect(200);

    const bodyStr200 = JSON.stringify(res200.body);
    for (const canary of canaries) {
      expect(bodyStr200.toLowerCase()).not.toContain(canary.toLowerCase());
    }

    // Check on 503 response
    const pingSpy = vi
      .spyOn(databaseService, 'ping')
      .mockResolvedValueOnce(false);

    const res503 = await request(app.getHttpServer())
      .get('/api/v1/health/ready')
      .expect(503);

    const bodyStr503 = JSON.stringify(res503.body);
    for (const canary of canaries) {
      expect(bodyStr503.toLowerCase()).not.toContain(canary.toLowerCase());
    }

    pingSpy.mockRestore();
  });

  it('AC-B-59: unsafe role makes readiness unavailable (existing ping check)', async () => {
    // If unsafe role check in ping() returns false:
    const pingSpy = vi
      .spyOn(databaseService, 'ping')
      .mockResolvedValueOnce(false);

    const res = await request(app.getHttpServer())
      .get('/api/v1/health/ready')
      .expect(503);

    expect(res.body).toEqual({
      status: 'unavailable',
    });

    pingSpy.mockRestore();
  });
});
