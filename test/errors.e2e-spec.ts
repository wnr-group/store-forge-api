import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createTestApp } from './support/create-test-app.js';
import { ProbeModule } from './support/probe/probe.module.js';

describe('Error contracts and filter (AC-B-39 to AC-B-45, ERR)', () => {
  let app: INestApplication;

  beforeAll(async () => {
    app = await createTestApp({
      modules: [ProbeModule],
    });
  });

  afterAll(async () => {
    await app.close();
  });

  it('AC-B-40: five original error fields plus code are present on error response', async () => {
    const res = await request(app.getHttpServer())
      .get('/api/v1/nope')
      .expect(404);

    expect(res.body).toHaveProperty('statusCode', 404);
    expect(res.body).toHaveProperty('error', 'Not Found');
    expect(res.body).toHaveProperty('message');
    expect(res.body).toHaveProperty('path', '/api/v1/nope');
    expect(res.body).toHaveProperty('timestamp');
    expect(res.body).toHaveProperty('code', 'NOT_FOUND');
    expect(res.body.fieldErrors).toBeUndefined();
  });

  it('AC-B-42: validation failure gives property to first message, with nested keys dotted', async () => {
    const res = await request(app.getHttpServer())
      .post('/api/v1/probe/validate')
      .send({
        name: '',
        profile: {
          bio: '',
        },
      })
      .expect(400);

    expect(res.body.statusCode).toBe(400);
    expect(res.body.code).toBe('VALIDATION_FAILED');
    expect(res.body.message).toBe('Validation failed');
    expect(res.body.fieldErrors).toBeDefined();
    expect(res.body.fieldErrors.name).toBeDefined();
    expect(res.body.fieldErrors['profile.bio']).toBeDefined();
  });

  it('AC-B-41: fieldErrors is present only when provided by validation', async () => {
    const conflictRes = await request(app.getHttpServer())
      .get('/api/v1/probe/error/conflict')
      .expect(409);

    expect(conflictRes.body.code).toBe('CONFLICT');
    expect(conflictRes.body.fieldErrors).toBeUndefined();
  });

  it('AC-B-43: unexpected error gives generic 500 UNKNOWN with no thrown text, SQL, or stack', async () => {
    const res = await request(app.getHttpServer())
      .get('/api/v1/probe/error/unexpected')
      .expect(500);

    expect(res.body.statusCode).toBe(500);
    expect(res.body.code).toBe('UNKNOWN');
    expect(res.body.error).toBe('Internal Server Error');
    expect(res.body.message).toBe('Internal server error');

    // Never leak stack or internal details in body
    expect(JSON.stringify(res.body)).not.toContain(
      'database connection exploded',
    );
    expect(JSON.stringify(res.body)).not.toContain('stack');
  });

  it('AC-B-44: server logs contain no request body, Authorization, cookie or query string', async () => {
    const logSpy = vi.spyOn(console, 'error');
    const secretCanary = 'SuperSecretCanaryToken123!';
    const canaryQuery = 'secretSearchTerm99';

    await request(app.getHttpServer())
      .get(`/api/v1/probe/error/unexpected?query=${canaryQuery}`)
      .set('Authorization', `Bearer ${secretCanary}`)
      .set('Cookie', `session=${secretCanary}`)
      .expect(500);

    const capturedLogs = logSpy.mock.calls.flat().map(String).join(' ');

    expect(capturedLogs).not.toContain(secretCanary);
    expect(capturedLogs).not.toContain(canaryQuery);

    logSpy.mockRestore();
  });

  it('AC-B-45: native Nest exceptions (404, malformed JSON 400) receive correct codes', async () => {
    // 404 NOT_FOUND
    const notFoundRes = await request(app.getHttpServer())
      .get('/api/v1/nonexistent')
      .expect(404);
    expect(notFoundRes.body.code).toBe('NOT_FOUND');

    // 400 Malformed JSON -> VALIDATION_FAILED
    const badJsonRes = await request(app.getHttpServer())
      .post('/api/v1/probe/validate')
      .set('Content-Type', 'application/json')
      .send('{"invalid-json:')
      .expect(400);
    expect(badJsonRes.body.code).toBe('VALIDATION_FAILED');
  });
});
