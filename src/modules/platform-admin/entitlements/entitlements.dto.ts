import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsBoolean, IsIn, IsOptional } from 'class-validator';
import { PaginationQueryDto } from '../../../common/dto/pagination-query.dto.js';
import { Check, OptionalText } from '../../../common/validation/fields.js';
import { EntitlementsDto } from '../../entitlements/entitlements.dto.js';

export class FeatureOverrideDto {
  @ApiProperty({ example: 'google_analytics' }) key!: string;
  @ApiProperty() enabled!: boolean;
  @ApiPropertyOptional({ nullable: true }) note!: string | null;
  @ApiProperty() updatedAt!: Date;
}
export class LimitOverrideDto {
  @ApiProperty({ example: 'products' }) key!: string;
  @ApiPropertyOptional({ nullable: true }) soft!: number | null;
  @ApiPropertyOptional({ nullable: true }) hard!: number | null;
  @ApiPropertyOptional({ nullable: true }) note!: string | null;
  @ApiProperty() updatedAt!: Date;
}

export class TenantEntitlementsDto extends EntitlementsDto {
  @ApiProperty({
    type: [FeatureOverrideDto],
    description:
      'Exceptions set for this organization only; they win over the plan.',
  })
  featureOverrides!: FeatureOverrideDto[];
  @ApiProperty({ type: [LimitOverrideDto] })
  limitOverrides!: LimitOverrideDto[];
}

export class SetFeatureOverrideDto {
  @ApiProperty({
    nullable: true,
    description:
      '`true` or `false` to force the feature on or off for this organization, or `null` to remove the exception and follow the plan again.',
  })
  @Check(
    (v) => v === null || typeof v === 'boolean',
    'enabled must be true, false or null (remove the exception).',
  )
  enabled!: boolean | null;

  @ApiPropertyOptional({
    nullable: true,
    maxLength: 200,
    description: 'Why the exception exists. Shown to other admins.',
  })
  @OptionalText('Note', 200)
  note?: string | null;
}

const wholeOrNull = (v: unknown) =>
  v === undefined ||
  v === null ||
  (typeof v === 'number' && Number.isSafeInteger(v) && v >= 0);

export class SetLimitOverrideDto {
  @ApiPropertyOptional({
    description:
      "Remove this organization's own limit so the plan applies again.",
  })
  @IsOptional()
  @IsBoolean()
  clear?: boolean;

  @ApiPropertyOptional({
    nullable: true,
    description: 'Warn from this number. Empty means no warning level.',
  })
  @Check(wholeOrNull, 'soft must be a whole number of 0 or more.')
  soft?: number | null;

  @ApiPropertyOptional({
    nullable: true,
    description:
      'Refuse past this number. Empty means unlimited for this organization, whatever the plan says.',
  })
  @Check(wholeOrNull, 'hard must be a whole number of 0 or more.')
  hard?: number | null;

  @ApiPropertyOptional({ nullable: true, maxLength: 200 })
  @OptionalText('Note', 200)
  note?: string | null;
}

export class LimitUsageQueryDto extends PaginationQueryDto {
  @ApiPropertyOptional({
    enum: ['all', 'attention', 'warning', 'reached'],
    default: 'all',
    description:
      '`attention` = warning or reached; `warning` = close to a limit; `reached` = at or past a hard limit.',
  })
  @IsOptional()
  @IsIn(['all', 'attention', 'warning', 'reached'])
  filter: 'all' | 'attention' | 'warning' | 'reached' = 'attention';
}

export class LimitUsageItemDto {
  @ApiProperty({ example: 'products' }) key!: string;
  @ApiProperty() used!: number;
  @ApiPropertyOptional({ nullable: true }) soft!: number | null;
  @ApiPropertyOptional({ nullable: true }) hard!: number | null;
  @ApiPropertyOptional({ nullable: true }) percent!: number | null;
  @ApiProperty({ enum: ['ok', 'warning', 'reached'] }) level!: string;
}

export class LimitUsageRowDto {
  @ApiProperty({ format: 'uuid' }) id!: string;
  @ApiProperty() name!: string;
  @ApiProperty() slug!: string;
  @ApiProperty({ enum: ['active', 'suspended'] }) status!: string;
  @ApiProperty() planCode!: string;
  @ApiProperty() planName!: string;
  @ApiProperty() subscriptionStatus!: string;
  @ApiProperty() isUnrestricted!: boolean;
  @ApiProperty({ enum: ['ok', 'warning', 'reached'] }) worstLevel!: string;
  @ApiProperty({ type: [LimitUsageItemDto] }) limits!: LimitUsageItemDto[];
}
