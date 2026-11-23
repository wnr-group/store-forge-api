import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsDefined,
  IsIn,
  IsOptional,
  ValidateNested,
} from 'class-validator';
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
