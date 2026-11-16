import type { INestApplication } from '@nestjs/common';
import { ThrottlerStorage } from '@nestjs/throttler';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createTestApp } from './support/create-test-app.js';
import { ProbeModule } from './support/probe/probe.module.js';

describe('Rate Limiting Contracts and Guards (AC-B-60 to AC-B-71, RL)', () => {
  let appDefault: INestApplication;
  let appTrustProxy: INestApplication;

  const PUBLIC_LIMIT = 10;
  const READY_LIMIT = 5;
  const WINDOW_SECONDS = 60;

  beforeAll(async () => {
    // Configure test rate limits
    process.env.PUBLIC_RATE_LIMIT = String(PUBLIC_LIMIT);
    process.env.PUBLIC_RATE_WINDOW_SECONDS = String(WINDOW_SECONDS);
    process.env.READY_RATE_LIMIT = String(READY_LIMIT);
    process.env.READY_RATE_WINDOW_SECONDS = String(WINDOW_SECONDS);

    // 1. App with default TRUST_PROXY = 0
    process.env.TRUST_PROXY = '0';
    appDefault = await createTestApp({
      modules: [ProbeModule],
    });

    // 2. App with TRUST_PROXY = 1
    process.env.TRUST_PROXY = '1';
    appTrustProxy = await createTestApp({
      modules: [ProbeModule],
    });
  });

  afterAll(async () => {
    await appDefault.close();
    await appTrustProxy.close();
  });

  it('AC-B-62: below the limit succeeds with 200 OK', async () => {
    const res = await request(appTrustProxy.getHttpServer())
      .get('/api/v1/probe/public-1')
      .set('X-Forwarded-For', '10.0.0.1')
      .expect(200);

    expect(res.body).toEqual({ probe: 1 });
  });

  it('AC-B-63: over the limit gives 429 RATE_LIMITED', async () => {
    const ip = '10.0.0.2';
    // Consume limit
    for (let i = 0; i < PUBLIC_LIMIT; i++) {
      await request(appTrustProxy.getHttpServer())
        .get('/api/v1/probe/public-1')
        .set('X-Forwarded-For', ip)
        .expect(200);
    }

    // N+1 should be rejected
    const res = await request(appTrustProxy.getHttpServer())
      .get('/api/v1/probe/public-1')
      .set('X-Forwarded-For', ip)
      .expect(429);

    expect(res.body.statusCode).toBe(429);
    expect(res.body.code).toBe('RATE_LIMITED');
    expect(res.body.message).toBe('Too many requests. Please try again later.');
    expect(res.body.path).toBe('/api/v1/probe/public-1');
  });

  it('AC-B-64: five probe routes share one bucket', async () => {
    const ip = '10.0.0.3';
    const routes = [
      '/api/v1/probe/public-1',
      '/api/v1/probe/public-2',
      '/api/v1/probe/public-3',
      '/api/v1/probe/public-4',
      '/api/v1/probe/public-5',
    ];

    // Send 2 requests to each of the 5 routes = 10 requests total
    for (let i = 0; i < 2; i++) {
      for (const route of routes) {
        await request(appTrustProxy.getHttpServer())
          .get(route)
          .set('X-Forwarded-For', ip)
          .expect(200);
      }
    }

    // 11th request to any route in the group must be rejected with 429
    for (const route of routes) {
      const res = await request(appTrustProxy.getHttpServer())
        .get(route)
        .set('X-Forwarded-For', ip)
        .expect(429);

      expect(res.body.code).toBe('RATE_LIMITED');
    }
  });

  it('AC-B-65: different client IPs get separate buckets (TRUST_PROXY=1)', async () => {
    const ipA = '10.0.0.4';
    const ipB = '10.0.0.5';

    // Exhaust limit for IP A
    for (let i = 0; i < PUBLIC_LIMIT; i++) {
      await request(appTrustProxy.getHttpServer())
        .get('/api/v1/probe/public-1')
        .set('X-Forwarded-For', ipA)
        .expect(200);
    }
    await request(appTrustProxy.getHttpServer())
      .get('/api/v1/probe/public-1')
      .set('X-Forwarded-For', ipA)
      .expect(429);

    // IP B must not be throttled
    const resB = await request(appTrustProxy.getHttpServer())
      .get('/api/v1/probe/public-1')
      .set('X-Forwarded-For', ipB)
      .expect(200);

    expect(resB.body).toEqual({ probe: 1 });
  });

  it('AC-B-66: Retry-After is an integer within the window and decreases', async () => {
    const ip = '10.0.0.6';
    for (let i = 0; i < PUBLIC_LIMIT; i++) {
      await request(appTrustProxy.getHttpServer())
        .get('/api/v1/probe/public-1')
        .set('X-Forwarded-For', ip)
        .expect(200);
    }

    const res1 = await request(appTrustProxy.getHttpServer())
      .get('/api/v1/probe/public-1')
      .set('X-Forwarded-For', ip)
      .expect(429);

    const retryAfterHeader1 = res1.headers['retry-after'];
    expect(retryAfterHeader1).toBeDefined();
    const retryAfter1 = parseInt(retryAfterHeader1 as string, 10);
    expect(Number.isInteger(retryAfter1)).toBe(true);
    expect(retryAfter1).toBeGreaterThanOrEqual(1);
    expect(retryAfter1).toBeLessThanOrEqual(WINDOW_SECONDS);

    // Wait 1.1 seconds and check that Retry-After has decreased
    await new Promise((resolve) => setTimeout(resolve, 1100));

    const res2 = await request(appTrustProxy.getHttpServer())
      .get('/api/v1/probe/public-1')
      .set('X-Forwarded-For', ip)
      .expect(429);

    const retryAfterHeader2 = res2.headers['retry-after'];
    expect(retryAfterHeader2).toBeDefined();
    const retryAfter2 = parseInt(retryAfterHeader2 as string, 10);
    expect(Number.isInteger(retryAfter2)).toBe(true);
    expect(retryAfter2).toBeLessThanOrEqual(retryAfter1);
  });

  it('AC-B-67: TRUST_PROXY disabled by default: X-Forwarded-For ignored', async () => {
    // On appDefault, requests with different X-Forwarded-For share the socket remote IP (127.0.0.1)
    for (let i = 0; i < PUBLIC_LIMIT; i++) {
      await request(appDefault.getHttpServer())
        .get('/api/v1/probe/public-1')
        .set('X-Forwarded-For', `192.168.1.${i}`)
        .expect(200);
    }

    // (PUBLIC_LIMIT + 1)th request with yet another X-Forwarded-For is throttled because socket IP is shared
    await request(appDefault.getHttpServer())
      .get('/api/v1/probe/public-1')
      .set('X-Forwarded-For', '192.168.1.99')
      .expect(429);
  });

  it('AC-B-68: TRUST_PROXY=1 resolves the expected client IP', async () => {
    const clientIp = '198.51.100.42';

    for (let i = 0; i < PUBLIC_LIMIT; i++) {
      await request(appTrustProxy.getHttpServer())
        .get('/api/v1/probe/public-1')
        .set('X-Forwarded-For', clientIp)
        .expect(200);
    }

    await request(appTrustProxy.getHttpServer())
      .get('/api/v1/probe/public-1')
      .set('X-Forwarded-For', clientIp)
      .expect(429);
  });

  it('AC-B-69: client-supplied leftmost X-Forwarded-For entries cannot bypass the limit', async () => {
    const realClientIp = '203.0.113.195';

    // Client attempts to spoof IP by altering the leftmost entries
    for (let i = 0; i < PUBLIC_LIMIT; i++) {
      await request(appTrustProxy.getHttpServer())
        .get('/api/v1/probe/public-1')
        .set('X-Forwarded-For', `spoofed-${i}.example.com, ${realClientIp}`)
        .expect(200);
    }

    // Even with a brand new spoofed leftmost IP, request is throttled because Express resolves 203.0.113.195
    const res = await request(appTrustProxy.getHttpServer())
      .get('/api/v1/probe/public-1')
      .set('X-Forwarded-For', `spoofed-final.example.com, ${realClientIp}`)
      .expect(429);

    expect(res.body.code).toBe('RATE_LIMITED');
  });

  it('AC-B-60: readiness has its own limit: N+1 gives 429 with Retry-After', async () => {
    const ip = '10.0.0.7';

    for (let i = 0; i < READY_LIMIT; i++) {
      await request(appTrustProxy.getHttpServer())
        .get('/api/v1/probe/ready-probe')
        .set('X-Forwarded-For', ip)
        .expect(200);
    }

    const res = await request(appTrustProxy.getHttpServer())
      .get('/api/v1/probe/ready-probe')
      .set('X-Forwarded-For', ip)
      .expect(429);

    expect(res.body.code).toBe('RATE_LIMITED');
    expect(res.headers['retry-after']).toBeDefined();
    const retryAfter = parseInt(res.headers['retry-after'] as string, 10);
    expect(Number.isInteger(retryAfter)).toBe(true);
    expect(retryAfter).toBeGreaterThanOrEqual(1);
  });

  it('AC-B-61: readiness and public buckets independent in both directions', async () => {
    const ip = '10.0.0.8';

    // 1. Exhaust ready bucket
    for (let i = 0; i < READY_LIMIT; i++) {
      await request(appTrustProxy.getHttpServer())
        .get('/api/v1/probe/ready-probe')
        .set('X-Forwarded-For', ip)
        .expect(200);
    }
    await request(appTrustProxy.getHttpServer())
      .get('/api/v1/probe/ready-probe')
      .set('X-Forwarded-For', ip)
      .expect(429);

    // Public bucket for the same IP must still be open
    await request(appTrustProxy.getHttpServer())
      .get('/api/v1/probe/public-1')
      .set('X-Forwarded-For', ip)
      .expect(200);

    // 2. Exhaust public bucket for another IP
    const ip2 = '10.0.0.9';
    for (let i = 0; i < PUBLIC_LIMIT; i++) {
      await request(appTrustProxy.getHttpServer())
        .get('/api/v1/probe/public-1')
        .set('X-Forwarded-For', ip2)
        .expect(200);
    }
    await request(appTrustProxy.getHttpServer())
      .get('/api/v1/probe/public-1')
      .set('X-Forwarded-For', ip2)
      .expect(429);

    // Ready bucket for ip2 must still be open
    await request(appTrustProxy.getHttpServer())
      .get('/api/v1/probe/ready-probe')
      .set('X-Forwarded-For', ip2)
      .expect(200);
  });

  it('AC-B-70: limiter storage error fails open and is logged', async () => {
    const storageService = appTrustProxy.get(ThrottlerStorage);
    const spy = vi.spyOn(storageService, 'increment');
    spy.mockRejectedValueOnce(new Error('Storage failure simulation'));

    // Should fail open with 200 OK
    const res = await request(appTrustProxy.getHttpServer())
      .get('/api/v1/probe/public-1')
      .set('X-Forwarded-For', '10.0.0.99')
      .expect(200);

    expect(res.body).toEqual({ probe: 1 });
    spy.mockRestore();
  });

  it('exercises in-process rate limiter under 100 concurrent requests', async () => {
    const ip = '10.0.0.100';

    const requests = Array.from({ length: 100 }, () =>
      request(appTrustProxy.getHttpServer())
        .get('/api/v1/probe/public-1')
        .set('X-Forwarded-For', ip),
    );

    const responses = await Promise.all(requests);
    const okResponses = responses.filter((r) => r.status === 200);
    const throttledResponses = responses.filter((r) => r.status === 429);

    expect(okResponses.length).toBe(PUBLIC_LIMIT);
    expect(throttledResponses.length).toBe(100 - PUBLIC_LIMIT);
    expect(okResponses.length + throttledResponses.length).toBe(100);
  });
});
