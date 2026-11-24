import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { OrderTaxDto } from '../tax/tax.dto.js';
import { Transform, Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsBoolean,
  IsDefined,
  IsEmail,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  IsUUID,
  Matches,
  Max,
  MaxLength,
  Min,
  MinLength,
  Validate,
  ValidateNested,
  ValidatorConstraint,
  type ValidatorConstraintInterface,
} from 'class-validator';
import {
  ORDER_FULFILLMENT_STATUSES,
  ORDER_PAYMENT_METHODS,
  ORDER_PAYMENT_STATUSES,
  ORDER_STATUSES,
  type OrderPaymentMethod,
} from '../../database/schema/enums.js';
import { findIndianState } from './indian-states.js';

/** Codes are stored upper-case; what a shopper types is upper-cased before it is checked against this. */
export const DISCOUNT_CODE_PATTERN = /^[A-Z0-9][A-Z0-9_-]{2,31}$/;

const trim = ({ value }: { value: unknown }) =>
  typeof value === 'string' ? value.trim() : value;

/** Fixed-text constraint so a message can never echo what the shopper typed. */
@ValidatorConstraint({ name: 'indianState' })
class IndianStateConstraint implements ValidatorConstraintInterface {
  validate(value: unknown) {
    return typeof value === 'string' && findIndianState(value) !== undefined;
  }
  defaultMessage() {
    return 'Choose a valid Indian state or union territory.';
  }
}

export class CheckoutLineDto {
  @ApiProperty({
    example: 'ceramic-mug',
    description: 'The product URL handle.',
  })
  @IsString()
  @Matches(/^[a-z0-9]+(-[a-z0-9]+)*$/, { message: 'Invalid product.' })
  @MaxLength(80)
  productSlug!: string;

  @ApiPropertyOptional({ format: 'uuid', nullable: true })
  @IsOptional()
  @IsUUID()
  variantId?: string | null;

  @ApiProperty({ minimum: 1, maximum: 100 })
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  quantity!: number;

  @ApiPropertyOptional({
    description:
      'The unit price (in paise) the shopper saw. It is NEVER used to price the order; it only lets the server report that the price changed.',
  })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  expectedUnitPriceMinor?: number;
}

export class CheckoutCustomerDto {
  @ApiProperty()
  @Transform(trim)
  @IsString()
  @MinLength(1)
  @MaxLength(120)
  fullName!: string;

  @ApiProperty({ format: 'email' })
  @Transform(trim)
  @IsEmail()
  @MaxLength(254)
  email!: string;

  @ApiProperty({ example: '9876543210' })
  @Transform(trim)
  @Matches(/^(?:\+?91[\s-]?)?[6-9]\d{9}$/, {
    message: 'Enter a valid 10-digit Indian mobile number.',
  })
  phone!: string;
}

export class CheckoutAddressDto {
  @ApiProperty()
  @Transform(trim)
  @IsString()
  @MinLength(1)
  @MaxLength(120)
  fullName!: string;

  @ApiProperty({ example: '9876543210' })
  @Transform(trim)
  @Matches(/^(?:\+?91[\s-]?)?[6-9]\d{9}$/, {
    message: 'Enter a valid 10-digit Indian mobile number.',
  })
  phone!: string;

  @ApiProperty()
  @Transform(trim)
  @IsString()
  @MinLength(1)
  @MaxLength(200)
  line1!: string;

  @ApiPropertyOptional()
  @IsOptional()
  @Transform(trim)
  @IsString()
  @MaxLength(200)
  line2?: string;

  @ApiProperty()
  @Transform(trim)
  @IsString()
  @MinLength(1)
  @MaxLength(100)
  city!: string;

  @ApiProperty({
    example: 'Karnataka',
    description: 'An Indian state or union territory name (or its GST code).',
  })
  @Transform(trim)
  @IsString()
  @Validate(IndianStateConstraint)
  state!: string;

  @ApiProperty({ example: '560001', description: 'Six-digit PIN code.' })
  @Transform(trim)
  @Matches(/^[1-9]\d{5}$/, { message: 'Enter a valid 6-digit PIN code.' })
  postalCode!: string;

  @ApiPropertyOptional({ enum: ['IN'], default: 'IN' })
  @IsOptional()
  @IsIn(['IN'], { message: 'We currently deliver within India only.' })
  country?: 'IN';
}

export class PlaceOrderDto {
  @ApiProperty({ type: [CheckoutLineDto], description: '1 to 50 lines.' })
  @ValidateNested({ each: true })
  @Type(() => CheckoutLineDto)
  @ArrayMinSize(1)
  @ArrayMaxSize(50)
  lines!: CheckoutLineDto[];

  @ApiProperty({ type: CheckoutCustomerDto })
  @IsDefined({ message: 'Enter your details.' })
  @ValidateNested()
  @Type(() => CheckoutCustomerDto)
  customer!: CheckoutCustomerDto;

  @ApiProperty({ type: CheckoutAddressDto })
  @IsDefined({ message: 'Enter the delivery address.' })
  @ValidateNested()
  @Type(() => CheckoutAddressDto)
  shippingAddress!: CheckoutAddressDto;

  @ApiPropertyOptional({ default: true })
  @IsOptional()
  @IsBoolean()
  billingSameAsShipping?: boolean;

  @ApiPropertyOptional({
    type: CheckoutAddressDto,
    description: 'Required when billingSameAsShipping is false.',
  })
  @IsOptional()
  @ValidateNested()
  @Type(() => CheckoutAddressDto)
  billingAddress?: CheckoutAddressDto;

  @ApiProperty({ enum: ORDER_PAYMENT_METHODS })
  @IsIn(ORDER_PAYMENT_METHODS, { message: 'Choose a payment method.' })
  paymentMethod!: OrderPaymentMethod;

  @ApiPropertyOptional({
    format: 'uuid',
    description:
      'The delivery option chosen from the shipping options for this cart and address. Required when the store has shipping zones set up; the price is worked out by the server, never taken from here.',
  })
  @IsOptional()
  @IsUUID('4', { message: 'Choose a delivery option.' })
  shippingMethodId?: string;

  @ApiPropertyOptional({
    example: 'WELCOME10',
    description:
      'A discount code. The server checks it against the codes of this store (active, dates, limits, minimum purchase, eligible items) and works out the amount; a code that does not apply is a 409 `DISCOUNT_INVALID` with the reason. Only the code is taken from here, never an amount.',
  })
  @IsOptional()
  @Transform(({ value }: { value: unknown }) =>
    typeof value === 'string' ? value.trim().toUpperCase() || undefined : value,
  )
  @Matches(DISCOUNT_CODE_PATTERN, { message: 'Enter a valid discount code.' })
  discountCode?: string;

  @ApiPropertyOptional({
    description:
      'The cart id the browser sent when it saved this cart for recovery (see the cart checkpoint). Only used to mark that cart as bought.',
  })
  @IsOptional()
  @IsString()
  @MinLength(16)
  @MaxLength(128)
  @Matches(/^[A-Za-z0-9_-]+$/, { message: 'Invalid cart id.' })
  cartKey?: string;
}

export class OrderItemViewDto {
  @ApiProperty() name!: string;
  @ApiPropertyOptional({ nullable: true }) sku!: string | null;
  @ApiProperty() quantity!: number;
  @ApiProperty() unitPriceMinor!: number;
  @ApiProperty() totalMinor!: number;
}

export class OrderAddressViewDto {
  @ApiProperty() fullName!: string;
  @ApiProperty() phone!: string;
  @ApiProperty() line1!: string;
  @ApiPropertyOptional({ nullable: true }) line2!: string | null;
  @ApiProperty() city!: string;
  @ApiProperty() state!: string;
  @ApiProperty() postalCode!: string;
  @ApiProperty() country!: string;
}

/** What the shopper gets back. The Razorpay payment step (Phase 4) adds its own fields to this. */
export class PlacedOrderDto {
  @ApiProperty({
    type: OrderTaxDto,
    description:
      'The GST charged, line by line, as it was worked out at checkout.',
  })
  tax!: OrderTaxDto;
  @ApiProperty() orderNumber!: number;
  @ApiProperty({ enum: ORDER_STATUSES }) status!: string;
  @ApiProperty({ enum: ORDER_PAYMENT_STATUSES }) paymentStatus!: string;
  @ApiProperty({ enum: ORDER_PAYMENT_METHODS }) paymentMethod!: string;
  @ApiProperty() currency!: string;
  @ApiProperty() subtotalMinor!: number;
  @ApiProperty() discountMinor!: number;
  @ApiProperty() shippingMinor!: number;
  @ApiProperty() codFeeMinor!: number;
  @ApiProperty() taxMinor!: number;
  @ApiProperty() taxInclusive!: boolean;
  @ApiProperty() totalMinor!: number;
  @ApiPropertyOptional({
    nullable: true,
    description: 'The delivery option the order was placed with.',
  })
  shippingMethodName!: string | null;
  @ApiPropertyOptional({
    nullable: true,
    description: 'The delivery zone the address fell in.',
  })
  shippingZoneName!: string | null;
  @ApiPropertyOptional({
    nullable: true,
    description: 'Estimated delivery time in days, as shown at checkout.',
  })
  shippingDays!: { min: number; max: number } | null;
  @ApiProperty({ type: [OrderItemViewDto] }) items!: OrderItemViewDto[];
  @ApiPropertyOptional({
    nullable: true,
    description: 'When the stock held for an unpaid order is released.',
  })
  reservationExpiresAt!: Date | null;
  @ApiPropertyOptional({
    nullable: true,
    description:
      'Secret that lets this shopper read the order. Returned ONCE, on the request that created the order; null on a replay of the same Idempotency-Key.',
  })
  accessToken!: string | null;
  @ApiProperty({
    description:
      'True when this response repeats an earlier request with the same Idempotency-Key.',
  })
  replayed!: boolean;
}

export class PublicTrackingEventDto {
  @ApiProperty() status!: string;
  @ApiProperty() description!: string;
  @ApiPropertyOptional({ nullable: true }) location!: string | null;
  @ApiPropertyOptional({ nullable: true }) occurredAt!: Date | null;
}

/** What a shopper may see of a parcel: where it is, never how it was booked. */
export class PublicShipmentDto {
  @ApiProperty() status!: string;
  @ApiPropertyOptional({ nullable: true }) courierName!: string | null;
  @ApiPropertyOptional({ nullable: true }) awb!: string | null;
  @ApiPropertyOptional({ nullable: true }) trackingUrl!: string | null;
  @ApiPropertyOptional({ nullable: true }) estimatedDelivery!: Date | null;
  @ApiProperty({ description: 'The items in this parcel.' })
  items!: { name: string; quantity: number }[];
  @ApiProperty({ type: [PublicTrackingEventDto], description: 'Newest first.' })
  events!: PublicTrackingEventDto[];
}

export class PublicOrderDto extends PlacedOrderDto {
  @ApiProperty({ type: [PublicShipmentDto] })
  shipments!: PublicShipmentDto[];

  @ApiProperty() placedAt!: Date;
  @ApiProperty({ enum: ORDER_FULFILLMENT_STATUSES }) fulfillmentStatus!: string;
  @ApiProperty({ type: OrderAddressViewDto })
  shippingAddress!: OrderAddressViewDto;
}
