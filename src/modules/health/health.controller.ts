import { Controller, Get } from '@nestjs/common';
import {
  ApiOkResponse,
  ApiOperation,
  ApiProperty,
  ApiTags,
} from '@nestjs/swagger';
import { Public } from '../../common/decorators/decorators.js';
import { HealthService } from './health.service.js';

class HealthResponse {
  @ApiProperty({ example: 'ok' })
  status!: 'ok';

  @ApiProperty({ example: 'store-forge-api' })
  service!: 'store-forge-api';
}

@ApiTags('health')
@Controller('health')
@Public()
export class HealthController {
  constructor(private readonly healthService: HealthService) {}

  @Get()
  @ApiOperation({
    summary: 'Application liveness check',
    description:
      'Public (no authentication). Confirms the API process is running. Does not check the database or any external service.',
  })
  @ApiOkResponse({ type: HealthResponse })
  check(): HealthResponse {
    return this.healthService.check();
  }
}
