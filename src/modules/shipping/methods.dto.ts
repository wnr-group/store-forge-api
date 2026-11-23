import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform, Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsBoolean,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  IsUUID,
  Max,
  MaxLength,
  Min,
  MinLength,
  ValidateNested,
} from 'class-validator';
import {
  SHIPPING_METHOD_KINDS,
  SHIPPING_PRICING_TYPES,
} from '../../database/schema/shipping.js';

const trim = ({ value }: { value: unknown }) =>
  typeof value === 'string' ? value.trim() : value;
const MONEY_MAX = 100_000_000_000;

export class RateTierDto {
  @ApiProperty({
    minimum: 0,
    description:
      'Where the band starts (inclusive): grams for a weight method, paise for an order-value method.',
  })
  @IsInt()
  @Min(0)
  @Max(MONEY_MAX)
  from!: number;

  @ApiPropertyOptional({
    nullable: true,
    description:
      'Where the band ends (exclusive). Leave out or null for "and above": only the last band.',
  })
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(MONEY_MAX)
  to?: number | null;

  @ApiProperty({
    minimum: 0,
    description: 'The charge for this band, in paise.',
  })
  @IsInt()
  @Min(0)
  @Max(MONEY_MAX)
  rateMinor!: number;
}

export class SaveMethodDto {
  @ApiProperty({
    format: 'uuid',
    description:
      'The zone this method belongs to. It cannot be moved to another zone later.',
  })
  @IsUUID()
  zoneId!: string;

  @ApiProperty({ example: 'Standard delivery', minLength: 1, maxLength: 80 })
  @Transform(trim)
  @IsString()
  @MinLength(1, { message: 'Enter a name for the method.' })
  @MaxLength(80)
  name!: string;

  @ApiPropertyOptional({ enum: SHIPPING_METHOD_KINDS, default: 'standard' })
  @IsOptional()
  @IsIn(SHIPPING_METHOD_KINDS)
  kind?: (typeof SHIPPING_METHOD_KINDS)[number];

  @ApiProperty({
    enum: SHIPPING_PRICING_TYPES,
    description:
      '`flat`: one price. `free`: always free. `weight`: price bands by parcel weight. `order_value`: price bands by items subtotal. `carrier`: a live quote from your connected carriers (plus handling).',
  })
  @IsIn(SHIPPING_PRICING_TYPES, {
    message: 'Choose how this method is priced.',
  })
  pricingType!: (typeof SHIPPING_PRICING_TYPES)[number];

  @ApiPropertyOptional({
    minimum: 0,
    description: 'The price in paise for a `flat` method.',
  })
  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(MONEY_MAX)
  flatRateMinor?: number;

  @ApiPropertyOptional({
    nullable: true,
    minimum: 0,
    description:
      'Shipping is free once the items subtotal reaches this (paise). Not for `free` methods.',
  })
  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(MONEY_MAX)
  freeOverMinor?: number | null;

  @ApiPropertyOptional({
    minimum: 0,
    description: 'Added to a `carrier` quote (paise): packing, your margin.',
  })
  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(MONEY_MAX)
  handlingMinor?: number;

  @ApiPropertyOptional({
    minimum: 0,
    default: 0,
    description:
      'The smallest items subtotal (paise) this method is offered for.',
  })
  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(MONEY_MAX)
  minOrderMinor?: number;

  @ApiPropertyOptional({
    nullable: true,
    description:
      'The largest items subtotal (paise) this method is offered for.',
  })
  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(MONEY_MAX)
  maxOrderMinor?: number | null;

  @ApiPropertyOptional({
    minimum: 0,
    default: 0,
    description: 'The lightest parcel (grams) this method takes.',
  })
  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(1_000_000_000)
  minWeightGrams?: number;

  @ApiPropertyOptional({
    nullable: true,
    description: 'The heaviest parcel (grams) this method takes.',
  })
  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(1_000_000_000)
  maxWeightGrams?: number | null;

  @ApiPropertyOptional({
    nullable: true,
    minimum: 0,
    maximum: 120,
    description:
      'Estimated delivery time in days, shortest. Give both or neither.',
  })
  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(120)
  estimatedDaysMin?: number | null;

  @ApiPropertyOptional({
    nullable: true,
    minimum: 0,
    maximum: 120,
    description: 'Estimated delivery time in days, longest.',
  })
  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(120)
  estimatedDaysMax?: number | null;

  @ApiPropertyOptional({
    default: true,
    description:
      'Whether cash on delivery may be used with this method (the zone must allow it too).',
  })
  @IsOptional()
  @IsBoolean()
  codAllowed?: boolean;

  @ApiPropertyOptional({
    nullable: true,
    example: 'delhivery',
    description:
      'For a `carrier` method: only quote from this carrier. Leave out to compare all your connected carriers.',
  })
  @IsOptional()
  @IsString()
  @MaxLength(31)
  carrierCode?: string | null;

  @ApiPropertyOptional({
    default: 0,
    description: 'Lower numbers are listed first.',
  })
  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(10000)
  sortOrder?: number;

  @ApiPropertyOptional({ default: true })
  @IsOptional()
  @IsBoolean()
  enabled?: boolean;

  @ApiPropertyOptional({
    type: [RateTierDto],
    description:
      'Required for `weight` and `order_value` methods, not allowed for others. Bands must start at 0, join up with no gap or overlap, and the last must have no upper limit.',
  })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(50)
  @ValidateNested({ each: true })
  @Type(() => RateTierDto)
  tiers?: RateTierDto[];
}

export class MethodListQueryDto {
  @ApiPropertyOptional({
    format: 'uuid',
    description: 'Only the methods of this zone.',
  })
  @IsOptional()
  @IsUUID()
  zoneId?: string;
}

export class RateTierOutDto {
  @ApiProperty() from!: number;
  @ApiPropertyOptional({ nullable: true }) to!: number | null;
  @ApiProperty() rateMinor!: number;
}

export class MethodDto {
  @ApiProperty({ format: 'uuid' }) id!: string;
  @ApiProperty({ format: 'uuid' }) zoneId!: string;
  @ApiProperty() zoneName!: string;
  @ApiProperty() name!: string;
  @ApiProperty({ enum: SHIPPING_METHOD_KINDS }) kind!: string;
  @ApiProperty({ enum: SHIPPING_PRICING_TYPES }) pricingType!: string;
  @ApiProperty() flatRateMinor!: number;
  @ApiPropertyOptional({ nullable: true }) freeOverMinor!: number | null;
  @ApiProperty() handlingMinor!: number;
  @ApiProperty() minOrderMinor!: number;
  @ApiPropertyOptional({ nullable: true }) maxOrderMinor!: number | null;
  @ApiProperty() minWeightGrams!: number;
  @ApiPropertyOptional({ nullable: true }) maxWeightGrams!: number | null;
  @ApiPropertyOptional({ nullable: true }) estimatedDaysMin!: number | null;
  @ApiPropertyOptional({ nullable: true }) estimatedDaysMax!: number | null;
  @ApiProperty() codAllowed!: boolean;
  @ApiPropertyOptional({ nullable: true }) carrierCode!: string | null;
  @ApiProperty() sortOrder!: number;
  @ApiProperty() enabled!: boolean;
  @ApiProperty({ type: [RateTierOutDto] }) tiers!: RateTierOutDto[];
  @ApiProperty() createdAt!: Date;
  @ApiProperty() updatedAt!: Date;
}
