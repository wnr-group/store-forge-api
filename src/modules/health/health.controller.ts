import { Controller, Get, HttpStatus, Res, UseGuards } from '@nestjs/common';
import {
  ApiOkResponse,
  ApiOperation,
  ApiProperty,
  ApiResponse,
  ApiTags,
} from '@nestjs/swagger';
import type { Response } from 'express';
import { ApiPublic } from '../../common/swagger/index.js';
import { ReadyRateLimitGuard } from '../../common/rate-limit/ready-rate-limit.guard.js';
import { Public } from '../../infrastructure/auth/decorators.js';
import {
  HealthService,
  type HealthStatus,
  type ReadinessStatus,
} from './health.service.js';

class HealthResponse {
  @ApiProperty({ example: 'ok' })
  status!: 'ok';

  @ApiProperty({ example: 'store-forge-api' })
  service!: 'store-forge-api';
}

class ReadinessResponse {
  @ApiProperty({ example: 'ok', enum: ['ok', 'unavailable'] })
  status!: 'ok' | 'unavailable';
}

@ApiTags('health')
@Controller('health')
export class HealthController {
  constructor(private readonly healthService: HealthService) {}

  @Get()
  @Public()
  @ApiPublic()
  @ApiOperation({
    summary: 'Application liveness check',
    description:
      'Public (no authentication). Confirms the API process is running. Does not check the database or any external service.',
  })
  @ApiOkResponse({ type: HealthResponse })
  check(): HealthStatus {
    return this.healthService.check();
  }

  @Get('ready')
  @Public()
  @ApiPublic()
  @UseGuards(ReadyRateLimitGuard)
  @ApiOperation({
    summary: 'Application readiness check',
    description:
      'Public (no authentication). Validates that the database connection is healthy and safe.',
  })
  @ApiOkResponse({
    type: ReadinessResponse,
    description: 'Database is healthy and safe',
  })
  @ApiResponse({
    status: HttpStatus.SERVICE_UNAVAILABLE,
    type: ReadinessResponse,
    description: 'Database is unavailable or unsafe',
  })
  async ready(
    @Res({ passthrough: true }) res: Response,
  ): Promise<ReadinessStatus> {
    const result = await this.healthService.readiness();
    if (result.status === 'unavailable') {
      res.status(HttpStatus.SERVICE_UNAVAILABLE);
    }
    return result;
  }
}
