import { Injectable } from '@nestjs/common';

export interface HealthStatus {
  status: 'ok';
  service: 'store-forge-api';
}

@Injectable()
export class HealthService {
  /**
   * Application-level liveness only: proves the NestJS process is up and serving requests.
   * It does NOT check the database, storage or any external service (none are configured yet).
   */
  check(): HealthStatus {
    return { status: 'ok', service: 'store-forge-api' };
  }
}
