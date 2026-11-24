import {
  ApiProperty,
  ApiPropertyOptional,
  OmitType,
  PartialType,
} from '@nestjs/swagger';
import { Transform, Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsBoolean,
  IsDateString,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  IsUUID,
  Matches,
  Max,
  MaxLength,
  Min,
} from 'class-validator';
import { PaginationQueryDto } from '../../common/dto/pagination-query.dto.js';
import {
  DISCOUNT_KINDS,
  DISCOUNT_SCOPES,
} from '../../database/schema/marketing.js';

export const DISCOUNT_STATUSES = [
  'active',
  'disabled',
  'scheduled',
  'expired',
  'exhausted',
  'campaign_inactive',
] as const;

const MAX_TARGETS = 200;
const upper = ({ value }: { value: unknown }) =>
  typeof value === 'string' ? value.trim().toUpperCase() : value;
const blankToNull = ({ value }: { value: unknown }) =>
  typeof value === 'string' ? value.trim() || null : value;

export class CreateDiscountDto {
  @ApiProperty({
    example: 'WELCOME10',
    description:
      '3 to 32 letters, numbers, `-` or `_`. Stored in capitals and unique in your store; it cannot be changed later.',
  })
  @Transform(upper)
  @Matches(/^[A-Z0-9][A-Z0-9_-]{2,31}$/, {
    message:
      'Use 3 to 32 letters, numbers, hyphens or underscores, starting with a letter or number.',
  })
  code!: string;

  @ApiPropertyOptional({ nullable: true, maxLength: 500 })
  @IsOptional()
  @Transform(blankToNull)
  @IsString()
  @MaxLength(500)
  description?: string | null;

  @ApiProperty({ enum: DISCOUNT_KINDS })
  @IsIn(DISCOUNT_KINDS, { message: 'Choose percentage or fixed amount.' })
  kind!: (typeof DISCOUNT_KINDS)[number];

  @ApiProperty({
    description:
      'Percentage: basis points, 1 to 10000 (1000 = 10%). Fixed: the amount off, in paise.',
    example: 1000,
  })
  @Type(() => Number)
  @IsInt({ message: 'Enter a whole number.' })
  @Min(1, { message: 'The discount must be more than zero.' })
  @Max(1_000_000_000)
  value!: number;

  @ApiPropertyOptional({
    default: 0,
    description:
      'The items the code applies to must add up to at least this much (paise).',
  })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  @Max(1_000_000_000)
  minSubtotalMinor?: number;

  @ApiPropertyOptional({
    nullable: true,
    description:
      'The most one order can be discounted (paise). Percentage codes only.',
  })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(1_000_000_000)
  maxDiscountMinor?: number | null;

  @ApiPropertyOptional({ nullable: true, example: '2026-12-01T00:00:00Z' })
  @IsOptional()
  @IsDateString()
  startsAt?: string | null;

  @ApiPropertyOptional({ nullable: true, example: '2026-12-31T23:59:59Z' })
  @IsOptional()
  @IsDateString()
  expiresAt?: string | null;

  @ApiPropertyOptional({
    nullable: true,
    description: 'How many orders may use the code in total.',
  })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100_000_000)
  usageLimit?: number | null;

  @ApiPropertyOptional({
    nullable: true,
    description: 'How many orders one customer (by email) may use it on.',
  })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(1_000_000)
  perCustomerLimit?: number | null;

  @ApiPropertyOptional({ enum: DISCOUNT_SCOPES, default: 'all' })
  @IsOptional()
  @IsIn(DISCOUNT_SCOPES)
  appliesTo?: (typeof DISCOUNT_SCOPES)[number];

  @ApiPropertyOptional({
    type: [String],
    description: 'Required when `appliesTo` is `products`.',
  })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(MAX_TARGETS)
  @IsUUID('all', { each: true })
  productIds?: string[];

  @ApiPropertyOptional({
    type: [String],
    description: 'Required when `appliesTo` is `collections`.',
  })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(MAX_TARGETS)
  @IsUUID('all', { each: true })
  collectionIds?: string[];

  @ApiPropertyOptional({
    nullable: true,
    format: 'uuid',
    description:
      'Put the code in a campaign: it then works only while the campaign is live.',
  })
  @IsOptional()
  @IsUUID()
  campaignId?: string | null;

  @ApiPropertyOptional({ default: true })
  @IsOptional()
  @IsBoolean()
  isActive?: boolean;
}

/** Every field is optional; `null` clears an optional setting, a missing field is left alone. The code itself never changes. */
export class UpdateDiscountDto extends PartialType(
  OmitType(CreateDiscountDto, ['code'] as const),
) {}

export class DiscountListQueryDto extends PaginationQueryDto {
  @ApiPropertyOptional({ enum: DISCOUNT_STATUSES })
  @IsOptional()
  @IsIn(DISCOUNT_STATUSES)
  status?: (typeof DISCOUNT_STATUSES)[number];

  @ApiPropertyOptional({ format: 'uuid' })
  @IsOptional()
  @IsUUID()
  campaignId?: string;

  @ApiPropertyOptional({
    enum: ['createdAt', 'code', 'redemptions'],
    default: 'createdAt',
  })
  @IsOptional()
  @IsIn(['createdAt', 'code', 'redemptions'])
  sortBy: 'createdAt' | 'code' | 'redemptions' = 'createdAt';
}

export class DiscountPerformanceDto {
  @ApiProperty({
    description:
      'Orders using the code now (cancelled and failed orders are not counted).',
  })
  redemptions!: number;
  @ApiProperty({ description: 'Total taken off those orders (paise).' })
  discountTotalMinor!: number;
  @ApiProperty({
    description:
      'Items value (before the discount) of the orders that are paid or being fulfilled (paise).',
  })
  grossSalesMinor!: number;
  @ApiProperty({
    description:
      'What those orders brought in after the discount, before refunds (paise).',
  })
  netSalesMinor!: number;
  @ApiProperty({ description: 'Average order value of those orders (paise).' })
  averageOrderMinor!: number;
}

export class DiscountTargetDto {
  @ApiProperty({ format: 'uuid' }) id!: string;
  @ApiProperty() name!: string;
}

export class DiscountDto {
  @ApiProperty({ format: 'uuid' }) id!: string;
  @ApiProperty() code!: string;
  @ApiPropertyOptional({ nullable: true }) description!: string | null;
  @ApiProperty({ enum: DISCOUNT_KINDS }) kind!: string;
  @ApiProperty() value!: number;
  @ApiProperty() minSubtotalMinor!: number;
  @ApiPropertyOptional({ nullable: true }) maxDiscountMinor!: number | null;
  @ApiPropertyOptional({ nullable: true }) startsAt!: Date | null;
  @ApiPropertyOptional({ nullable: true }) expiresAt!: Date | null;
  @ApiPropertyOptional({ nullable: true }) usageLimit!: number | null;
  @ApiPropertyOptional({ nullable: true }) perCustomerLimit!: number | null;
  @ApiProperty({ enum: DISCOUNT_SCOPES }) appliesTo!: string;
  @ApiProperty() isActive!: boolean;
  @ApiProperty({ enum: DISCOUNT_STATUSES }) status!: string;
  @ApiPropertyOptional({ nullable: true, format: 'uuid' }) campaignId!:
    string | null;
  @ApiPropertyOptional({ nullable: true }) campaignName!: string | null;
  @ApiProperty({ type: DiscountPerformanceDto })
  performance!: DiscountPerformanceDto;
  @ApiProperty() createdAt!: Date;
  @ApiProperty() updatedAt!: Date;
}

export class DiscountDetailDto extends DiscountDto {
  @ApiProperty({ type: [DiscountTargetDto] })
  products!: DiscountTargetDto[];
  @ApiProperty({ type: [DiscountTargetDto] })
  collections!: DiscountTargetDto[];
}
