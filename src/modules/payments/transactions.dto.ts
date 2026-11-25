import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsIn, IsISO8601, IsOptional } from 'class-validator';
import { PaginationQueryDto } from '../../common/dto/pagination-query.dto.js';
import { PAYMENT_TRANSACTION_STATUSES } from '../../database/schema/payments.js';
import { RefundDto } from './refunds.dto.js';

export class TransactionListQueryDto extends PaginationQueryDto {
  @ApiPropertyOptional({ enum: PAYMENT_TRANSACTION_STATUSES })
  @IsOptional()
  @IsIn(PAYMENT_TRANSACTION_STATUSES)
  status?: string;

  @ApiPropertyOptional({ enum: ['razorpay', 'cod'] })
  @IsOptional()
  @IsIn(['razorpay', 'cod'])
  provider?: string;

  @ApiPropertyOptional({
    description:
      'Payment method Razorpay reported, e.g. upi, card, netbanking, wallet.',
  })
  @IsOptional()
  @IsIn([
    'upi',
    'card',
    'netbanking',
    'wallet',
    'emi',
    'paylater',
    'cardless_emi',
    'bank_transfer',
  ])
  method?: string;

  @ApiPropertyOptional({
    enum: ['none', 'pending', 'partial', 'full'],
    description: 'Only transactions in this refund state.',
  })
  @IsOptional()
  @IsIn(['none', 'pending', 'partial', 'full'])
  refundStatus?: string;

  @ApiPropertyOptional({
    description: 'From this date (ISO 8601), by transaction date.',
  })
  @IsOptional()
  @IsISO8601()
  from?: string;

  @ApiPropertyOptional({
    description: 'Up to this date (ISO 8601), by transaction date.',
  })
  @IsOptional()
  @IsISO8601()
  to?: string;
}

export class TransactionDto {
  @ApiProperty({ format: 'uuid', description: 'The internal transaction id.' })
  id!: string;
  @ApiProperty({ format: 'uuid' }) orderId!: string;
  @ApiProperty({ description: 'The StoreForge order number.' })
  orderNumber!: number;
  @ApiProperty({ enum: ['razorpay', 'cod'] }) provider!: string;
  @ApiProperty({ enum: PAYMENT_TRANSACTION_STATUSES }) status!: string;
  @ApiProperty() amountMinor!: number;
  @ApiProperty() currency!: string;
  @ApiPropertyOptional({ nullable: true }) method!: string | null;
  @ApiPropertyOptional({ nullable: true }) razorpayOrderId!: string | null;
  @ApiPropertyOptional({ nullable: true }) razorpayPaymentId!: string | null;
  @ApiProperty() refundedMinor!: number;
  @ApiProperty() refundPendingMinor!: number;
  @ApiProperty({ enum: ['none', 'pending', 'partial', 'full'] })
  refundStatus!: string;
  @ApiProperty({
    description:
      'True when the money was received but the order could not be fulfilled: it needs a refund.',
  })
  refundRequired!: boolean;
  @ApiProperty() createdAt!: Date;
  @ApiPropertyOptional({ nullable: true }) capturedAt!: Date | null;
  @ApiPropertyOptional({ nullable: true }) collectedAt!: Date | null;
}

export class WebhookEventDto {
  @ApiProperty() eventId!: string;
  @ApiProperty() eventType!: string;
  @ApiProperty({ enum: ['received', 'processed', 'ignored', 'failed'] })
  status!: string;
  @ApiPropertyOptional({ nullable: true }) note!: string | null;
  @ApiProperty() receivedAt!: Date;
}

export class TransactionDetailDto extends TransactionDto {
  @ApiProperty() attempts!: number;
  @ApiPropertyOptional({ nullable: true }) failureCode!: string | null;
  @ApiPropertyOptional({ nullable: true }) failureDescription!: string | null;
  @ApiProperty({ type: [RefundDto] }) refunds!: RefundDto[];
  @ApiProperty({
    type: [WebhookEventDto],
    description: 'What Razorpay told us about this payment, oldest first.',
  })
  events!: WebhookEventDto[];
}
