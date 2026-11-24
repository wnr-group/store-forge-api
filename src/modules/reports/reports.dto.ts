import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsIn, IsOptional, Matches } from 'class-validator';
import { DateRangeQueryDto } from '../../common/dto/date-range-query.dto.js';
import { PaginationQueryDto } from '../../common/dto/pagination-query.dto.js';

const DAY = /^\d{4}-\d{2}-\d{2}$/;
export const REPORT_INTERVALS = ['day', 'week', 'month'] as const;
export type ReportInterval = (typeof REPORT_INTERVALS)[number];

export class SalesQueryDto extends DateRangeQueryDto {
  @ApiPropertyOptional({
    enum: REPORT_INTERVALS,
    default: 'day',
    description:
      'The size of each point in the series. Weeks start on Monday. A day range is at most 366 days, week and month ranges at most 3 years.',
  })
  @IsOptional()
  @IsIn(REPORT_INTERVALS)
  interval: ReportInterval = 'day';
}

/**
 * Every money figure in the sales reports, for ONE set of orders: the orders in a revenue status (confirmed, processing, ready to
 * ship, shipped, out for delivery, delivered) placed in the period, days counted in the store time zone. Cancelled, failed,
 * returned and not-yet-paid orders are in none of these figures, and nothing is counted twice:
 *
 *   grossSales      = value of the items, before any discount
 *   discounts       = what discount codes took off those items
 *   refunds         = money returned (processed refunds) for these same orders, whenever the refund happened
 *   netSales        = grossSales - discounts - refunds
 *   shippingAndFees = delivery and cash-on-delivery charges
 *   totalSales      = what customers were charged = grossSales - discounts + shippingAndFees + tax added on top
 *   netRevenue      = totalSales - refunds
 */
export class SalesFiguresDto {
  @ApiProperty() orders!: number;
  @ApiProperty({ description: 'Value of the items before discounts (paise).' })
  grossSalesMinor!: number;
  @ApiProperty({ description: 'Taken off by discount codes (paise).' })
  discountsMinor!: number;
  @ApiProperty({
    description:
      'Processed refunds of these orders (paise). A refund belongs to the period its ORDER was placed in, not the day the money went back, so every figure of a period describes the same set of orders. Refunds are recorded for online payments only; cash-on-delivery returns are not refunds here.',
  })
  refundsMinor!: number;
  @ApiProperty({ description: 'grossSales - discounts - refunds (paise).' })
  netSalesMinor!: number;
  @ApiProperty({
    description: 'Delivery and cash-on-delivery charges (paise).',
  })
  shippingAndFeesMinor!: number;
  @ApiProperty({
    description:
      'GST charged on these orders (paise), whether added on top or already inside the prices.',
  })
  taxMinor!: number;
  @ApiProperty({ description: 'What customers were charged (paise).' })
  totalSalesMinor!: number;
  @ApiProperty({ description: 'totalSales - refunds (paise).' })
  netRevenueMinor!: number;
  @ApiProperty({
    description: 'totalSales / orders (paise); 0 without orders.',
  })
  averageOrderValueMinor!: number;
}

export class SalesPointDto extends SalesFiguresDto {
  @ApiProperty({
    example: '2026-11-02',
    description: 'First day of the day, week (Monday) or month.',
  })
  period!: string;
}

export class SalesComparisonDto {
  @ApiProperty() from!: string;
  @ApiProperty() to!: string;
  @ApiProperty({ type: SalesFiguresDto }) figures!: SalesFiguresDto;
  @ApiProperty({
    description:
      'Change from the previous period, in percent, one decimal. Null when the previous period was 0.',
    type: 'object',
    additionalProperties: { type: 'number', nullable: true },
  })
  changePercent!: Record<string, number | null>;
}

export class SalesReportDto {
  @ApiProperty() from!: string;
  @ApiProperty() to!: string;
  @ApiProperty({ enum: REPORT_INTERVALS }) interval!: string;
  @ApiProperty() currency!: string;
  @ApiProperty({ example: 'Asia/Kolkata' }) timeZone!: string;
  @ApiProperty({ type: SalesFiguresDto }) totals!: SalesFiguresDto;
  @ApiProperty({
    type: SalesComparisonDto,
    description:
      'The same figures for the period of equal length just before this one.',
  })
  previous!: SalesComparisonDto;
  @ApiProperty({
    type: [SalesPointDto],
    description:
      'One point per day, week or month, oldest first, with no gaps (periods without orders show zero). The totals are the sum of these points.',
  })
  series!: SalesPointDto[];
}

// --- Products --------------------------------------------------------------------------------------------------------------

export class ProductReportQueryDto extends PaginationQueryDto {
  @ApiPropertyOptional({ example: '2026-11-01' })
  @IsOptional()
  @Matches(DAY, { message: 'Use a date like 2026-11-01.' })
  from?: string;

  @ApiPropertyOptional({ example: '2026-11-30' })
  @IsOptional()
  @Matches(DAY, { message: 'Use a date like 2026-11-30.' })
  to?: string;

  @ApiPropertyOptional({
    enum: ['units', 'revenue', 'orders'],
    default: 'units',
    description:
      'What to rank by. `sortOrder=desc` (the default) gives the best sellers, `asc` the worst performers (active products nobody bought are included).',
  })
  @IsOptional()
  @IsIn(['units', 'revenue', 'orders'])
  sortBy: 'units' | 'revenue' | 'orders' = 'units';
}

export class ProductPerformanceDto {
  @ApiProperty({ format: 'uuid' }) productId!: string;
  @ApiProperty() name!: string;
  @ApiProperty() slug!: string;
  @ApiProperty() status!: string;
  @ApiProperty({ description: 'Units sold, all variants together.' })
  unitsSold!: number;
  @ApiProperty({
    description:
      'Item value of those units before order-level discounts (paise). Refunds are not split by product.',
  })
  revenueMinor!: number;
  @ApiProperty({ description: 'Orders that contain the product.' })
  orders!: number;
  @ApiProperty({
    nullable: true,
    description:
      'Not available: the store does not record product views, so a conversion rate cannot be worked out. Always null.',
  })
  conversionRatePercent!: number | null;
}

// --- Customers -------------------------------------------------------------------------------------------------------------

export class CustomerReportQueryDto extends DateRangeQueryDto {}

export class CustomerSummaryDto {
  @ApiProperty() from!: string;
  @ApiProperty() to!: string;
  @ApiProperty({ description: 'Customers on file today.' })
  totalCustomers!: number;
  @ApiProperty({ description: 'Customer records created in the period.' })
  newCustomers!: number;
  @ApiProperty({
    description: 'Customers with at least one counted order in the period.',
  })
  buyers!: number;
  @ApiProperty({
    description:
      'Of the buyers: first counted order ever happened in the period.',
  })
  firstTimeBuyers!: number;
  @ApiProperty({
    description: 'Of the buyers: had already bought before the period started.',
  })
  returningCustomers!: number;
  @ApiProperty({
    description:
      'Customers who ever bought more than once, as a share of customers who ever bought (all time, 0 to 100, one decimal).',
  })
  repeatPurchaseRatePercent!: number;
  @ApiProperty({ description: 'Orders in the period per buyer, one decimal.' })
  averageOrdersPerBuyer!: number;
  @ApiProperty({
    description: 'What the average buyer spent in the period (paise).',
  })
  averageSpendPerBuyerMinor!: number;
  @ApiProperty({
    description: 'Average value of an order in the period (paise).',
  })
  averageOrderValueMinor!: number;
}

export class TopCustomerQueryDto extends PaginationQueryDto {
  @ApiPropertyOptional({ example: '2026-11-01' })
  @IsOptional()
  @Matches(DAY, { message: 'Use a date like 2026-11-01.' })
  from?: string;

  @ApiPropertyOptional({ example: '2026-11-30' })
  @IsOptional()
  @Matches(DAY, { message: 'Use a date like 2026-11-30.' })
  to?: string;

  @ApiPropertyOptional({ enum: ['revenue', 'orders'], default: 'revenue' })
  @IsOptional()
  @IsIn(['revenue', 'orders'])
  sortBy: 'revenue' | 'orders' = 'revenue';
}

export class TopCustomerDto {
  @ApiProperty({ format: 'uuid' }) customerId!: string;
  @ApiProperty() fullName!: string;
  @ApiProperty() email!: string;
  @ApiProperty() orders!: number;
  @ApiProperty({
    description:
      'What they were charged on counted orders in the period (paise).',
  })
  revenueMinor!: number;
  @ApiProperty() lastOrderAt!: Date;
}

export class CustomerHistoryQueryDto extends PaginationQueryDto {}

export class CustomerHistoryOrderDto {
  @ApiProperty({ format: 'uuid' }) id!: string;
  @ApiProperty() orderNumber!: number;
  @ApiProperty() status!: string;
  @ApiProperty() paymentStatus!: string;
  @ApiProperty() itemCount!: number;
  @ApiProperty() discountMinor!: number;
  @ApiProperty() totalMinor!: number;
  @ApiProperty({
    description:
      'Whether the order is part of the sales figures (in a revenue status).',
  })
  countsAsSale!: boolean;
  @ApiProperty() placedAt!: Date;
}

export class CustomerHistorySummaryDto {
  @ApiProperty({ format: 'uuid' }) customerId!: string;
  @ApiProperty() fullName!: string;
  @ApiProperty() email!: string;
  @ApiProperty({ description: 'Orders that count as sales, ever.' })
  lifetimeOrders!: number;
  @ApiProperty({
    description: 'What they were charged on those orders (paise).',
  })
  lifetimeRevenueMinor!: number;
  @ApiProperty({
    description: 'Average of those orders (paise); 0 without any.',
  })
  averageOrderValueMinor!: number;
  @ApiProperty({ nullable: true }) firstOrderAt!: Date | null;
  @ApiProperty({ nullable: true }) lastOrderAt!: Date | null;
}

export class CustomerHistoryDto extends CustomerHistorySummaryDto {
  @ApiProperty({
    type: [CustomerHistoryOrderDto],
    description: 'Every order of the customer, newest first, a page at a time.',
  })
  orders!: CustomerHistoryOrderDto[];
  @ApiProperty() page!: number;
  @ApiProperty() limit!: number;
  @ApiProperty({
    description: 'All orders of the customer, whatever their status.',
  })
  totalOrders!: number;
}
