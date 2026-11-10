import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsIn, IsInt, IsOptional, Matches, Max, Min } from 'class-validator';
import { PaginationQueryDto } from '../../../common/dto/pagination-query.dto.js';

export const INACTIVE_DAY_OPTIONS = [30, 60, 90] as const;
const DATE = /^\d{4}-\d{2}-\d{2}$/;

export class OrgUsageDto {
  @ApiProperty() products!: number;
  @ApiProperty() customers!: number;
  @ApiProperty() orders!: number;
  @ApiPropertyOptional({
    nullable: true,
    description:
      'Bytes in the products bucket, or null when it cannot be measured (not the same as 0).',
  })
  storageBytes!: number | null;
  @ApiPropertyOptional({
    nullable: true,
    description:
      'Latest change to products, customers, orders, stock, categories or collections; null when there has been none.',
  })
  lastActivity!: Date | null;
  @ApiProperty() createdAt!: Date;
  @ApiProperty({ enum: ['active', 'suspended'] }) status!: string;
}

export class OrgUsageRowDto extends OrgUsageDto {
  @ApiProperty({ format: 'uuid' }) id!: string;
  @ApiProperty() name!: string;
  @ApiProperty() slug!: string;
}

export class UsageSummaryDto {
  @ApiProperty() totalOrganizations!: number;
  @ApiProperty() active!: number;
  @ApiProperty() suspended!: number;
  @ApiProperty({
    description:
      'Created before the window and with no merchant activity inside it.',
  })
  inactive!: number;
  @ApiPropertyOptional({
    nullable: true,
    description: 'Null when Storage cannot be measured.',
  })
  storageTotalBytes!: number | null;
}

export class InactiveOrgDto {
  @ApiProperty({ format: 'uuid' }) id!: string;
  @ApiProperty() name!: string;
  @ApiProperty() slug!: string;
  @ApiProperty({ enum: ['active', 'suspended'] }) status!: string;
  @ApiProperty() createdAt!: Date;
  @ApiPropertyOptional({ nullable: true }) lastActivity!: Date | null;
}

export class InactiveOrgsDto {
  @ApiProperty({ type: [InactiveOrgDto] }) rows!: InactiveOrgDto[];
  @ApiProperty({
    description:
      'How many organizations match, of which `rows` shows the first ones.',
  })
  total!: number;
}

export class SeriesPointDto {
  @ApiProperty({ example: '2026-11-01', description: 'Start of the bucket.' })
  start!: string;
  @ApiProperty() created!: number;
}

export class NewOrganizationsSeriesDto {
  @ApiProperty({ example: '2026-08-12' }) from!: string;
  @ApiProperty({ example: '2026-11-10' }) to!: string;
  @ApiProperty({ enum: ['day', 'week', 'month'] }) bucket!: string;
  @ApiProperty({ type: [SeriesPointDto] }) points!: SeriesPointDto[];
  @ApiProperty() total!: number;
}

export class UsageListQueryDto extends PaginationQueryDto {
  @ApiPropertyOptional({ enum: ['all', 'active', 'suspended'], default: 'all' })
  @IsOptional()
  @IsIn(['all', 'active', 'suspended'])
  status: 'all' | 'active' | 'suspended' = 'all';

  @ApiPropertyOptional({ enum: ['created', 'name'], default: 'created' })
  @IsOptional()
  @IsIn(['created', 'name'])
  sortBy: 'created' | 'name' = 'created';
}

export class UsageSummaryQueryDto {
  @ApiPropertyOptional({
    enum: INACTIVE_DAY_OPTIONS,
    default: 30,
    description: 'How far back "no recent activity" looks.',
  })
  @IsOptional()
  @Type(() => Number)
  @IsIn(INACTIVE_DAY_OPTIONS)
  inactiveDays: (typeof INACTIVE_DAY_OPTIONS)[number] = 30;
}

export class InactiveQueryDto {
  @ApiPropertyOptional({ enum: INACTIVE_DAY_OPTIONS, default: 30 })
  @IsOptional()
  @Type(() => Number)
  @IsIn(INACTIVE_DAY_OPTIONS)
  days: (typeof INACTIVE_DAY_OPTIONS)[number] = 30;

  @ApiPropertyOptional({ default: 10, minimum: 1, maximum: 100 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  limit: number = 10;
}

export class SeriesQueryDto {
  @ApiPropertyOptional({
    example: '2026-08-12',
    description: 'Defaults to 90 days before `to`.',
  })
  @IsOptional()
  @Matches(DATE, { message: 'from must be YYYY-MM-DD.' })
  from?: string;

  @ApiPropertyOptional({
    example: '2026-11-10',
    description: 'Defaults to today (UTC).',
  })
  @IsOptional()
  @Matches(DATE, { message: 'to must be YYYY-MM-DD.' })
  to?: string;
}
