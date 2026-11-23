import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform, Type } from 'class-transformer';
import {
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
  MinLength,
} from 'class-validator';
import { PaginationQueryDto } from '../../common/dto/pagination-query.dto.js';
import { REFUND_STATUSES } from '../../database/schema/payments.js';

const trim = ({ value }: { value: unknown }) =>
  typeof value === 'string' ? value.trim() : value;

export class CreateRefundDto {
  @ApiPropertyOptional({
    minimum: 1,
    description:
      'How much to refund, in paise. Leave out to refund everything that has not been refunded yet (a full refund).',
  })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100_000_000_000)
  amountMinor?: number;

  @ApiProperty({
    minLength: 1,
    maxLength: 500,
    description: 'Why the refund is being made. Kept in your records.',
  })
  @Transform(trim)
  @IsString()
  @MinLength(1, { message: 'Give a reason for the refund.' })
  @MaxLength(500)
  reason!: string;
}

export class RefundDto {
  @ApiProperty({ format: 'uuid' }) id!: string;
  @ApiProperty({ format: 'uuid' }) orderId!: string;
  @ApiProperty() orderNumber!: number;
  @ApiProperty({ format: 'uuid' }) paymentTransactionId!: string;
  @ApiProperty() amountMinor!: number;
  @ApiProperty() currency!: string;
  @ApiProperty({ enum: REFUND_STATUSES }) status!: string;
  @ApiPropertyOptional({ nullable: true }) reason!: string | null;
  @ApiProperty({ enum: ['storeforge', 'razorpay_dashboard'] }) source!: string;
  @ApiPropertyOptional({ nullable: true }) razorpayRefundId!: string | null;
  @ApiPropertyOptional({ nullable: true }) failureReason!: string | null;
  @ApiProperty() createdAt!: Date;
  @ApiPropertyOptional({ nullable: true }) processedAt!: Date | null;
}

export class RefundListQueryDto extends PaginationQueryDto {
  @ApiPropertyOptional({ enum: REFUND_STATUSES })
  @IsOptional()
  @IsIn(REFUND_STATUSES)
  status?: string;
}
