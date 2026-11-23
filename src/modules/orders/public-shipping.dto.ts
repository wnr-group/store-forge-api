import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsDefined,
  IsIn,
  IsOptional,
  IsUUID,
  ValidateNested,
} from 'class-validator';
import { OrderTaxDto } from '../tax/tax.dto.js';
import { QuoteAddressDto } from '../shipping/shipping-tools.dto.js';
import { CheckoutLineDto } from './checkout.dto.js';

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
}

/** The whole price of a cart as checkout would charge it right now. Nothing here comes from the browser. */
export class PublicQuoteResultDto {
  @ApiProperty() currency!: string;
  @ApiProperty() subtotalMinor!: number;
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
