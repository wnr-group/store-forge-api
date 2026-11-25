import { describe, expect, it } from 'vitest';
import {
  sanitizeMessage,
  sourceOf,
  summarize,
  templateOf,
} from './error-sanitizer.js';
import { JOBS, JOB_NAMES } from './job-catalog.js';
import {
  ERROR_CRITICAL_15M,
  ERROR_WARNING_15M,
  computeAlerts,
  jobHealth,
  type AlertInputs,
} from './monitoring.service.js';

describe('sanitizeMessage', () => {
  it('never lets the SQL text or its parameters through', () => {
    const driver = new Error(
      'Failed query: select * from customers where email = $1\nparams: jane@example.com,4111111111111111',
    );
    expect(sanitizeMessage(driver)).toBe('Database query failed');
  });

  it('replaces ids, e-mail addresses, tokens, keys and long numbers', () => {
    const msg = sanitizeMessage(
      new Error(
        'Cannot charge jane.doe@example.com for order 123456789 id 0b9c6d1e-5f7a-4c1f-9b36-2f0d3c4e5a6b with rzp_live_AbCdEf123456 and Bearer eyJhbGciOiJIUzI1NiJ9.abc.def',
      ),
    );
    expect(msg).not.toMatch(/jane|123456789|0b9c6d1e|rzp_live|eyJ/);
    expect(msg).toContain('<email>');
    expect(msg).toContain('<n>');
    expect(msg).toContain('<id>');
    expect(msg).toContain('<key>');
    expect(msg).toContain('<token>');
  });

  it('drops constraint detail that quotes row values, keeps only the first line, and is short', () => {
    expect(
      sanitizeMessage(
        'duplicate key value violates unique constraint "x"\nDETAIL: Key (email)=(a@b.co) already exists.',
      ),
    ).toBe('duplicate key value violates unique constraint "x"');
    expect(
      sanitizeMessage('insert failed Key (email)=(a@b.co) already exists'),
    ).not.toContain('a@b.co');
    expect(sanitizeMessage('x'.repeat(5000))).toHaveLength(300);
  });

  it('long quoted text is hidden, and non-error values do not crash it', () => {
    expect(
      sanitizeMessage(new Error('bad value "a long customer note here" given')),
    ).toContain('<text>');
    expect(sanitizeMessage(undefined)).toBe('Unknown error');
    expect(sanitizeMessage({ any: 'object' })).toBe('Unknown error');
  });
});

describe('sourceOf and templateOf', () => {
  it('names the first application frame and skips libraries', () => {
    const e = new Error('x');
    e.stack =
      'Error: x\n    at lib (D:/app/node_modules/pkg/index.js:1:1)\n    at ProductsService.create (D:/app/src/modules/products/products.service.ts:812:9)\n    at next (node:internal/x:1:1)';
    expect(sourceOf(e)).toBe('ProductsService.create products.service.ts:812');
    expect(sourceOf('not an error')).toBeUndefined();
    expect(
      sourceOf(Object.assign(new Error('y'), { stack: undefined })),
    ).toBeUndefined();
  });

  it('turns a concrete path into a route template', () => {
    expect(
      templateOf(
        '/api/v1/products/0b9c6d1e-5f7a-4c1f-9b36-2f0d3c4e5a6b/images/42',
      ),
    ).toBe('/api/v1/products/:id/images/:n');
  });
});

describe('summarize', () => {
  it('keeps small plain values only', () => {
    expect(
      summarize({
        orders: 3,
        complete: true,
        note: 'ok',
        nested: { a: 1 },
        list: [1],
      }),
    ).toEqual({ orders: 3, complete: true, note: 'ok' });
    expect(summarize([1, 2])).toBeNull();
    expect(summarize(null)).toBeNull();
    expect(summarize({ nested: { a: 1 } })).toBeNull();
  });
});

const base = (over: Partial<AlertInputs> = {}): AlertInputs => ({
  database: 'up',
  auth: 'up',
  errors: { available: true, last15Minutes: 0 },
  jobs: [],
  failedBillingWebhooks: 0,
  stuckRefunds: 0,
  paidSubscriptions: 0,
  billingPaymentsConfigured: true,
  schedulerConfigured: true,
  ...over,
});

describe('computeAlerts', () => {
  it('is empty when everything is fine', () => {
    expect(computeAlerts(base())).toEqual([]);
  });

  it('raises critical alerts for a database or sign-in outage, first in the list', () => {
    const a = computeAlerts(
      base({ database: 'down', auth: 'down', schedulerConfigured: false }),
    );
    expect(a.map((x) => x.id)).toEqual([
      'database-down',
      'auth-down',
      'scheduler-not-configured',
    ]);
    expect(a[0].severity).toBe('critical');
  });

  it('grades the error rate and flags unreadable error records instead of showing calm zeros', () => {
    expect(
      computeAlerts(
        base({
          errors: { available: true, last15Minutes: ERROR_WARNING_15M - 1 },
        }),
      ),
    ).toEqual([]);
    expect(
      computeAlerts(
        base({ errors: { available: true, last15Minutes: ERROR_WARNING_15M } }),
      )[0],
    ).toMatchObject({ id: 'error-rate', severity: 'warning' });
    expect(
      computeAlerts(
        base({
          errors: { available: true, last15Minutes: ERROR_CRITICAL_15M },
        }),
      )[0],
    ).toMatchObject({ id: 'error-spike', severity: 'critical' });
    expect(
      computeAlerts(base({ errors: { available: false, last15Minutes: 0 } }))[0]
        .id,
    ).toBe('error-records-unavailable');
    // With the database down the missing records are explained by that alert alone.
    expect(
      computeAlerts(
        base({
          database: 'down',
          errors: { available: false, last15Minutes: 0 },
        }),
      ).map((x) => x.id),
    ).toEqual(['database-down']);
  });

  it('reports failing and late jobs, but not a job that has never run', () => {
    const job = (
      health: 'ok' | 'late' | 'failing' | 'never_run',
      error: string | null = null,
    ) => ({
      job: 'billing',
      label: 'Billing',
      health,
      lastRun:
        health === 'never_run'
          ? null
          : {
              status: health === 'failing' ? 'failed' : 'ok',
              startedAt: new Date(),
              durationMs: 1,
              summary: null,
              error,
            },
    });
    expect(
      computeAlerts(base({ jobs: [job('ok'), job('never_run')] })),
    ).toEqual([]);
    expect(
      computeAlerts(
        base({ jobs: [job('failing', 'Database query failed')] }),
      )[0],
    ).toMatchObject({
      id: 'job-failing:billing',
      detail: 'Last run: Database query failed',
    });
    expect(computeAlerts(base({ jobs: [job('late')] }))[0]).toMatchObject({
      id: 'job-late:billing',
      severity: 'warning',
    });
  });

  it('reports billing trouble: failed webhooks, stuck refunds, and paid plans without payment keys', () => {
    const ids = computeAlerts(
      base({
        failedBillingWebhooks: 2,
        stuckRefunds: 1,
        paidSubscriptions: 3,
        billingPaymentsConfigured: false,
      }),
    ).map((x) => x.id);
    expect(ids).toEqual([
      'billing-webhooks-failing',
      'refunds-stuck',
      'billing-payments-not-configured',
    ]);
    // No paid plan, no keys: nothing to warn about.
    expect(
      computeAlerts(
        base({ paidSubscriptions: 0, billingPaymentsConfigured: false }),
      ),
    ).toEqual([]);
  });
});

describe('jobHealth', () => {
  const now = new Date('2026-11-24T12:00:00Z');
  const ago = (minutes: number) => new Date(now.getTime() - minutes * 60_000);

  it('is never_run without history, failing after a failure, otherwise ok or late by the job interval', () => {
    expect(jobHealth('expire-reservations', null, null, now)).toBe('never_run');
    expect(
      jobHealth('expire-reservations', { status: 'failed' }, ago(1), now),
    ).toBe('failing');
    expect(
      jobHealth('expire-reservations', { status: 'ok' }, ago(14), now),
    ).toBe('ok');
    expect(
      jobHealth('expire-reservations', { status: 'ok' }, ago(16), now),
    ).toBe('late');
    expect(jobHealth('billing', { status: 'ok' }, ago(47 * 60), now)).toBe(
      'ok',
    );
    expect(jobHealth('billing', { status: 'ok' }, ago(49 * 60), now)).toBe(
      'late',
    );
    expect(jobHealth('billing', { status: 'ok' }, null, now)).toBe('late');
  });

  it('knows every scheduled job with a positive interval', () => {
    expect(JOB_NAMES.sort()).toEqual([
      'billing',
      'expire-reservations',
      'purge-abandoned-carts',
      'reconcile-payments',
      'sync-shipments',
    ]);
    for (const j of JOB_NAMES) expect(JOBS[j].everyMinutes).toBeGreaterThan(0);
  });
});
