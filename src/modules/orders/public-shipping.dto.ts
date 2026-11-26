import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform, Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsDefined,
  IsEmail,
  IsIn,
  IsOptional,
  IsUUID,
  Matches,
  MaxLength,
  ValidateNested,
} from 'class-validator';
import { OrderTaxDto } from '../tax/tax.dto.js';
import { QuoteAddressDto } from '../shipping/shipping-tools.dto.js';
import { CheckoutLineDto, DISCOUNT_CODE_PATTERN } from './checkout.dto.js';

const upperCode = ({ value }: { value: unknown }) =>
  typeof value === 'string' ? value.trim().toUpperCase() || undefined : value;

export class PublicShippingOptionsDto {
  @ApiProperty({
    type: QuoteAddressDto,
    description: 'Where the order is going.',
  })
  @IsDefined({ message: 'Enter the delivery address.' })
  @ValidateNested()
  @Type(() => QuoteAddressDto)
  address!: QuoteAddressDto;

  @ApiProperty({
    type: [CheckoutLineDto],
    description:
      'The cart, as for placing an order. Prices and weights are looked up by the server.',
  })
  @ValidateNested({ each: true })
  @Type(() => CheckoutLineDto)
  @ArrayMinSize(1)
  @ArrayMaxSize(50)
  lines!: CheckoutLineDto[];

  @ApiPropertyOptional({
    enum: ['razorpay', 'cod'],
    description:
      'The payment method being considered: carriers price (and serve) cash on delivery differently.',
  })
  @IsOptional()
  @IsIn(['razorpay', 'cod'])
  paymentMethod?: 'razorpay' | 'cod';
}

export class PublicQuoteDto extends PublicShippingOptionsDto {
  @ApiPropertyOptional({
    format: 'uuid',
    description:
      'The delivery option chosen (its `methodId` from the delivery options). Without it the delivery charge is not part of the quote.',
  })
  @IsOptional()
  @IsUUID()
  shippingMethodId?: string;

  @ApiPropertyOptional({
    example: 'WELCOME10',
    description:
      'A discount code to price the cart with. A code that does not apply is a 409 `DISCOUNT_INVALID` with the reason.',
  })
  @IsOptional()
  @Transform(upperCode)
  @Matches(DISCOUNT_CODE_PATTERN, { message: 'Enter a valid discount code.' })
  discountCode?: string;

  @ApiPropertyOptional({
    description:
      'The shopper email, only so a per-customer limit on the code can be checked early. It is checked again when the order is placed.',
  })
  @IsOptional()
  @IsEmail()
  @MaxLength(254)
  customerEmail?: string;
}

/** Asks whether a code works for a cart, without pricing delivery or tax. */
export class ValidateDiscountDto {
  @ApiProperty({ example: 'WELCOME10' })
  @Transform(upperCode)
  @Matches(DISCOUNT_CODE_PATTERN, { message: 'Enter a valid discount code.' })
  code!: string;

  @ApiProperty({ type: [CheckoutLineDto] })
  @ValidateNested({ each: true })
  @Type(() => CheckoutLineDto)
  @ArrayMinSize(1)
  @ArrayMaxSize(50)
  lines!: CheckoutLineDto[];

  @ApiPropertyOptional()
  @IsOptional()
  @IsEmail()
  @MaxLength(254)
  customerEmail?: string;
}

export class ValidateDiscountResultDto {
  @ApiProperty({ description: 'Whether the code applies to this cart.' })
  valid!: boolean;
  @ApiProperty({ nullable: true }) code!: string | null;
  @ApiProperty({
    description: 'Taken off the eligible items. 0 when not valid.',
  })
  discountMinor!: number;
  @ApiProperty({ description: 'The items the code applies to add up to this.' })
  eligibleSubtotalMinor!: number;
  @ApiProperty({
    nullable: true,
    description: 'Why not, e.g. EXPIRED, USAGE_LIMIT, MIN_SUBTOTAL.',
  })
  reason!: string | null;
  @ApiProperty({
    nullable: true,
    description: 'A message safe to show the shopper.',
  })
  message!: string | null;
  @ApiProperty({
    nullable: true,
    description: 'MIN_SUBTOTAL: what the eligible items must reach.',
  })
  minSubtotalMinor!: number | null;
}

/** The whole price of a cart as checkout would charge it right now. Nothing here comes from the browser. */
export class PublicQuoteResultDto {
  @ApiProperty() currency!: string;
  @ApiProperty() subtotalMinor!: number;
  @ApiProperty({
    description: 'Taken off the items by the discount code; 0 without one.',
  })
  discountMinor!: number;
  @ApiProperty({ nullable: true, description: 'The code that was applied.' })
  discountCode!: string | null;
  @ApiProperty({ description: '0 until a delivery option is chosen.' })
  shippingMinor!: number;
  @ApiProperty({ description: 'Cash-on-delivery charge; 0 for other methods.' })
  codFeeMinor!: number;
  @ApiProperty({
    description: 'GST. Not added to the total when `taxInclusive`.',
  })
  taxMinor!: number;
  @ApiProperty({ description: 'Prices already include GST.' })
  taxInclusive!: boolean;
  @ApiProperty() totalMinor!: number;
  @ApiProperty({ type: OrderTaxDto }) tax!: OrderTaxDto;
}
