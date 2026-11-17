import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsIn, IsOptional } from 'class-validator';
import { InventoryRowDto } from '../inventory/inventory.dto.js';

export const RANGES = [7, 30, 90] as const;
export type RangeDays = (typeof RANGES)[number];

export class AnalyticsQueryDto {
  @ApiPropertyOptional({
    enum: RANGES,
    default: 30,
    description: 'How many days back to look: 7, 30 or 90.',
  })
  @IsOptional()
  @Type(() => Number)
  @IsIn(RANGES)
  range: RangeDays = 30;
}

export class SeriesPointDto {
  @ApiProperty({
    example: '2026-11-10',
    description: 'The calendar day, based on your store time zone.',
  })
  day!: string;
  @ApiProperty({
    description:
      "Total sales for the day from paid and fulfilled orders, in the currency's smallest unit (for example cents).",
  })
  salesMinor!: number;
  @ApiProperty({
    description:
      'Number of orders placed that day, not counting cancelled ones.',
  })
  orders!: number;
}

export class BestSellerDto {
  @ApiProperty() name!: string;
  @ApiProperty() units!: number;
  @ApiProperty() salesMinor!: number;
}

export class RecentOrderDto {
  @ApiProperty({ format: 'uuid' }) id!: string;
  @ApiProperty() orderNumber!: number;
  @ApiProperty() status!: string;
  @ApiProperty() totalMinor!: number;
  @ApiProperty() placedAt!: Date;
  @ApiPropertyOptional({ nullable: true }) customerName!: string | null;
}

export class AnalyticsDto {
  @ApiProperty({ enum: RANGES }) range!: number;
  @ApiProperty({
    description:
      'Stays false until the store has received at least one order, whatever its status.',
  })
  hasOrders!: boolean;
  @ApiProperty() totalSalesMinor!: number;
  @ApiProperty({
    description:
      'Sales in the period just before this one, so you can compare the two.',
  })
  previousSalesMinor!: number;
  @ApiProperty() orders!: number;
  @ApiProperty() customers!: number;
  @ApiProperty() averageOrderMinor!: number;
  @ApiProperty({
    type: [SeriesPointDto],
    description:
      'One entry for every day in the period. Days with no orders show zero.',
  })
  series!: SeriesPointDto[];
  @ApiProperty({ type: [BestSellerDto] }) bestSellers!: BestSellerDto[];
  @ApiProperty({ type: [RecentOrderDto] }) recentOrders!: RecentOrderDto[];
  @ApiProperty({
    type: [InventoryRowDto],
    description:
      'Items that are out of stock, followed by items running low, with at most 8 shown.',
  })
  lowStock!: InventoryRowDto[];
  @ApiProperty({ example: 'INR' }) currency!: string;
  @ApiProperty({ example: 'Asia/Kolkata' }) timezone!: string;
}
