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
    summary: 'View sales and dashboard overview',
    description:
      'Get a snapshot of how your store is doing. It shows daily sales for the chosen period (days with no orders show zero), your total sales compared with the previous period, your 5 best-selling products, your 8 newest orders, and items that are low or out of stock. Daily figures follow your store time zone. Only paid and fulfilled orders count as revenue. The dashboard home page uses this same call with `range=30` (the last 30 days). Orders cannot be created yet, so a brand-new store simply shows zeros and `hasOrders: false`.',
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
