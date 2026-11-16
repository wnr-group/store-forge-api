import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { AppConfig } from '../../config/configuration.js';
import { DatabaseService } from '../../infrastructure/database/database.service.js';

export interface HealthStatus {
  status: 'ok';
  service: 'store-forge-api';
}

export interface ReadinessStatus {
  status: 'ok' | 'unavailable';
}

@Injectable()
export class HealthService {
  private readonly logger = new Logger(HealthService.name);
  private readonly timeoutMs: number;

  constructor(
    private readonly databaseService: DatabaseService,
    private readonly configService: ConfigService<AppConfig, true>,
  ) {
    this.timeoutMs =
      this.configService?.get?.('health.dbTimeoutMs', { infer: true }) ?? 3000;
  }

  /**
   * Application-level liveness only: proves the NestJS process is up and serving requests.
   * It does NOT check the database, storage or any external service.
   */
  check(): HealthStatus {
    return { status: 'ok', service: 'store-forge-api' };
  }

  /**
   * Readiness check: validates database connectivity and safe role using DatabaseService.ping().
   * Any database failure, timeout or unsafe role returns { status: 'unavailable' }.
   * No internal details, credentials or SQL errors are leaked.
   */
  async readiness(): Promise<ReadinessStatus> {
    const isReady = await this.databaseService.ping(this.timeoutMs);
    if (!isReady) {
      this.logger.warn('Readiness check failed: database ping returned false');
      return { status: 'unavailable' };
    }
    return { status: 'ok' };
  }
}
