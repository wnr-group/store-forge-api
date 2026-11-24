import { Controller, Get, Param, ParseUUIDPipe, Query } from '@nestjs/common';
import { ApiParam, ApiTags } from '@nestjs/swagger';
import { ApiEndpoint } from '../../common/decorators/api-endpoint.decorator.js';
import {
  CurrentOrg,
  OrgScoped,
  RequirePermission,
} from '../../common/decorators/decorators.js';
import type { OrgContext } from '../../common/interfaces/request-context.js';
import {
  CustomerHistoryDto,
  CustomerHistoryQueryDto,
  CustomerReportQueryDto,
  CustomerSummaryDto,
  ProductPerformanceDto,
  ProductReportQueryDto,
  SalesQueryDto,
  SalesReportDto,
  TopCustomerDto,
  TopCustomerQueryDto,
} from './reports.dto.js';
import { ReportsService } from './reports.service.js';

const DEFINITIONS =
  'Figures are for orders that count as sales (confirmed through delivered; cancelled, failed, returned and unpaid orders are left out), placed on the days chosen in your store time zone. Gross sales are the items before discounts; net sales = gross sales - discounts - refunds; total sales = what customers were charged (including delivery and GST); net revenue = total sales - refunds. A refund belongs to the period of its order, so nothing is counted twice.';

@ApiTags('analytics')
@Controller('analytics')
@OrgScoped()
export class ReportsController {
  constructor(private readonly reports: ReportsService) {}

  @Get('sales')
  @RequirePermission('marketing:view')
  @ApiEndpoint({
    summary: 'Sales overview and trends',
    description: `Total orders, gross sales, discounts, refunds, net sales, total sales, net revenue and average order value for a period, with the change from the period just before it, and a series for charts (sales, revenue and order trends by day, week or month, no gaps). ${DEFINITIONS} The default is the last 30 days.`,
    auth: 'org',
    permission: 'marketing:view',
    response: SalesReportDto,
    message: 'Sales report retrieved successfully',
    errors: [400],
  })
  sales(@CurrentOrg() org: OrgContext, @Query() q: SalesQueryDto) {
    return this.reports.sales(org, q);
  }

  @Get('revenue')
  @RequirePermission('marketing:view')
  @ApiEndpoint({
    summary: 'Revenue report (daily, weekly, monthly)',
    description: `The revenue report: choose \`interval=day\`, \`week\` or \`month\` for one row per period with orders, gross sales, discounts, refunds, net sales, total sales and net revenue, plus the totals of the whole period. The same figures as the sales overview, so the two always agree. ${DEFINITIONS}`,
    auth: 'org',
    permission: 'marketing:view',
    response: SalesReportDto,
    message: 'Revenue report retrieved successfully',
    errors: [400],
  })
  revenue(@CurrentOrg() org: OrgContext, @Query() q: SalesQueryDto) {
    return this.reports.sales(org, q);
  }

  @Get('products')
  @RequirePermission('marketing:view')
  @ApiEndpoint({
    summary: 'Product performance',
    description:
      'Units sold, item revenue and the number of orders containing each product in a period, ranked by `sortBy` (units, revenue or orders). `sortOrder=desc` (default) lists the best sellers, `asc` the worst performers, including active products nobody bought. Variants are added together. Product conversion needs product-view tracking, which does not exist, so `conversionRatePercent` is always null rather than invented. Revenue here is the item value before order-level discounts, and refunds are not split by product.',
    auth: 'org',
    permission: 'marketing:view',
    response: [ProductPerformanceDto],
    paginated: true,
    message: 'Product performance retrieved successfully',
    errors: [400],
  })
  products(@CurrentOrg() org: OrgContext, @Query() q: ProductReportQueryDto) {
    return this.reports.products(org, q);
  }

  @Get('customers')
  @RequirePermission('customers:view')
  @ApiEndpoint({
    summary: 'Customer analytics',
    description:
      'Total customers, customers added in the period, buyers split into first-time and returning (returning = had bought before the period began), the all-time repeat purchase rate and average spend. Built from your existing customer and order records. Guest orders without a customer record are not part of it.',
    auth: 'org',
    permission: 'customers:view',
    response: CustomerSummaryDto,
    message: 'Customer analytics retrieved successfully',
    errors: [400],
  })
  customers(@CurrentOrg() org: OrgContext, @Query() q: CustomerReportQueryDto) {
    return this.reports.customerSummary(org, q);
  }

  // Declared before `:id` so "top" is never read as an id.
  @Get('customers/top')
  @RequirePermission('customers:view')
  @ApiEndpoint({
    summary: 'Top customers by revenue',
    description:
      'Customers ranked by what they were charged on counted orders in the period (or by number of orders), a page at a time.',
    auth: 'org',
    permission: 'customers:view',
    response: [TopCustomerDto],
    paginated: true,
    message: 'Top customers retrieved successfully',
    errors: [400],
  })
  top(@CurrentOrg() org: OrgContext, @Query() q: TopCustomerQueryDto) {
    return this.reports.topCustomers(org, q);
  }

  @Get('customers/:id/history')
  @RequirePermission('customers:view')
  @ApiParam({ name: 'id', format: 'uuid' })
  @ApiEndpoint({
    summary: 'Purchase history of one customer',
    description:
      'Lifetime orders and revenue (counted orders), first and last order, and every order of the customer, newest first, a page at a time, each marked as counting as a sale or not.',
    auth: 'org',
    permission: 'customers:view',
    response: CustomerHistoryDto,
    message: 'Customer history retrieved successfully',
    errors: [404],
  })
  history(
    @CurrentOrg() org: OrgContext,
    @Param('id', ParseUUIDPipe) id: string,
    @Query() q: CustomerHistoryQueryDto,
  ) {
    return this.reports.customerHistory(org, id, q);
  }
}
