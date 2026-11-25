import { ApiProperty, ApiPropertyOptional, PartialType } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsDateString,
  IsIn,
  IsOptional,
  IsString,
  IsUUID,
  MaxLength,
  MinLength,
} from 'class-validator';
import { PaginationQueryDto } from '../../common/dto/pagination-query.dto.js';
import { CAMPAIGN_STATUSES } from '../../database/schema/marketing.js';
import { DiscountPerformanceDto, DiscountTargetDto } from './discounts.dto.js';

const trim = ({ value }: { value: unknown }) =>
  typeof value === 'string' ? value.trim() : value;
const blankToNull = ({ value }: { value: unknown }) =>
  typeof value === 'string' ? value.trim() || null : value;

export const CAMPAIGN_PHASES = [
  'draft',
  'scheduled',
  'live',
  'paused',
  'ended',
] as const;

export class CreateCampaignDto {
  @ApiProperty({
    maxLength: 120,
    description:
      'Unique in your store (capital letters do not make it different).',
  })
  @Transform(trim)
  @IsString()
  @MinLength(1, { message: 'Enter a campaign name.' })
  @MaxLength(120)
  name!: string;

  @ApiPropertyOptional({ nullable: true, maxLength: 2000 })
  @IsOptional()
  @Transform(blankToNull)
  @IsString()
  @MaxLength(2000)
  description?: string | null;

  @ApiPropertyOptional({ nullable: true, example: '2026-11-01T00:00:00Z' })
  @IsOptional()
  @IsDateString()
  startsAt?: string | null;

  @ApiPropertyOptional({ nullable: true, example: '2026-11-15T23:59:59Z' })
  @IsOptional()
  @IsDateString()
  endsAt?: string | null;

  @ApiPropertyOptional({
    type: [String],
    description: 'The products the campaign is about.',
  })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(200)
  @IsUUID('all', { each: true })
  productIds?: string[];

  @ApiPropertyOptional({
    type: [String],
    description: 'The collections the campaign is about.',
  })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(200)
  @IsUUID('all', { each: true })
  collectionIds?: string[];

  @ApiPropertyOptional({
    type: [String],
    description:
      'The discount codes that belong to the campaign. They work only while the campaign is live. A code can be in one campaign.',
  })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(200)
  @IsUUID('all', { each: true })
  discountIds?: string[];
}

/** Every field is optional; a missing field is left alone, `null` clears a date. A list that is sent replaces the stored one. */
export class UpdateCampaignDto extends PartialType(CreateCampaignDto) {}

export class CampaignStatusDto {
  @ApiProperty({ enum: CAMPAIGN_STATUSES })
  @IsIn(CAMPAIGN_STATUSES, { message: 'Choose a valid status.' })
  status!: (typeof CAMPAIGN_STATUSES)[number];
}

export class CampaignListQueryDto extends PaginationQueryDto {
  @ApiPropertyOptional({ enum: CAMPAIGN_STATUSES })
  @IsOptional()
  @IsIn(CAMPAIGN_STATUSES)
  status?: (typeof CAMPAIGN_STATUSES)[number];

  @ApiPropertyOptional({
    enum: ['createdAt', 'name', 'startsAt'],
    default: 'createdAt',
  })
  @IsOptional()
  @IsIn(['createdAt', 'name', 'startsAt'])
  sortBy: 'createdAt' | 'name' | 'startsAt' = 'createdAt';
}

export class CampaignPerformanceDto extends DiscountPerformanceDto {
  @ApiProperty({ description: 'How many discount codes belong to it.' })
  discountCodes!: number;
}

export class CampaignDto {
  @ApiProperty({ format: 'uuid' }) id!: string;
  @ApiProperty() name!: string;
  @ApiPropertyOptional({ nullable: true }) description!: string | null;
  @ApiProperty({ enum: CAMPAIGN_STATUSES, description: 'What the owner set.' })
  status!: string;
  @ApiProperty({
    enum: CAMPAIGN_PHASES,
    description:
      'What it is doing now: an active campaign is `scheduled` before its start and `ended` after its end.',
  })
  phase!: string;
  @ApiPropertyOptional({ nullable: true }) startsAt!: Date | null;
  @ApiPropertyOptional({ nullable: true }) endsAt!: Date | null;
  @ApiProperty({ type: CampaignPerformanceDto })
  performance!: CampaignPerformanceDto;
  @ApiProperty() createdAt!: Date;
  @ApiProperty() updatedAt!: Date;
}

export class CampaignCodeDto {
  @ApiProperty({ format: 'uuid' }) id!: string;
  @ApiProperty() code!: string;
  @ApiProperty() isActive!: boolean;
}

export class CampaignDetailDto extends CampaignDto {
  @ApiProperty({ type: [DiscountTargetDto] }) products!: DiscountTargetDto[];
  @ApiProperty({ type: [DiscountTargetDto] })
  collections!: DiscountTargetDto[];
  @ApiProperty({ type: [CampaignCodeDto] }) discounts!: CampaignCodeDto[];
}
