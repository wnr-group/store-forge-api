import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { and, count, desc, eq, ilike, or } from 'drizzle-orm';
import { sql } from 'drizzle-orm';
import { Paginated } from '../../common/dto/api-response.dto.js';
import type { AppConfig } from '../../config/configuration.js';
import { DatabaseService, rowsOf } from '../../database/database.service.js';
import {
  platformErrorEvents,
  platformJobRuns,
} from '../../database/schema/index.js';
import {
  JOBS,
  JOB_NAMES,
  LATE_FACTOR,
  LATE_SLACK_MINUTES,
  type JobName,
} from './job-catalog.js';
import type {
  AlertDto,
  ErrorEventDto,
  ErrorListQueryDto,
  ErrorStatsDto,
  JobRunDto,
  JobRunsQueryDto,
  JobStatusDto,
  MonitoringOverviewDto,
  ServiceStatusDto,
  UnavailableMetricDto,
} from './monitoring.dto.js';

const AUTH_CHECK_TTL_MS = 15_000;
const AUTH_CHECK_TIMEOUT_MS = 3_000;
export const ERROR_WARNING_15M = 5;
export const ERROR_CRITICAL_15M = 25;

/** What this system does not measure. They are listed, not shown as zero, so nobody reads "no data" as "all is well". */
export const UNAVAILABLE_METRICS: UnavailableMetricDto[] = [
  {
    key: 'cpu_memory',
    label: 'CPU and memory',
    reason:
      'The API runs as short-lived serverless functions; the host does not report per-instance usage to the application.',
  },
  {
    key: 'latency',
    label: 'Request latency and throughput',
    reason:
      'Request timings are written to the server log, not stored; there is no metrics store.',
  },
  {
    key: 'client_errors',
    label: 'Client errors (4xx)',
    reason:
      'Only server errors (5xx) are recorded. 4xx responses are normal answers to bad input.',
  },
  {
    key: 'queues',
    label: 'Queues and workers',
    reason:
      'There are none: scheduled jobs are the only background work and are listed under Jobs.',
  },
  {
    key: 'external_apis',
    label: 'Razorpay and carrier availability',
    reason:
      'They are not called from this screen. Failed payments and webhooks appear under alerts when they happen.',
  },
];

export interface AlertInputs {
  database: 'up' | 'down';
  auth: ServiceStatusDto['status'];
  errors: Pick<ErrorStatsDto, 'available' | 'last15Minutes'>;
  jobs: Pick<JobStatusDto, 'job' | 'label' | 'health' | 'lastRun'>[];
  failedBillingWebhooks: number;
  stuckRefunds: number;
  paidSubscriptions: number;
  billingPaymentsConfigured: boolean;
  schedulerConfigured: boolean;
}

const RANK = { critical: 0, warning: 1, info: 2 } as const;

/** The operational alerts, worked out from the measurements only. Pure, so every rule is tested. */
export function computeAlerts(i: AlertInputs): AlertDto[] {
  const a: AlertDto[] = [];
  if (i.database === 'down')
    a.push({
      id: 'database-down',
      severity: 'critical',
      title: 'The database is not answering',
      detail:
        'Nothing can be saved or read. Server errors cannot be recorded while it is down.',
    });
  if (i.auth === 'down')
    a.push({
      id: 'auth-down',
      severity: 'critical',
      title: 'The sign-in service is not answering',
      detail: 'People cannot sign in or refresh their session.',
    });
  if (i.database === 'up' && !i.errors.available)
    a.push({
      id: 'error-records-unavailable',
      severity: 'warning',
      title: 'Server errors could not be read',
      detail: 'The error statistics on this screen are missing, not zero.',
    });
  if (i.errors.last15Minutes >= ERROR_CRITICAL_15M)
    a.push({
      id: 'error-spike',
      severity: 'critical',
      title: `${i.errors.last15Minutes} server errors in 15 minutes`,
      detail:
        'Look at the most frequent errors below and at the request ids in the server log.',
    });
  else if (i.errors.last15Minutes >= ERROR_WARNING_15M)
    a.push({
      id: 'error-rate',
      severity: 'warning',
      title: `${i.errors.last15Minutes} server errors in 15 minutes`,
      detail: 'More than usual for a quiet system.',
    });
  for (const j of i.jobs) {
    if (j.health === 'failing')
      a.push({
        id: `job-failing:${j.job}`,
        severity: 'warning',
        title: `${j.label} is failing`,
        detail: j.lastRun?.error
          ? `Last run: ${j.lastRun.error}`
          : 'The last run failed.',
      });
    if (j.health === 'late')
      a.push({
        id: `job-late:${j.job}`,
        severity: 'warning',
        title: `${j.label} has stopped running`,
        detail: `It has run before but not successfully for more than twice its interval (${JOBS[j.job as JobName].everyMinutes} minutes). Check the cron schedule.`,
      });
  }
  if (i.failedBillingWebhooks > 0)
    a.push({
      id: 'billing-webhooks-failing',
      severity: 'warning',
      title: `${i.failedBillingWebhooks} billing webhook(s) failed in 24 hours`,
      detail:
        'Razorpay will deliver them again; if they keep failing, payments may not be recorded.',
    });
  if (i.stuckRefunds > 0)
    a.push({
      id: 'refunds-stuck',
      severity: 'warning',
      title: `${i.stuckRefunds} refund(s) pending for over an hour`,
      detail:
        'Repeat the refund request with the same request id, or check Razorpay.',
    });
  if (i.paidSubscriptions > 0 && !i.billingPaymentsConfigured)
    a.push({
      id: 'billing-payments-not-configured',
      severity: 'warning',
      title: 'Paid subscriptions exist but online payment is not configured',
      detail:
        'Tenants cannot pay their invoices online until the platform Razorpay keys are set.',
    });
  if (!i.schedulerConfigured)
    a.push({
      id: 'scheduler-not-configured',
      severity: 'warning',
      title: 'Scheduled jobs are disabled',
      detail: 'CRON_SECRET is not set, so every scheduled job call is refused.',
    });
  return a.sort(
    (x, y) =>
      RANK[x.severity as keyof typeof RANK] -
      RANK[y.severity as keyof typeof RANK],
  );
}

/** A job's health from its history: failing beats late beats ok; no history is its own state, not an alarm. */
export function jobHealth(
  job: JobName,
  last: { status: string } | null,
  lastSuccessAt: Date | null,
  now = new Date(),
): JobStatusDto['health'] {
  if (!last) return 'never_run';
  if (last.status === 'failed') return 'failing';
  const allowedMs =
    (JOBS[job].everyMinutes * LATE_FACTOR + LATE_SLACK_MINUTES) * 60_000;
  if (!lastSuccessAt || now.getTime() - lastSuccessAt.getTime() > allowedMs)
    return 'late';
  return 'ok';
}

const n = (v: unknown) => Number(v ?? 0);

/**
 * What the Monitoring screen shows. Measured now: the database round trip and the sign-in service. Counted from stored records: server
 * errors and scheduled-job runs. Read from configuration only: whether Razorpay keys and the scheduler secret are set (never their
 * values). Everything the system cannot measure is listed in `unavailableMetrics` rather than shown as zero. It is meant to be polled.
 */
@Injectable()
export class MonitoringService {
  private authCache: { at: number; value: ServiceStatusDto } | null = null;

  constructor(
    private readonly db: DatabaseService,
    private readonly config: ConfigService<AppConfig, true>,
  ) {}

  /** Forgets the cached sign-in check (tests and a manual refresh). */
  resetCache() {
    this.authCache = null;
  }

  private async authCheck(): Promise<ServiceStatusDto> {
    const base = { key: 'auth', label: 'Sign-in service (Supabase Auth)' };
    if (this.authCache && Date.now() - this.authCache.at < AUTH_CHECK_TTL_MS)
      return this.authCache.value;
    const { url, anonKey } = this.config.get('supabase', { infer: true });
    const started = Date.now();
    let value: ServiceStatusDto;
    try {
      const res = await fetch(`${url}/auth/v1/health`, {
        headers: { apikey: anonKey },
        signal: AbortSignal.timeout(AUTH_CHECK_TIMEOUT_MS),
      });
      value = {
        ...base,
        status: res.ok ? 'up' : 'down',
        latencyMs: Date.now() - started,
        detail: res.ok ? null : `Answered ${res.status}`,
      };
    } catch {
      value = {
        ...base,
        status: 'down',
        latencyMs: null,
        detail: 'No answer within 3 seconds',
      };
    }
    this.authCache = { at: Date.now(), value };
    return value;
  }

  private async measureDatabase(): Promise<{
    status: 'up' | 'down';
    latencyMs: number | null;
  }> {
    const started = Date.now();
    const up = await this.db.ping();
    return {
      status: up ? 'up' : 'down',
      latencyMs: up ? Date.now() - started : null,
    };
  }

  async overview(adminId: string): Promise<MonitoringOverviewDto> {
    const [database, auth] = await Promise.all([
      this.measureDatabase(),
      this.authCheck(),
    ]);
    const razorpay = this.config.get('razorpayPlatform', { infer: true });
    const keys = !!(razorpay.keyId && razorpay.keySecret);
    const schedulerConfigured = !!this.config.get('cron', { infer: true })
      .secret;

    const services: ServiceStatusDto[] = [
      {
        key: 'database',
        label: 'Database',
        status: database.status,
        latencyMs: database.latencyMs,
        detail: null,
      },
      auth,
      {
        key: 'razorpay',
        label: 'Razorpay (StoreForge billing account)',
        status: keys ? 'not_checked' : 'not_configured',
        latencyMs: null,
        detail: keys
          ? `Keys are set${razorpay.webhookSecret ? ' and the webhook secret is set' : ', but the webhook secret is not'}; Razorpay is not called from this screen`
          : 'RAZORPAY_PLATFORM_* are not set, so tenants cannot pay online',
      },
      {
        key: 'scheduler',
        label: 'Scheduled jobs',
        status: schedulerConfigured ? 'not_checked' : 'not_configured',
        latencyMs: null,
        detail: schedulerConfigured
          ? 'CRON_SECRET is set; see the job runs below for what actually ran'
          : 'CRON_SECRET is not set, so every job call is refused',
      },
    ];

    let errors: ErrorStatsDto = {
      available: false,
      reason: 'The database is not answering',
      last15Minutes: 0,
      last24Hours: 0,
      byHour: [],
      topIssues: [],
    };
    let jobs: JobStatusDto[] = [];
    let failedBillingWebhooks = 0;
    let stuckRefunds = 0;
    let paidSubscriptions = 0;

    if (database.status === 'up') {
      try {
        const data = await this.db.withUser(adminId, async (tx) => {
          const [counts] = rowsOf<{ last15: unknown; last24: unknown }>(
            await tx.execute(sql`select
              count(*) filter (where occurred_at > now() - interval '15 minutes') as last15, count(*) as last24
              from public.platform_error_events where occurred_at > now() - interval '24 hours'`),
          );
          const hourly = rowsOf<{ hour: string | Date; n: unknown }>(
            await tx.execute(sql`select h.hour, count(e.id) as n
              from generate_series(date_trunc('hour', now()) - interval '23 hours', date_trunc('hour', now()), interval '1 hour') as h(hour)
              left join public.platform_error_events e on e.occurred_at >= h.hour and e.occurred_at < h.hour + interval '1 hour'
              group by h.hour order by h.hour`),
          );
          const top = rowsOf<{
            method: string;
            route: string;
            error_name: string;
            message: string;
            n: unknown;
            last_seen: string | Date;
          }>(
            await tx.execute(sql`select method, route, error_name, message, count(*) as n, max(occurred_at) as last_seen
              from public.platform_error_events where occurred_at > now() - interval '24 hours'
              group by method, route, error_name, message order by n desc, last_seen desc limit 5`),
          );
          const last = rowsOf<{
            job: string;
            status: string;
            started_at: string | Date;
            duration_ms: number;
            summary: unknown;
            error: string | null;
          }>(
            await tx.execute(sql`select distinct on (job) job, status, started_at, duration_ms, summary, error
              from public.platform_job_runs order by job, started_at desc`),
          );
          const agg = rowsOf<{
            job: string;
            runs: unknown;
            fails: unknown;
            last_ok: string | Date | null;
          }>(
            await tx.execute(sql`select job,
              count(*) filter (where started_at > now() - interval '24 hours') as runs,
              count(*) filter (where status = 'failed' and started_at > now() - interval '24 hours') as fails,
              max(finished_at) filter (where status = 'ok') as last_ok
              from public.platform_job_runs group by job`),
          );
          const [extra] = rowsOf<{
            webhooks: unknown;
            refunds: unknown;
            paid: unknown;
          }>(
            await tx.execute(sql`select
              (select count(*) from public.billing_webhook_events where status = 'failed' and received_at > now() - interval '24 hours') as webhooks,
              (select count(*) from public.billing_refunds where status = 'pending' and created_at < now() - interval '1 hour') as refunds,
              (select count(*) from public.tenant_subscriptions s join public.plans p on p.id = s.plan_id
                where s.status in ('active', 'past_due')
                  and (case when s.billing_interval = 'yearly' then p.yearly_price_minor else p.monthly_price_minor end) > 0) as paid`),
          );
          return { counts, hourly, top, last, agg, extra };
        });

        errors = {
          available: true,
          reason: null,
          last15Minutes: n(data.counts?.last15),
          last24Hours: n(data.counts?.last24),
          byHour: data.hourly.map((h) => ({
            hour: new Date(h.hour),
            count: n(h.n),
          })),
          topIssues: data.top.map((t) => ({
            method: t.method,
            route: t.route,
            errorName: t.error_name,
            message: t.message,
            count: n(t.n),
            lastSeen: new Date(t.last_seen),
          })),
        };
        jobs = JOB_NAMES.map((job) => {
          const last = data.last.find((r) => r.job === job);
          const agg = data.agg.find((r) => r.job === job);
          const lastSuccessAt = agg?.last_ok ? new Date(agg.last_ok) : null;
          return {
            job,
            label: JOBS[job].label,
            expectedEveryMinutes: JOBS[job].everyMinutes,
            health: jobHealth(job, last ?? null, lastSuccessAt),
            lastRun: last
              ? {
                  status: last.status,
                  startedAt: new Date(last.started_at),
                  durationMs: last.duration_ms,
                  summary: last.summary ?? null,
                  error: last.error,
                }
              : null,
            lastSuccessAt,
            runsLast24Hours: n(agg?.runs),
            failuresLast24Hours: n(agg?.fails),
          };
        });
        failedBillingWebhooks = n(data.extra?.webhooks);
        stuckRefunds = n(data.extra?.refunds);
        paidSubscriptions = n(data.extra?.paid);
      } catch {
        errors = { ...errors, reason: 'The error records could not be read' };
      }
    }

    return {
      generatedAt: new Date(),
      api: {
        status: 'up',
        instanceUptimeSeconds: Math.round(process.uptime()),
        nodeVersion: process.version,
        environment: this.config.get('env', { infer: true }),
      },
      database: { status: database.status, latencyMs: database.latencyMs },
      services,
      errors,
      jobs,
      alerts: computeAlerts({
        database: database.status,
        auth: auth.status,
        errors,
        jobs,
        failedBillingWebhooks,
        stuckRefunds,
        paidSubscriptions,
        billingPaymentsConfigured: keys,
        schedulerConfigured,
      }),
      unavailableMetrics: UNAVAILABLE_METRICS,
    };
  }

  async errors(
    adminId: string,
    q: ErrorListQueryDto,
  ): Promise<Paginated<ErrorEventDto>> {
    return this.db.withUser(adminId, async (tx) => {
      const like = q.search ? `%${q.search.replace(/[\\%_]/g, '\\$&')}%` : null;
      const where = like
        ? or(
            ilike(platformErrorEvents.route, like),
            ilike(platformErrorEvents.errorName, like),
            ilike(platformErrorEvents.message, like),
            ilike(platformErrorEvents.requestId, like),
          )
        : undefined;
      const [{ total }] = await tx
        .select({ total: count() })
        .from(platformErrorEvents)
        .where(where);
      const rows = await tx
        .select()
        .from(platformErrorEvents)
        .where(where)
        .orderBy(
          desc(platformErrorEvents.occurredAt),
          desc(platformErrorEvents.id),
        )
        .limit(q.limit)
        .offset((q.page - 1) * q.limit);
      return new Paginated(
        rows.map((r) => ({
          id: r.id,
          occurredAt: r.occurredAt,
          method: r.method,
          route: r.route,
          status: r.status,
          errorName: r.errorName,
          message: r.message,
          source: r.source,
          requestId: r.requestId,
        })),
        { page: q.page, limit: q.limit, total: Number(total) },
      );
    });
  }

  async jobRuns(
    adminId: string,
    q: JobRunsQueryDto,
  ): Promise<Paginated<JobRunDto>> {
    return this.db.withUser(adminId, async (tx) => {
      const where = and(
        q.job === 'all' ? undefined : eq(platformJobRuns.job, q.job),
        q.status === 'all' ? undefined : eq(platformJobRuns.status, q.status),
      );
      const [{ total }] = await tx
        .select({ total: count() })
        .from(platformJobRuns)
        .where(where);
      const rows = await tx
        .select()
        .from(platformJobRuns)
        .where(where)
        .orderBy(desc(platformJobRuns.startedAt), desc(platformJobRuns.id))
        .limit(q.limit)
        .offset((q.page - 1) * q.limit);
      return new Paginated(
        rows.map((r) => ({
          id: r.id,
          job: r.job,
          status: r.status,
          startedAt: r.startedAt,
          finishedAt: r.finishedAt,
          durationMs: r.durationMs,
          summary: r.summary,
          error: r.error,
        })),
        { page: q.page, limit: q.limit, total: Number(total) },
      );
    });
  }
}
