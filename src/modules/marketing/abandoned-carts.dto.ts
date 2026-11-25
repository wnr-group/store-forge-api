import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform, Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsBoolean,
  IsEmail,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  Matches,
  Max,
  MaxLength,
  Min,
  MinLength,
  ValidateNested,
} from 'class-validator';
import { DateRangeQueryDto } from '../../common/dto/date-range-query.dto.js';
import { PaginationQueryDto } from '../../common/dto/pagination-query.dto.js';
import { CheckoutLineDto } from '../orders/checkout.dto.js';

export const ABANDONED_CART_VIEW_STATUSES = [
  'active',
  'abandoned',
  'recovered',
  'expired',
] as const;

const trim = ({ value }: { value: unknown }) =>
  typeof value === 'string' ? value.trim() : value;
const blankToUndefined = ({ value }: { value: unknown }) =>
  typeof value === 'string' ? value.trim() || undefined : value;

// --- Storefront ------------------------------------------------------------------------------------------------------------

export class CartCheckpointCustomerDto {
  @ApiProperty({ example: 'asha@example.com' })
  @Transform(({ value }: { value: unknown }) =>
    typeof value === 'string' ? value.trim().toLowerCase() : value,
  )
  @IsEmail({}, { message: 'Enter a valid email address.' })
  @MaxLength(254)
  email!: string;

  @ApiPropertyOptional({ maxLength: 120 })
  @IsOptional()
  @Transform(blankToUndefined)
  @IsString()
  @MaxLength(120)
  fullName?: string;

  @ApiPropertyOptional({ maxLength: 20 })
  @IsOptional()
  @Transform(blankToUndefined)
  @IsString()
  @MaxLength(20)
  @Matches(/^[0-9+\-\s()]{6,20}$/, { message: 'Enter a valid phone number.' })
  phone?: string;
}

export class CartCheckpointDto {
  @ApiProperty({
    minLength: 16,
    maxLength: 128,
    description:
      'A random id the browser creates for this cart and keeps with it. Only a hash of it is stored; whoever knows it can refresh that one cart, so it is never shown or sent anywhere else.',
  })
  @Transform(trim)
  @IsString()
  @MinLength(16)
  @MaxLength(128)
  @Matches(/^[A-Za-z0-9_-]+$/, { message: 'Invalid cart id.' })
  cartKey!: string;

  @ApiProperty({
    type: [CheckoutLineDto],
    description: '1 to 50 lines. Prices are looked up by the server.',
  })
  @ValidateNested({ each: true })
  @Type(() => CheckoutLineDto)
  @ArrayMinSize(1)
  @ArrayMaxSize(50)
  lines!: CheckoutLineDto[];

  @ApiProperty({ type: CartCheckpointCustomerDto })
  @ValidateNested()
  @Type(() => CartCheckpointCustomerDto)
  customer!: CartCheckpointCustomerDto;

  @ApiPropertyOptional({
    default: false,
    description:
      'The shopper agreed to be contacted about this cart. Nothing is ever sent without it, and nothing is sent at all until an email or SMS provider is connected.',
  })
  @IsOptional()
  @IsBoolean()
  marketingConsent?: boolean;
}

export class CartCheckpointResultDto {
  @ApiProperty({
    description:
      'False when none of the lines could be saved (all unavailable).',
  })
  saved!: boolean;
}

export class RecoveredLineDto {
  @ApiProperty() productSlug!: string;
  @ApiPropertyOptional({ nullable: true, format: 'uuid' }) variantId!:
    string | null;
  @ApiProperty() quantity!: number;
  @ApiProperty() name!: string;
  @ApiProperty({ description: 'The price now (paise).' })
  unitPriceMinor!: number;
  @ApiProperty({ description: 'The price changed since the cart was saved.' })
  priceChanged!: boolean;
}

export class CartRecoveryDto {
  @ApiPropertyOptional({ nullable: true }) email!: string | null;
  @ApiPropertyOptional({ nullable: true }) customerName!: string | null;
  @ApiProperty({
    type: [RecoveredLineDto],
    description:
      'The items that can still be bought, priced now. Put these in the cart and go to checkout.',
  })
  lines!: RecoveredLineDto[];
  @ApiProperty({
    description:
      'Items that are no longer available (or have less stock): `{ code, productSlug, variantId }`.',
    type: 'array',
    items: { type: 'object' },
  })
  issues!: object[];
}

// --- Dashboard -------------------------------------------------------------------------------------------------------------

export class AbandonedCartListQueryDto extends PaginationQueryDto {
  @ApiPropertyOptional({
    enum: ABANDONED_CART_VIEW_STATUSES,
    description:
      '`abandoned`: no activity for the threshold and still inside the recovery window. `expired`: older than the recovery window. `recovered`: the shopper came back and bought. `active`: still shopping.',
  })
  @IsOptional()
  @IsIn(ABANDONED_CART_VIEW_STATUSES)
  status?: (typeof ABANDONED_CART_VIEW_STATUSES)[number];

  @ApiPropertyOptional({
    example: '2026-11-01',
    description: 'Last activity from this day (YYYY-MM-DD).',
  })
  @IsOptional()
  @Matches(/^\d{4}-\d{2}-\d{2}$/, { message: 'Use a date like 2026-11-01.' })
  from?: string;

  @ApiPropertyOptional({
    example: '2026-11-30',
    description: 'Last activity up to this day, included.',
  })
  @IsOptional()
  @Matches(/^\d{4}-\d{2}-\d{2}$/, { message: 'Use a date like 2026-11-30.' })
  to?: string;

  @ApiPropertyOptional({
    enum: ['lastActivityAt', 'cartValue'],
    default: 'lastActivityAt',
  })
  @IsOptional()
  @IsIn(['lastActivityAt', 'cartValue'])
  sortBy: 'lastActivityAt' | 'cartValue' = 'lastActivityAt';
}

export class AbandonedCartSummaryQueryDto extends DateRangeQueryDto {}

export class AbandonedCartItemDto {
  @ApiProperty() name!: string;
  @ApiPropertyOptional() productSlug?: string;
  @ApiPropertyOptional({ nullable: true }) variantId?: string | null;
  @ApiProperty() quantity!: number;
  @ApiProperty({ description: 'When the cart was last saved (paise).' })
  unitPriceMinor!: number;
}

export class AbandonedCartDto {
  @ApiProperty({ format: 'uuid' }) id!: string;
  @ApiPropertyOptional({ nullable: true }) email!: string | null;
  @ApiPropertyOptional({ nullable: true }) customerName!: string | null;
  @ApiPropertyOptional({ nullable: true }) phone!: string | null;
  @ApiProperty() itemCount!: number;
  @ApiProperty({ description: 'When it was last saved (paise).' })
  cartValueMinor!: number;
  @ApiProperty() currency!: string;
  @ApiProperty({ enum: ABANDONED_CART_VIEW_STATUSES }) status!: string;
  @ApiProperty() lastActivityAt!: Date;
  @ApiPropertyOptional({
    nullable: true,
    description: 'When it started counting as abandoned.',
  })
  abandonedAt!: Date | null;
  @ApiPropertyOptional({ nullable: true }) recoveredAt!: Date | null;
  @ApiPropertyOptional({
    nullable: true,
    description: 'The order the shopper placed after coming back.',
  })
  recoveredOrderNumber!: number | null;
  @ApiProperty({ description: 'How many times the recovery link was opened.' })
  recoveryClicks!: number;
  @ApiProperty({
    description: 'The shopper agreed to be contacted about this cart.',
  })
  marketingConsent!: boolean;
  @ApiProperty({
    description:
      'Consent and an email are both there. Contact is still only possible once an email or SMS provider is connected (none is yet).',
  })
  canContact!: boolean;
}

export class AbandonedCartDetailDto extends AbandonedCartDto {
  @ApiProperty({ type: [AbandonedCartItemDto] }) items!: AbandonedCartItemDto[];
  @ApiPropertyOptional({
    nullable: true,
    description:
      'The storefront path that resumes this cart, e.g. `/s/acme/cart?recover=TOKEN`. Prefix it with the store address. Null for a cart that is recovered or past the recovery window.',
  })
  recoveryPath!: string | null;
}

export class AbandonedCartSummaryDto {
  @ApiProperty() from!: string;
  @ApiProperty() to!: string;
  @ApiProperty() abandonedCount!: number;
  @ApiProperty({ description: 'Value of the carts still abandoned (paise).' })
  abandonedValueMinor!: number;
  @ApiProperty() recoveredCount!: number;
  @ApiProperty({ description: 'What the recovered orders came to (paise).' })
  recoveredValueMinor!: number;
  @ApiProperty({
    description:
      'Recovered carts as a share of all that were abandoned (0 to 100, one decimal). 0 when there are none.',
  })
  recoveryRatePercent!: number;
  @ApiProperty() activeCount!: number;
}

export class AbandonedCartSettingsDto {
  @ApiProperty({ description: 'False until saved; the defaults then apply.' })
  configured!: boolean;
  @ApiProperty({
    example: 60,
    description:
      'A cart with no activity this long (minutes) counts as abandoned.',
  })
  abandonmentThresholdMinutes!: number;
  @ApiProperty({
    example: 14,
    description:
      'A recovery link works for this many days after the last activity.',
  })
  recoveryLinkDays!: number;
  @ApiPropertyOptional({ nullable: true }) updatedAt!: Date | null;
}

export class SaveAbandonedCartSettingsDto {
  @ApiProperty({ minimum: 15, maximum: 10080 })
  @Type(() => Number)
  @IsInt({ message: 'Enter a whole number of minutes.' })
  @Min(15, { message: 'At least 15 minutes.' })
  @Max(10080, { message: 'At most 7 days (10080 minutes).' })
  abandonmentThresholdMinutes!: number;

  @ApiProperty({ minimum: 1, maximum: 90 })
  @Type(() => Number)
  @IsInt({ message: 'Enter a whole number of days.' })
  @Min(1, { message: 'At least 1 day.' })
  @Max(90, { message: 'At most 90 days.' })
  recoveryLinkDays!: number;
}
