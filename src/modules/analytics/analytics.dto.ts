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
    description: 'Window in days.',
  })
  @IsOptional()
  @Type(() => Number)
  @IsIn(RANGES)
  range: RangeDays = 30;
}

export class SeriesPointDto {
  @ApiProperty({
    example: '2026-11-10',
    description: 'Calendar day in the store timezone.',
  })
  day!: string;
  @ApiProperty({ description: 'Paid + fulfilled sales, minor units.' })
  salesMinor!: number;
  @ApiProperty({ description: 'Orders that day, excluding cancelled.' })
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
    description: 'False until the store has at least one order of any status.',
  })
  hasOrders!: boolean;
  @ApiProperty() totalSalesMinor!: number;
  @ApiProperty({
    description: 'Sales in the window just before this one, for comparison.',
  })
  previousSalesMinor!: number;
  @ApiProperty() orders!: number;
  @ApiProperty() customers!: number;
  @ApiProperty() averageOrderMinor!: number;
  @ApiProperty({
    type: [SeriesPointDto],
    description: 'One point per day, zero-filled.',
  })
  series!: SeriesPointDto[];
  @ApiProperty({ type: [BestSellerDto] }) bestSellers!: BestSellerDto[];
  @ApiProperty({ type: [RecentOrderDto] }) recentOrders!: RecentOrderDto[];
  @ApiProperty({
    type: [InventoryRowDto],
    description: 'Out-of-stock then low-stock units, at most 8.',
  })
  lowStock!: InventoryRowDto[];
  @ApiProperty({ example: 'INR' }) currency!: string;
  @ApiProperty({ example: 'Asia/Kolkata' }) timezone!: string;
}
