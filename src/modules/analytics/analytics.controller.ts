import { Controller, Get, Query } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { ApiEndpoint } from '../../common/decorators/api-endpoint.decorator.js';
import {
  CurrentOrg,
  OrgScoped,
  RequirePermission,
} from '../../common/decorators/decorators.js';
import type { OrgContext } from '../../common/interfaces/request-context.js';
import { AnalyticsDto, AnalyticsQueryDto } from './analytics.dto.js';
import { AnalyticsService } from './analytics.service.js';

@ApiTags('analytics')
@Controller('analytics')
@OrgScoped()
export class AnalyticsController {
  constructor(private readonly analytics: AnalyticsService) {}

  @Get()
  @RequirePermission('orders:view')
  @ApiEndpoint({
    summary: 'Sales analytics and dashboard overview',
    description:
      'Sales series (store timezone, zero-filled), totals compared with the previous window, top 5 products, the 8 most recent orders and low-stock units. Revenue counts paid and fulfilled orders. The dashboard overview is this endpoint with `range=30`. Orders are read-only: there is no checkout yet, so a new store returns zeros and `hasOrders: false`.',
    auth: 'org',
    permission: 'orders:view',
    response: AnalyticsDto,
    message: 'Analytics retrieved successfully',
    errors: [404],
  })
  get(@CurrentOrg() org: OrgContext, @Query() query: AnalyticsQueryDto) {
    return this.analytics.get(org, query.range);
  }
}
