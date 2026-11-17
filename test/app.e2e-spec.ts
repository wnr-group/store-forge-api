import { Test } from '@nestjs/testing';
import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import type { App } from 'supertest/types.js';
import { AppModule } from '../src/app.module.js';
import { configureApp } from '../src/app.setup.js';

/**
 * The bootstrap pipeline (prefix, validation, error envelope, headers, CORS, Swagger) with the real AppModule and no
 * database: nothing here reaches PostgreSQL or Supabase.
 */
describe('API foundation (e2e)', () => {
  let app: INestApplication<App>;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();
    app = moduleRef.createNestApplication();
    configureApp(app); // same prefix, pipes, filters, headers, CORS and Swagger as main.ts
    await app.init();
  });

  afterAll(async () => {
    await app.close();
  });

  it('GET /api/v1/health returns the liveness payload in the standard envelope without authentication', async () => {
    const res = await request(app.getHttpServer())
      .get('/api/v1/health')
      .expect(200);
    expect(res.body).toEqual({
      success: true,
      message: 'Service is running',
      data: { status: 'ok', service: 'store-forge-api' },
    });
  });

  it('serves Swagger UI and an OpenAPI document at /api/docs-json', async () => {
    await request(app.getHttpServer()).get('/api/docs').expect(200);
    const res = await request(app.getHttpServer())
      .get('/api/docs-json')
      .expect(200);
    expect(res.body.openapi).toMatch(/^3\./);
    expect(res.body.paths['/api/v1/health']).toBeDefined();
    expect(res.body.components.securitySchemes.bearer).toMatchObject({
      type: 'http',
      scheme: 'bearer',
    });
  });

  it('returns the shared error envelope for unknown routes', async () => {
    const res = await request(app.getHttpServer())
      .get('/api/v1/nope')
      .expect(404);
    expect(res.body).toMatchObject({
      success: false,
      error: { code: 'NOT_FOUND', details: null },
      path: '/api/v1/nope',
    });
    expect(typeof res.body.timestamp).toBe('string');
    expect(typeof res.body.message).toBe('string');
  });

  it('protects every non-public route: no token means 401, before any database access', async () => {
    const res = await request(app.getHttpServer())
      .get('/api/v1/products')
      .expect(401);
    expect(res.body.error.code).toBe('AUTH_REQUIRED');
    await request(app.getHttpServer())
      .get('/api/v1/platform/overview')
      .expect(401);
    await request(app.getHttpServer()).get('/api/v1/team/members').expect(401);
  });

  it('drops the query string from the reported path (it can carry tokens or search terms)', async () => {
    const res = await request(app.getHttpServer())
      .get('/api/v1/nope?token=secret&search=private')
      .expect(404);
    expect(res.body.path).toBe('/api/v1/nope');
  });

  it('sends security headers and hides the framework', async () => {
    const res = await request(app.getHttpServer()).get('/api/v1/health');
    expect(res.headers['x-content-type-options']).toBe('nosniff');
    expect(res.headers['x-powered-by']).toBeUndefined();
  });

  it('allows the configured CORS origin and not others', async () => {
    const allowed = await request(app.getHttpServer())
      .get('/api/v1/health')
      .set('Origin', 'http://localhost:3000');
    expect(allowed.headers['access-control-allow-origin']).toBe(
      'http://localhost:3000',
    );
    const denied = await request(app.getHttpServer())
      .get('/api/v1/health')
      .set('Origin', 'http://evil.test');
    expect(denied.headers['access-control-allow-origin']).toBeUndefined();
  });
});
