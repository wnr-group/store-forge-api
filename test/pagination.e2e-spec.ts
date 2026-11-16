import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestApp } from './support/create-test-app.js';
import { ProbeModule } from './support/probe/probe.module.js';

describe('Pagination and success contracts (AC-B-46 to AC-B-53, PAG)', () => {
  let app: INestApplication;

  beforeAll(async () => {
    app = await createTestApp({
      modules: [ProbeModule],
    });
  });

  afterAll(async () => {
    await app.close();
  });

  it('AC-B-46: success responses are bare DTOs with no outer data envelope', async () => {
    const res = await request(app.getHttpServer())
      .get('/api/v1/probe/items')
      .expect(200);

    expect(res.body.data).toBeUndefined();
    expect(res.body.items).toBeDefined();
  });

  it('AC-B-47: standard HTTP status codes: 200 read, 201 create, 204 delete with empty body', async () => {
    // 200 read
    const readRes = await request(app.getHttpServer())
      .get('/api/v1/probe/items')
      .expect(200);
    expect(readRes.body).toBeDefined();

    // 201 create
    const createRes = await request(app.getHttpServer())
      .post('/api/v1/probe/items')
      .expect(201);
    expect(createRes.body).toEqual({ id: 'new-item-1', name: 'Created' });

    // 204 delete
    const deleteRes = await request(app.getHttpServer())
      .delete('/api/v1/probe/items/123')
      .expect(204);
    expect(deleteRes.body).toEqual({});
    expect(deleteRes.text).toBe('');
  });

  it('AC-B-48: paged body has exactly items, total, page, pageSize', async () => {
    const res = await request(app.getHttpServer())
      .get('/api/v1/probe/items')
      .expect(200);

    const keys = Object.keys(res.body).sort();
    expect(keys).toEqual(['items', 'page', 'pageSize', 'total']);
  });

  it('AC-B-49: default values page=1 and pageSize=20 are applied when omitted', async () => {
    const res = await request(app.getHttpServer())
      .get('/api/v1/probe/items')
      .expect(200);

    expect(res.body.page).toBe(1);
    expect(res.body.pageSize).toBe(20);
  });

  it('AC-B-50: allowed page sizes 10, 20, 50, 100 are accepted', async () => {
    for (const size of [10, 20, 50, 100]) {
      const res = await request(app.getHttpServer())
        .get(`/api/v1/probe/items?pageSize=${size}`)
        .expect(200);
      expect(res.body.pageSize).toBe(size);
    }
  });

  it('AC-B-51: invalid pageSize (15, 0, -1, abc, 101, 20.0) gives 400 + fieldErrors.pageSize without clamping', async () => {
    for (const invalid of ['15', '0', '-1', 'abc', '101', '20.0']) {
      const res = await request(app.getHttpServer())
        .get(`/api/v1/probe/items?pageSize=${invalid}`)
        .expect(400);

      expect(res.body.statusCode).toBe(400);
      expect(res.body.code).toBe('VALIDATION_FAILED');
      expect(res.body.fieldErrors).toBeDefined();
      expect(res.body.fieldErrors.pageSize).toBeDefined();
    }
  });

  it('AC-B-52: invalid page (0, -1, 1.5, x, 9007199254740992) gives 400 + fieldErrors.page', async () => {
    for (const invalid of ['0', '-1', '1.5', 'x', '9007199254740992']) {
      const res = await request(app.getHttpServer())
        .get(`/api/v1/probe/items?page=${invalid}`)
        .expect(400);

      expect(res.body.statusCode).toBe(400);
      expect(res.body.code).toBe('VALIDATION_FAILED');
      expect(res.body.fieldErrors).toBeDefined();
      expect(res.body.fieldErrors.page).toBeDefined();
    }
  });

  it('AC-B-53: keys are camelCase and dates are ISO 8601 strings', async () => {
    const res = await request(app.getHttpServer())
      .get('/api/v1/probe/items')
      .expect(200);

    const item = res.body.items[0];
    expect(item).toHaveProperty('id');
    expect(item).toHaveProperty('name');
    expect(item).toHaveProperty('createdAt');

    // Confirm ISO 8601 format
    expect(new Date(item.createdAt).toISOString()).toBe(item.createdAt);
  });
});
