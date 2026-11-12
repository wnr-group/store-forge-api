import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsIn, IsOptional, IsUUID, Matches } from 'class-validator';
import { PaginationQueryDto } from '../../../common/dto/pagination-query.dto.js';
import { AUDIT_ACTIONS } from './audit-actions.js';

const DATE = /^\d{4}-\d{2}-\d{2}$/;

export class AuditLogDto {
  @ApiProperty({ format: 'uuid' }) id!: string;
  @ApiProperty({ format: 'uuid' }) adminUserId!: string;
  @ApiProperty() adminEmail!: string;
  @ApiProperty({ example: 'organization.created' }) action!: string;
  @ApiProperty() entityType!: string;
  @ApiPropertyOptional({ format: 'uuid', nullable: true }) entityId!:
    string | null;
  @ApiPropertyOptional({ format: 'uuid', nullable: true }) organizationId!:
    string | null;
  @ApiPropertyOptional({ nullable: true }) organizationName!: string | null;
  @ApiProperty() description!: string;
  @ApiPropertyOptional({
    nullable: true,
    type: 'object',
    additionalProperties: true,
  })
  previousData!: unknown;
  @ApiPropertyOptional({
    nullable: true,
    type: 'object',
    additionalProperties: true,
  })
  newData!: unknown;
  @ApiProperty() createdAt!: Date;
}

export class AuditAdminDto {
  @ApiProperty({ format: 'uuid' }) id!: string;
  @ApiProperty() email!: string;
}

export class AuditQueryDto extends PaginationQueryDto {
  @ApiPropertyOptional({ enum: ['all', ...AUDIT_ACTIONS], default: 'all' })
  @IsOptional()
  @IsIn(['all', ...AUDIT_ACTIONS])
  action: 'all' | (typeof AUDIT_ACTIONS)[number] = 'all';

  @ApiPropertyOptional({
    description:
      'The id of an admin to show only their actions, or `all` to show everyone.',
    default: 'all',
  })
  @IsOptional()
  @Matches(
    /^(all|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i,
    {
      message: 'admin must be an administrator id or "all".',
    },
  )
  admin: string = 'all';

  @ApiPropertyOptional({
    format: 'uuid',
    description: 'Show only the actions that affected this organization.',
  })
  @IsOptional()
  @IsUUID()
  org?: string;

  @ApiPropertyOptional({
    example: '2026-11-01',
    description: 'The first day to include, as a UTC date (YYYY-MM-DD).',
  })
  @IsOptional()
  @Matches(DATE, { message: 'from must be YYYY-MM-DD.' })
  from?: string;

  @ApiPropertyOptional({
    example: '2026-11-30',
    description: 'The last day to include, as a UTC date (YYYY-MM-DD).',
  })
  @IsOptional()
  @Matches(DATE, { message: 'to must be YYYY-MM-DD.' })
  to?: string;
}
