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
    summary: 'View usage of one organization',
    description:
      'See how much one organization uses the platform: how many products, customers and orders it has, how much file storage it uses and when it was last active. It shows only counts, sizes and times. The actual business records, such as customer details or amounts of money, are never shown.',
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
    summary: 'List usage of all organizations',
    description:
      'See how much each organization uses the platform, a page at a time. You can search, filter by status and sort the list. All of this is done inside the database, so it stays fast.',
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
    summary: 'View the usage summary',
    description:
      'Get platform-wide usage numbers in one place: the total number of organizations, how many are active, suspended or inactive, and the total file storage used. Use `inactiveDays` to choose how many days without activity make an organization count as inactive (the default is 30).',
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
    summary: 'List the least active organizations',
    description:
      'Find organizations that have not been active during the chosen number of days. Organizations that have never been active come first.',
    auth: 'platform',
    response: InactiveOrgsDto,
    message: 'Inactive organizations retrieved successfully',
  })
  inactive(@CurrentUser() admin: AuthUser, @Query() query: InactiveQueryDto) {
    return this.usage.inactive(admin.id, query.days, query.limit);
  }

  @Get('usage/new-organizations')
  @ApiEndpoint({
    summary: 'View new organizations over time',
    description:
      'See how many new organizations were created over a period, ready to draw as a chart. If you do not give dates, the last 90 days are used. If the start date is after the end date, they are swapped, and the period is limited to about 3 years. The numbers are grouped by day, week or month, whichever keeps the chart easy to read.',
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
