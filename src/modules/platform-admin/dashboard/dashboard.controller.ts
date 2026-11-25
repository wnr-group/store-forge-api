import { Controller, Get, Query } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { ApiEndpoint } from '../../../common/decorators/api-endpoint.decorator.js';
import {
  CurrentPlatformLevel,
  CurrentUser,
  PlatformAccess,
} from '../../../common/decorators/decorators.js';
import type {
  AuthUser,
  PlatformLevel,
} from '../../../common/interfaces/request-context.js';
import { DashboardDto, DashboardQueryDto } from './dashboard.dto.js';
import { DashboardService } from './dashboard.service.js';

@ApiTags('platform-admin')
@Controller('platform')
@PlatformAccess({ permission: 'tenants:read' })
export class DashboardController {
  constructor(private readonly dashboard: DashboardService) {}

  @Get('dashboard')
  @ApiEndpoint({
    summary: 'The platform overview',
    description:
      'Everything the Overview page shows, in one call and counted from the database: organizations (total, active, suspended) and people, subscriptions by state (active, trial, past due, expired), growth over the date range, revenue and payments, the latest audited actions, and whether the API and database are up. Revenue and payments are included only for roles that can read billing, and recent activity only for roles that can read the audit log; the others get `null` for those parts.',
    auth: 'platform',
    permission: 'tenants:read',
    response: DashboardDto,
    message: 'Dashboard retrieved successfully',
  })
  get(
    @CurrentUser() admin: AuthUser,
    @CurrentPlatformLevel() level: PlatformLevel,
    @Query() query: DashboardQueryDto,
  ) {
    return this.dashboard.get(admin.id, level, query);
  }
}
