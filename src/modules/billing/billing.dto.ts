import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import {
  IsIn,
  IsOptional,
  IsString,
  IsUUID,
  Length,
  Matches,
  MaxLength,
} from 'class-validator';
import { PaginationQueryDto } from '../../common/dto/pagination-query.dto.js';
import {
  MoneyText,
  OptionalText,
  RequiredText,
  WholeNumber,
  WhenPresent,
} from '../../common/validation/fields.js';

const DATE = /^\d{4}-\d{2}-\d{2}$/;

// --- responses -------------------------------------------------------------------------------------------------------------------

export class InvoiceSellerDto {
  @ApiProperty() legalName!: string;
  @ApiPropertyOptional({ nullable: true }) address!: string | null;
  @ApiPropertyOptional({ nullable: true }) gstin!: string | null;
  @ApiProperty() taxLabel!: string;
}

export class InvoiceDto {
  @ApiProperty({ format: 'uuid' }) id!: string;
  @ApiProperty({ example: 'SF-2026-000123' }) number!: string;
  @ApiProperty({ format: 'uuid' }) tenantId!: string;
  @ApiProperty() tenantName!: string;
  @ApiProperty() planCode!: string;
  @ApiProperty() planName!: string;
  @ApiProperty({ enum: ['monthly', 'yearly'] }) billingInterval!: string;
  @ApiProperty() description!: string;
  @ApiProperty() periodStart!: Date;
  @ApiProperty() periodEnd!: Date;
  @ApiProperty({ example: 'INR' }) currency!: string;
  @ApiProperty() subtotalMinor!: number;
  @ApiProperty({ description: 'Tax rate in basis points: 1800 is 18%.' })
  taxRateBps!: number;
  @ApiProperty() taxMinor!: number;
  @ApiProperty() totalMinor!: number;
  @ApiProperty({ enum: ['open', 'paid', 'void'] }) status!: string;
  @ApiProperty({ description: 'Open and past its due date.' })
  overdue!: boolean;
  @ApiProperty() issuedAt!: Date;
  @ApiProperty() dueAt!: Date;
  @ApiPropertyOptional({ nullable: true }) paidAt!: Date | null;
  @ApiPropertyOptional({ nullable: true }) voidedAt!: Date | null;
  @ApiPropertyOptional({ nullable: true }) voidReason!: string | null;
  @ApiProperty({ type: InvoiceSellerDto }) seller!: InvoiceSellerDto;
}

export class BillingPaymentDto {
  @ApiProperty({ format: 'uuid' }) id!: string;
  @ApiProperty({ format: 'uuid' }) invoiceId!: string;
  @ApiProperty() invoiceNumber!: string;
  @ApiProperty({ format: 'uuid' }) tenantId!: string;
  @ApiProperty() tenantName!: string;
  @ApiProperty({ enum: ['razorpay', 'manual'] }) provider!: string;
  @ApiProperty({
    enum: ['pending', 'succeeded', 'failed', 'refunded', 'partially_refunded'],
  })
  status!: string;
  @ApiProperty() amountMinor!: number;
  @ApiProperty() currency!: string;
  @ApiPropertyOptional({ nullable: true }) razorpayOrderId!: string | null;
  @ApiPropertyOptional({ nullable: true }) razorpayPaymentId!: string | null;
  @ApiPropertyOptional({ nullable: true }) method!: string | null;
  @ApiPropertyOptional({
    nullable: true,
    description: 'The bank or cheque reference of an offline payment.',
  })
  reference!: string | null;
  @ApiPropertyOptional({ nullable: true }) note!: string | null;
  @ApiPropertyOptional({ nullable: true }) failureCode!: string | null;
  @ApiPropertyOptional({ nullable: true }) failureDescription!: string | null;
  @ApiProperty({
    description:
      'Money arrived for an invoice that was already paid or void, so it has to be refunded.',
  })
  refundRequired!: boolean;
  @ApiProperty() refundedMinor!: number;
  @ApiPropertyOptional({ nullable: true }) capturedAt!: Date | null;
  @ApiProperty() createdAt!: Date;
}

export class BillingRefundDto {
  @ApiProperty({ format: 'uuid' }) id!: string;
  @ApiProperty({ format: 'uuid' }) paymentId!: string;
  @ApiProperty() amountMinor!: number;
  @ApiProperty() currency!: string;
  @ApiProperty({ enum: ['pending', 'processed', 'failed'] }) status!: string;
  @ApiPropertyOptional({ nullable: true }) reason!: string | null;
  @ApiPropertyOptional({ nullable: true }) razorpayRefundId!: string | null;
  @ApiPropertyOptional({ nullable: true }) failureReason!: string | null;
  @ApiProperty() createdAt!: Date;
  @ApiPropertyOptional({ nullable: true }) processedAt!: Date | null;
}

export class InvoiceDetailDto extends InvoiceDto {
  @ApiProperty({ type: [BillingPaymentDto] }) payments!: BillingPaymentDto[];
  @ApiProperty({ type: [BillingRefundDto] }) refunds!: BillingRefundDto[];
}

export class PaymentDetailDto extends BillingPaymentDto {
  @ApiProperty({ type: [BillingRefundDto] }) refunds!: BillingRefundDto[];
}

export class BillingSettingsDto {
  @ApiProperty() legalName!: string;
  @ApiPropertyOptional({ nullable: true }) address!: string | null;
  @ApiPropertyOptional({ nullable: true }) gstin!: string | null;
  @ApiProperty({ example: 'GST' }) taxLabel!: string;
  @ApiProperty({ description: 'Added on top of the plan price. 1800 is 18%.' })
  taxRateBps!: number;
  @ApiProperty({
    description:
      'Days to pay an invoice that is issued after its period has started.',
  })
  dueDays!: number;
  @ApiProperty({
    description:
      'Days after the due date before an unpaid subscription expires.',
  })
  graceDays!: number;
  @ApiProperty({
    description: 'How many days before a renewal its invoice is issued.',
  })
  renewalNoticeDays!: number;
  @ApiProperty() updatedAt!: Date;
  @ApiProperty({
    description:
      'Whether StoreForge Razorpay keys are configured on the server, so tenants can pay online. The keys themselves are never returned.',
  })
  paymentsConfigured!: boolean;
}

export class TenantBillingDto {
  @ApiPropertyOptional({ nullable: true }) planName!: string | null;
  @ApiPropertyOptional({ nullable: true }) subscriptionStatus!: string | null;
  @ApiPropertyOptional({ nullable: true }) billingInterval!: string | null;
  @ApiPropertyOptional({
    nullable: true,
    description: 'When the current period ends and the next invoice falls due.',
  })
  renewsAt!: Date | null;
  @ApiProperty({ description: 'Has an open invoice past its due date.' })
  overdue!: boolean;
  @ApiProperty() overdueAmountMinor!: number;
  @ApiProperty() openInvoices!: number;
  @ApiProperty({ type: [InvoiceDto] }) recentInvoices!: InvoiceDto[];
  @ApiProperty({ type: [BillingPaymentDto] })
  recentPayments!: BillingPaymentDto[];
}

export class CurrencyAmountDto {
  @ApiProperty() currency!: string;
  @ApiProperty() amountMinor!: number;
}

export class BillingSummaryDto {
  @ApiProperty() from!: string;
  @ApiProperty() to!: string;
  @ApiProperty({
    type: [CurrencyAmountDto],
    description:
      'Monthly recurring revenue from paid, active subscriptions (yearly plans count as a twelfth).',
  })
  mrr!: CurrencyAmountDto[];
  @ApiProperty() successfulPayments!: number;
  @ApiProperty({ type: [CurrencyAmountDto] }) collected!: CurrencyAmountDto[];
  @ApiProperty() failedPayments!: number;
  @ApiProperty() pendingPayments!: number;
  @ApiProperty({ type: [CurrencyAmountDto] }) refunded!: CurrencyAmountDto[];
  @ApiProperty() paymentsNeedingRefund!: number;
  @ApiProperty() overdueInvoices!: number;
  @ApiProperty({ type: [CurrencyAmountDto] }) overdue!: CurrencyAmountDto[];
  @ApiProperty() openInvoices!: number;
}

export class PaymentIntentDto {
  @ApiProperty({ description: 'Pass to Razorpay Checkout as `order_id`.' })
  orderId!: string;
  @ApiProperty({
    description:
      'The public Razorpay Key ID of StoreForge. The secret never leaves the server.',
  })
  keyId!: string;
  @ApiProperty() amountMinor!: number;
  @ApiProperty() currency!: string;
  @ApiProperty() invoiceNumber!: string;
}

export class PaymentVerifiedDto {
  @ApiProperty({ enum: ['captured', 'duplicate'] }) result!: string;
  @ApiProperty({ enum: ['open', 'paid', 'void'] }) invoiceStatus!: string;
}

export class BillingRunDto {
  @ApiProperty() invoicesIssued!: number;
  @ApiProperty() markedPastDue!: number;
  @ApiProperty() expired!: number;
}

// --- requests ----------------------------------------------------------------------------------------------------------------------

export class InvoiceListQueryDto extends PaginationQueryDto {
  @ApiPropertyOptional({
    enum: ['all', 'open', 'paid', 'void', 'overdue'],
    default: 'all',
    description: '`overdue` = open and past the due date.',
  })
  @IsOptional()
  @IsIn(['all', 'open', 'paid', 'void', 'overdue'])
  status: 'all' | 'open' | 'paid' | 'void' | 'overdue' = 'all';

  @ApiPropertyOptional({
    format: 'uuid',
    description: 'Only this organization.',
  })
  @IsOptional()
  @IsUUID()
  org?: string;

  @ApiPropertyOptional({
    example: '2026-11-01',
    description: 'Issued from this UTC day.',
  })
  @IsOptional()
  @Matches(DATE, { message: 'from must be YYYY-MM-DD.' })
  from?: string;

  @ApiPropertyOptional({
    example: '2026-11-30',
    description: 'Issued up to this UTC day.',
  })
  @IsOptional()
  @Matches(DATE, { message: 'to must be YYYY-MM-DD.' })
  to?: string;
}

export class PaymentListQueryDto extends PaginationQueryDto {
  @ApiPropertyOptional({
    enum: [
      'all',
      'pending',
      'succeeded',
      'failed',
      'refunded',
      'partially_refunded',
    ],
    default: 'all',
  })
  @IsOptional()
  @IsIn([
    'all',
    'pending',
    'succeeded',
    'failed',
    'refunded',
    'partially_refunded',
  ])
  status:
    | 'all'
    | 'pending'
    | 'succeeded'
    | 'failed'
    | 'refunded'
    | 'partially_refunded' = 'all';

  @ApiPropertyOptional({ format: 'uuid' })
  @IsOptional()
  @IsUUID()
  org?: string;

  @ApiPropertyOptional({ example: '2026-11-01' })
  @IsOptional()
  @Matches(DATE, { message: 'from must be YYYY-MM-DD.' })
  from?: string;

  @ApiPropertyOptional({ example: '2026-11-30' })
  @IsOptional()
  @Matches(DATE, { message: 'to must be YYYY-MM-DD.' })
  to?: string;

  @ApiPropertyOptional({
    description: 'Only payments that still have to be refunded.',
  })
  @IsOptional()
  @Transform(({ value }) => value === true || value === 'true')
  refundRequired?: boolean;
}

export class SummaryQueryDto {
  @ApiPropertyOptional({
    example: '2026-11-01',
    description: 'Default: 30 days ago.',
  })
  @IsOptional()
  @Matches(DATE, { message: 'from must be YYYY-MM-DD.' })
  from?: string;

  @ApiPropertyOptional({
    example: '2026-11-30',
    description: 'Default: today.',
  })
  @IsOptional()
  @Matches(DATE, { message: 'to must be YYYY-MM-DD.' })
  to?: string;
}

export class IssueInvoiceDto {
  @ApiProperty({
    enum: ['current', 'next'],
    description:
      '`current` bills the period the organization is in now (use it for a paid plan that was just assigned); `next` bills the period that starts when this one ends.',
  })
  @IsIn(['current', 'next'], { message: 'Choose current or next.' })
  period!: 'current' | 'next';
}

export class VoidInvoiceDto {
  @ApiProperty({ minLength: 3, maxLength: 300 })
  @RequiredText('Reason', 300, 3)
  reason!: string;
}

export class ManualPaymentDto {
  @ApiProperty({
    example: 'UTR 4021119',
    minLength: 2,
    maxLength: 120,
    description: 'The bank, cheque or transfer reference.',
  })
  @RequiredText('Reference', 120, 2)
  reference!: string;

  @ApiProperty({ example: 'Bank transfer', minLength: 2, maxLength: 40 })
  @RequiredText('Method', 40, 2)
  method!: string;

  @ApiPropertyOptional({ nullable: true, maxLength: 300 })
  @OptionalText('Note', 300)
  note?: string | null;
}

export class RefundPaymentDto {
  @ApiProperty({
    minLength: 8,
    maxLength: 100,
    description:
      'A unique id you generate for this refund request (a UUID is fine). Sending the same id again never refunds twice.',
  })
  @IsString()
  @Length(8, 100, { message: 'requestId must be 8 to 100 characters.' })
  requestId!: string;

  @ApiProperty({ minLength: 3, maxLength: 300 })
  @RequiredText('Reason', 300, 3)
  reason!: string;

  @ApiPropertyOptional({
    example: '250.00',
    description:
      'How much to refund, as plain decimal text. Leave out to refund everything not yet refunded.',
  })
  @WhenPresent()
  @MoneyText('Amount', { required: true, positive: true })
  amount?: string;
}

export class UpdateBillingSettingsDto {
  @ApiPropertyOptional({ minLength: 2, maxLength: 120 })
  @WhenPresent()
  @RequiredText('Legal name', 120, 2)
  legalName?: string;

  @ApiPropertyOptional({ nullable: true, maxLength: 300 })
  @OptionalText('Address', 300)
  address?: string | null;

  @ApiPropertyOptional({
    nullable: true,
    example: '27ABCDE1234F1Z5',
    description: '15 letters and digits.',
  })
  @IsOptional()
  @Transform(({ value }) =>
    typeof value === 'string'
      ? value.trim() === ''
        ? null
        : value.trim().toUpperCase()
      : value,
  )
  @Matches(/^[0-9A-Z]{15}$/, {
    message: 'GSTIN must be 15 letters and digits.',
  })
  gstin?: string | null;

  @ApiPropertyOptional({ example: 'GST', maxLength: 20 })
  @WhenPresent()
  @RequiredText('Tax label', 20, 1)
  taxLabel?: string;

  @ApiPropertyOptional({
    description: 'Basis points: 1800 is 18%. 0 for no tax.',
    minimum: 0,
    maximum: 10000,
  })
  @WhenPresent()
  @WholeNumber('Tax rate', { min: 0, max: 10_000 })
  taxRateBps?: number;

  @ApiPropertyOptional({ minimum: 0, maximum: 90 })
  @WhenPresent()
  @WholeNumber('Due days', { min: 0, max: 90 })
  dueDays?: number;

  @ApiPropertyOptional({ minimum: 0, maximum: 90 })
  @WhenPresent()
  @WholeNumber('Grace days', { min: 0, max: 90 })
  graceDays?: number;

  @ApiPropertyOptional({ minimum: 0, maximum: 60 })
  @WhenPresent()
  @WholeNumber('Renewal notice days', { min: 0, max: 60 })
  renewalNoticeDays?: number;
}

export class VerifyPaymentDto {
  @ApiProperty({ example: 'order_Abc123' })
  @IsString()
  @MaxLength(100)
  razorpayOrderId!: string;

  @ApiProperty({ example: 'pay_Abc123' })
  @IsString()
  @MaxLength(100)
  razorpayPaymentId!: string;

  @ApiProperty({
    description:
      'The signature Razorpay Checkout returned. It is checked on the server; it is never trusted on its own.',
  })
  @IsString()
  @MaxLength(200)
  razorpaySignature!: string;
}
