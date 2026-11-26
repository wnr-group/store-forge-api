import { Controller, Get, Header, Query } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { ApiEndpoint } from '../../common/decorators/api-endpoint.decorator.js';
import {
  CurrentUser,
  PlatformAccess,
} from '../../common/decorators/decorators.js';
import type { AuthUser } from '../../common/interfaces/request-context.js';
import {
  ErrorEventDto,
  ErrorListQueryDto,
  JobRunDto,
  JobRunsQueryDto,
  MonitoringOverviewDto,
} from './monitoring.dto.js';
import { MonitoringService } from './monitoring.service.js';

@ApiTags('platform-monitoring')
@Controller('platform/monitoring')
@PlatformAccess({ permission: 'monitoring:read' })
export class MonitoringController {
  constructor(private readonly monitoring: MonitoringService) {}

  @Get('overview')
  @Header('Cache-Control', 'no-store')
  @ApiEndpoint({
    summary: 'Platform health and operational alerts',
    description:
      'Everything the System Monitoring screen shows in one call, built to be polled (every 30 seconds is plenty; there is no push channel). Measured now: the database round trip and the sign-in service. Counted from stored records: server errors (5xx) of the last 24 hours and the runs of every scheduled job. Read from configuration only: whether the Razorpay keys and the scheduler secret are set (never their values). `alerts` are computed from those measurements. `unavailableMetrics` lists what is not measured (CPU, latency, ...) so a missing number is never mistaken for zero. No secrets, environment values or tenant data are returned.',
    auth: 'platform',
    permission: 'monitoring:read',
    response: MonitoringOverviewDto,
    message: 'Monitoring overview retrieved successfully',
  })
  overview(@CurrentUser() admin: AuthUser) {
    return this.monitoring.overview(admin.id);
  }

  @Get('errors')
  @Header('Cache-Control', 'no-store')
  @ApiEndpoint({
    summary: 'Recent server errors',
    description:
      'Unhandled server errors (HTTP 5xx), newest first, a page at a time. Each has the route template, the error class, a sanitised message (no ids, values, e-mail addresses or tokens), the first application line of the stack and the request id, which matches `X-Request-Id` in the server log. Search matches route, error class, message and request id. Rows older than 14 days are removed, and at most 200 are kept per minute.',
    auth: 'platform',
    permission: 'monitoring:read',
    response: [ErrorEventDto],
    paginated: true,
    message: 'Errors retrieved successfully',
  })
  errors(@CurrentUser() admin: AuthUser, @Query() q: ErrorListQueryDto) {
    return this.monitoring.errors(admin.id, q);
  }

  @Get('jobs')
  @Header('Cache-Control', 'no-store')
  @ApiEndpoint({
    summary: 'Scheduled job runs',
    description:
      'Every recorded run of the scheduled jobs, newest first: when, how long, ok or failed, a small numeric summary or the sanitised error. Filter by job and status. Runs older than 30 days are removed.',
    auth: 'platform',
    permission: 'monitoring:read',
    response: [JobRunDto],
    paginated: true,
    message: 'Job runs retrieved successfully',
  })
  jobs(@CurrentUser() admin: AuthUser, @Query() q: JobRunsQueryDto) {
    return this.monitoring.jobRuns(admin.id, q);
  }
}
