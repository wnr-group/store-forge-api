import { Controller, Get, ServiceUnavailableException } from '@nestjs/common';
import { ApiProperty, ApiTags } from '@nestjs/swagger';
import { SkipThrottle } from '@nestjs/throttler';
import { ApiEndpoint } from '../../common/decorators/api-endpoint.decorator.js';
import { Public } from '../../common/decorators/decorators.js';
import { HealthService } from './health.service.js';

class HealthResponse {
  @ApiProperty({ example: 'ok' })
  status!: 'ok';

  @ApiProperty({ example: 'store-forge-api' })
  service!: 'store-forge-api';
}

class ReadinessResponse extends HealthResponse {
  @ApiProperty({ example: 'up', enum: ['up', 'down'] })
  database!: 'up' | 'down';
}

@ApiTags('health')
@Controller('health')
@Public()
@SkipThrottle()
export class HealthController {
  constructor(private readonly healthService: HealthService) {}

  @Get()
  @ApiEndpoint({
    summary: 'Application liveness check',
    description:
      'Confirms the API process is running. Does not check the database or any external service.',
    auth: 'public',
    response: HealthResponse,
    message: 'Service is running',
  })
  check(): HealthResponse {
    return this.healthService.check();
  }

  @Get('ready')
  @ApiEndpoint({
    summary: 'Readiness check (database)',
    description:
      'Runs a trivial query through the same row-level-security guarded transaction every request uses. Returns 503 when the database is unreachable.',
    auth: 'public',
    response: ReadinessResponse,
    message: 'Service is ready',
    errors: [503],
  })
  async ready(): Promise<ReadinessResponse> {
    const status = await this.healthService.readiness();
    if (status.database === 'down')
      throw new ServiceUnavailableException('The database is not reachable.');
    return status as ReadinessResponse;
  }
}
