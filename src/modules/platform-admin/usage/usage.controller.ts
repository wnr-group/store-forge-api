import { Controller, Get, Param, ParseUUIDPipe, Query } from '@nestjs/common';
import { ApiParam, ApiTags } from '@nestjs/swagger';
import { ApiEndpoint } from '../../../common/decorators/api-endpoint.decorator.js';
import {
  CurrentUser,
  PlatformAccess,
} from '../../../common/decorators/decorators.js';
import type { AuthUser } from '../../../common/interfaces/request-context.js';
import {
  InactiveOrgsDto,
  InactiveQueryDto,
  NewOrganizationsSeriesDto,
  OrgUsageDto,
  OrgUsageRowDto,
  SeriesQueryDto,
  UsageListQueryDto,
  UsageSummaryDto,
  UsageSummaryQueryDto,
} from './usage.dto.js';
import { PlatformUsageService } from './usage.service.js';

@ApiTags('platform-admin')
@Controller('platform')
@PlatformAccess()
export class PlatformUsageController {
  constructor(private readonly usage: PlatformUsageService) {}

  @Get('organizations/:id/usage')
  @ApiParam({ name: 'id', format: 'uuid', description: 'Organization id' })
  @ApiEndpoint({
    summary: 'Usage of one organization',
    description:
      'Counts, bytes and timestamps only: no merchant records or amounts.',
    auth: 'platform',
    response: OrgUsageDto,
    message: 'Usage retrieved successfully',
    errors: [404],
  })
  organization(
    @CurrentUser() admin: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return this.usage.organization(admin.id, id);
  }

  @Get('usage')
  @ApiEndpoint({
    summary: 'Usage per organization',
    description:
      'Search, status filter, sorting and paging all run in PostgreSQL.',
    auth: 'platform',
    response: [OrgUsageRowDto],
    paginated: true,
    message: 'Usage retrieved successfully',
  })
  list(@CurrentUser() admin: AuthUser, @Query() query: UsageListQueryDto) {
    return this.usage.list(admin.id, query);
  }

  @Get('usage/summary')
  @ApiEndpoint({
    summary: 'Usage summary',
    auth: 'platform',
    response: UsageSummaryDto,
    message: 'Usage summary retrieved successfully',
  })
  summary(
    @CurrentUser() admin: AuthUser,
    @Query() query: UsageSummaryQueryDto,
  ) {
    return this.usage.summary(admin.id, query.inactiveDays);
  }

  @Get('usage/inactive')
  @ApiEndpoint({
    summary: 'Least active organizations',
    description:
      'Organizations with no merchant activity in the window, never-active ones first.',
    auth: 'platform',
    response: InactiveOrgsDto,
    message: 'Inactive organizations retrieved successfully',
  })
  inactive(@CurrentUser() admin: AuthUser, @Query() query: InactiveQueryDto) {
    return this.usage.inactive(admin.id, query.days, query.limit);
  }

  @Get('usage/new-organizations')
  @ApiEndpoint({
    summary: 'New organizations over time',
    description:
      'Defaults to the last 90 days. Dates are swapped if backwards and capped at about 3 years; the bucket (day / week / month) is chosen to keep the series readable.',
    auth: 'platform',
    response: NewOrganizationsSeriesDto,
    message: 'Series retrieved successfully',
  })
  newOrganizations(
    @CurrentUser() admin: AuthUser,
    @Query() query: SeriesQueryDto,
  ) {
    return this.usage.newOrganizations(
      admin.id,
      query.from ?? '',
      query.to ?? '',
    );
  }
}
