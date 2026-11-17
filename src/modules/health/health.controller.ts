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
    summary: 'Check that the API is running',
    description:
      'A quick check that the API is up and answering. It does not look at the database or any other service, so it only tells you the API itself is alive.',
    auth: 'public',
    response: HealthResponse,
    message: 'Service is running',
  })
  check(): HealthResponse {
    return this.healthService.check();
  }

  @Get('ready')
  @ApiEndpoint({
    summary: 'Check that the API is ready',
    description:
      'Checks that the API can reach its database. It runs a tiny test query in the same protected way that normal requests use. If the database cannot be reached, you get a 503 error.',
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
