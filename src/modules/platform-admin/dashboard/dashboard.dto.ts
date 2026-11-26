import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsOptional, Matches } from 'class-validator';
import { BillingSummaryDto } from '../../billing/billing.dto.js';
import { AuditLogDto } from '../audit/audit.dto.js';

export class DashboardQueryDto {
  @ApiPropertyOptional({
    example: '2026-09-01',
    description:
      'Start of the range for growth and payments. Default: 90 days ago.',
  })
  @IsOptional()
  @Matches(/^\d{4}-\d{2}-\d{2}$/, { message: 'from must be YYYY-MM-DD.' })
  from?: string;

  @ApiPropertyOptional({
    example: '2026-11-30',
    description: 'End of the range. Default: today.',
  })
  @IsOptional()
  @Matches(/^\d{4}-\d{2}-\d{2}$/, { message: 'to must be YYYY-MM-DD.' })
  to?: string;
}

class DashboardTenantsDto {
  @ApiProperty() total!: number;
  @ApiProperty() active!: number;
  @ApiProperty() suspended!: number;
  @ApiProperty({
    description: 'People with an account in any organization, counted once.',
  })
  users!: number;
}

class DashboardSubscriptionsDto {
  @ApiProperty() active!: number;
  @ApiProperty({ description: 'In a trial that has not ended.' })
  trialing!: number;
  @ApiProperty({
    description: 'Unpaid past the due date but still inside the grace period.',
  })
  pastDue!: number;
  @ApiProperty({
    description: 'Expired, plus trials whose end date has passed.',
  })
  expired!: number;
  @ApiProperty() canceled!: number;
}

class GrowthPointDto {
  @ApiProperty({ example: '2026-11-03' }) date!: string;
  @ApiProperty() count!: number;
}

class DashboardGrowthDto {
  @ApiProperty({ enum: ['day', 'week', 'month'] }) bucket!: string;
  @ApiProperty({
    type: [GrowthPointDto],
    description: 'Subscriptions started in each bucket.',
  })
  newSubscriptions!: GrowthPointDto[];
  @ApiProperty({
    type: [GrowthPointDto],
    description: 'Organizations created in each bucket.',
  })
  newOrganizations!: GrowthPointDto[];
}

class DashboardHealthDto {
  @ApiProperty({ enum: ['up'] }) api!: string;
  @ApiProperty({ enum: ['up', 'down'] }) database!: string;
}

export class DashboardDto {
  @ApiProperty() from!: string;
  @ApiProperty() to!: string;
  @ApiProperty({ type: DashboardTenantsDto }) tenants!: DashboardTenantsDto;
  @ApiProperty({ type: DashboardSubscriptionsDto })
  subscriptions!: DashboardSubscriptionsDto;
  @ApiProperty({ type: DashboardGrowthDto }) growth!: DashboardGrowthDto;
  @ApiPropertyOptional({
    type: BillingSummaryDto,
    nullable: true,
    description:
      'Revenue and payments. Empty for roles that cannot read billing.',
  })
  billing!: BillingSummaryDto | null;
  @ApiPropertyOptional({
    type: [AuditLogDto],
    nullable: true,
    description:
      'The latest administrative actions. Empty for roles that cannot read the audit log.',
  })
  recentActivity!: AuditLogDto[] | null;
  @ApiProperty({ type: DashboardHealthDto }) health!: DashboardHealthDto;
}
