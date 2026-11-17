import { Injectable } from '@nestjs/common';
import { DatabaseService } from '../../database/database.service.js';

export interface HealthStatus {
  status: 'ok';
  service: 'store-forge-api';
}

export interface ReadinessStatus {
  status: 'ok' | 'degraded';
  service: 'store-forge-api';
  database: 'up' | 'down';
}

@Injectable()
export class HealthService {
  constructor(private readonly db: DatabaseService) {}

  /** Application-level liveness only: proves the NestJS process is up. Never touches a dependency. */
  check(): HealthStatus {
    return { status: 'ok', service: 'store-forge-api' };
  }

  /** Readiness: also proves the database answers through the same RLS-guarded path the API uses. */
  async readiness(): Promise<ReadinessStatus> {
    const up = await this.db.ping();
    return {
      status: up ? 'ok' : 'degraded',
      service: 'store-forge-api',
      database: up ? 'up' : 'down',
    };
  }
}
