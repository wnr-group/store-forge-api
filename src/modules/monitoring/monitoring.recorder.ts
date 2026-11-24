import {
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { sql } from 'drizzle-orm';
import {
  setErrorSink,
  type ServerErrorReport,
} from '../../common/error-sink.js';
import { DatabaseService } from '../../database/database.service.js';
import type { JobName } from './job-catalog.js';
import { sanitizeMessage, sourceOf, summarize } from './error-sanitizer.js';

const RECORD_TIMEOUT_MS = 1500;

/**
 * Writes monitoring data. It can never make a request or a job fail: every write is guarded, time-limited, and its own failure is only
 * logged. The writes are awaited (not fire-and-forget) because the API runs as short-lived serverless functions that may be frozen the
 * moment a response is sent.
 */
@Injectable()
export class MonitoringRecorder implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(MonitoringRecorder.name);

  constructor(private readonly db: DatabaseService) {}

  onModuleInit() {
    setErrorSink((report) => this.recordError(report));
  }

  onModuleDestroy() {
    setErrorSink(undefined);
  }

  private async guarded(work: () => Promise<unknown>, what: string) {
    let timer: NodeJS.Timeout | undefined;
    try {
      await Promise.race([
        work(),
        new Promise((_, reject) => {
          timer = setTimeout(
            () => reject(new Error('timed out')),
            RECORD_TIMEOUT_MS,
          );
        }),
      ]);
    } catch (error) {
      this.logger.warn(
        `could not record ${what}: ${error instanceof Error ? error.message.slice(0, 120) : 'unknown'}`,
      );
    } finally {
      clearTimeout(timer);
    }
  }

  recordError(report: ServerErrorReport): Promise<void> {
    const name = report.error instanceof Error ? report.error.name : 'Error';
    return this.guarded(
      () =>
        this.db.withPublic(async (tx) => {
          await tx.execute(sql`select public.monitoring_record_error(
            ${report.method}, ${report.route}, ${report.status}, ${name.slice(0, 100)},
            ${sanitizeMessage(report.error)}, ${sourceOf(report.error) ?? null}, ${report.requestId})`);
        }),
      'a server error',
    );
  }

  private recordJob(
    job: JobName,
    status: 'ok' | 'failed',
    started: Date,
    summary: ReturnType<typeof summarize>,
    error: string | null,
  ): Promise<void> {
    return this.guarded(
      () =>
        this.db.withPublic(async (tx) => {
          await tx.execute(sql`select public.monitoring_record_job(
            ${job}, ${status}, ${started}::timestamptz, ${new Date()}::timestamptz,
            ${summary ? JSON.stringify(summary) : null}::jsonb, ${error})`);
        }),
      `a run of ${job}`,
    );
  }

  /** Runs a scheduled job and records the outcome. The job's own result and error pass through unchanged. */
  async runJob<T>(job: JobName, work: () => Promise<T>): Promise<T> {
    const started = new Date();
    try {
      const result = await work();
      await this.recordJob(job, 'ok', started, summarize(result), null);
      return result;
    } catch (error) {
      await this.recordJob(
        job,
        'failed',
        started,
        null,
        sanitizeMessage(error),
      );
      throw error;
    }
  }
}
