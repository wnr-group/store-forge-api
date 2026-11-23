import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import {
  IsIn,
  IsOptional,
  IsString,
  MaxLength,
  MinLength,
} from 'class-validator';
import { PaginationQueryDto } from '../../common/dto/pagination-query.dto.js';
import {
  ORDER_PAYMENT_METHODS,
  ORDER_PAYMENT_STATUSES,
  ORDER_STATUSES,
  type OrderStatus,
} from '../../database/schema/enums.js';
import { OrderAddressViewDto, OrderItemViewDto } from './checkout.dto.js';

const trim = ({ value }: { value: unknown }) =>
  typeof value === 'string' ? value.trim() : value;

export class OrderListQueryDto extends PaginationQueryDto {
  @ApiPropertyOptional({ enum: ORDER_STATUSES })
  @IsOptional()
  @IsIn(ORDER_STATUSES)
  status?: OrderStatus;

  @ApiPropertyOptional({ enum: ORDER_PAYMENT_STATUSES })
  @IsOptional()
  @IsIn(ORDER_PAYMENT_STATUSES)
  paymentStatus?: string;

  @ApiPropertyOptional({ enum: ORDER_PAYMENT_METHODS })
  @IsOptional()
  @IsIn(ORDER_PAYMENT_METHODS)
  paymentMethod?: string;
}

export class OrderSummaryDto {
  @ApiProperty({ format: 'uuid' }) id!: string;
  @ApiProperty() orderNumber!: number;
  @ApiProperty({ enum: ORDER_STATUSES }) status!: string;
  @ApiProperty({ enum: ORDER_PAYMENT_STATUSES }) paymentStatus!: string;
  @ApiPropertyOptional({ nullable: true }) paymentMethod!: string | null;
  @ApiProperty() fulfillmentStatus!: string;
  @ApiPropertyOptional({ nullable: true }) customerName!: string | null;
  @ApiPropertyOptional({ nullable: true }) customerEmail!: string | null;
  @ApiProperty() currency!: string;
  @ApiProperty() totalMinor!: number;
  @ApiProperty() placedAt!: Date;
}

export class OrderHistoryEntryDto {
  @ApiPropertyOptional({ nullable: true }) fromStatus!: string | null;
  @ApiProperty() toStatus!: string;
  @ApiProperty() actorType!: string;
  @ApiPropertyOptional({ nullable: true }) note!: string | null;
  @ApiProperty() createdAt!: Date;
}

export class OrderDetailDto extends OrderSummaryDto {
  @ApiProperty() subtotalMinor!: number;
  @ApiProperty() discountMinor!: number;
  @ApiProperty() shippingMinor!: number;
  @ApiProperty() codFeeMinor!: number;
  @ApiProperty() taxMinor!: number;
  @ApiProperty() taxInclusive!: boolean;
  @ApiPropertyOptional({ nullable: true }) customerPhone!: string | null;
  @ApiPropertyOptional({ nullable: true }) cancelReason!: string | null;
  @ApiPropertyOptional({
    nullable: true,
    description: 'The delivery option the shopper chose.',
  })
  shippingMethodName!: string | null;
  @ApiPropertyOptional({ nullable: true }) shippingZoneName!: string | null;
  @ApiPropertyOptional({
    nullable: true,
    description:
      'The carrier whose live price the shipping charge was based on, if any.',
  })
  shippingCarrierCode!: string | null;
  @ApiPropertyOptional({ nullable: true }) shippingServiceCode!: string | null;
  @ApiPropertyOptional({
    nullable: true,
    description: 'Estimated delivery time in days, as shown at checkout.',
  })
  shippingDays!: { min: number; max: number } | null;
  @ApiProperty({
    description:
      'The parcel weight the shipping charge was based on, in grams. 0 = not known.',
  })
  shippingWeightGrams!: number;
  @ApiProperty({ type: [OrderItemViewDto] }) items!: OrderItemViewDto[];
  @ApiPropertyOptional({ type: OrderAddressViewDto, nullable: true })
  shippingAddress!: OrderAddressViewDto | null;
  @ApiPropertyOptional({ type: OrderAddressViewDto, nullable: true })
  billingAddress!: OrderAddressViewDto | null;
  @ApiProperty({ type: [OrderHistoryEntryDto] })
  history!: OrderHistoryEntryDto[];
  @ApiProperty({
    enum: ORDER_STATUSES,
    isArray: true,
    description: 'The statuses this order may move to next.',
  })
  nextStatuses!: string[];
}

export class UpdateOrderStatusDto {
  @ApiProperty({ enum: ORDER_STATUSES })
  @IsIn(ORDER_STATUSES, { message: 'Choose a valid status.' })
  status!: OrderStatus;

  @ApiPropertyOptional({ maxLength: 500 })
  @IsOptional()
  @Transform(trim)
  @IsString()
  @MaxLength(500)
  note?: string;
}

export class CancelOrderDto {
  @ApiProperty({ minLength: 1, maxLength: 500 })
  @Transform(trim)
  @IsString()
  @MinLength(1, { message: 'Give a reason for the cancellation.' })
  @MaxLength(500)
  reason!: string;
}
