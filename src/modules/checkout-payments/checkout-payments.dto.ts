import { ApiProperty } from '@nestjs/swagger';
import { Matches } from 'class-validator';

/** Razorpay ids look like `order_Abc123...` / `pay_Abc123...`. Fixed messages so nothing typed is echoed back. */
const RAZORPAY_ID = /^[A-Za-z0-9_]{8,64}$/;

export class RazorpayCustomerDto {
  @ApiProperty() name!: string;
  @ApiProperty() email!: string;
  @ApiProperty() contact!: string;
}

export class RazorpaySessionDto {
  @ApiProperty({
    description:
      'Your public Razorpay Key ID (safe to show in the browser). Pass it as `key` to Razorpay Checkout.',
  })
  keyId!: string;
  @ApiProperty({ description: 'Pass as `order_id` to Razorpay Checkout.' })
  razorpayOrderId!: string;
  @ApiProperty({
    description:
      'The amount in paise, decided by the server. Pass as `amount`.',
  })
  amountMinor!: number;
  @ApiProperty() currency!: string;
  @ApiProperty() orderNumber!: number;
  @ApiProperty({ type: RazorpayCustomerDto, description: 'Pass as `prefill`.' })
  customer!: RazorpayCustomerDto;
}

/** The three values Razorpay Checkout hands to its success callback, under Razorpay's own field names. */
export class VerifyRazorpayPaymentDto {
  @ApiProperty({ example: 'order_Abc12345678' })
  @Matches(RAZORPAY_ID, { message: 'Invalid payment details.' })
  razorpay_order_id!: string;

  @ApiProperty({ example: 'pay_Abc12345678' })
  @Matches(RAZORPAY_ID, { message: 'Invalid payment details.' })
  razorpay_payment_id!: string;

  @ApiProperty({ description: '64 hex characters.' })
  @Matches(/^[0-9a-fA-F]{64}$/, { message: 'Invalid payment details.' })
  razorpay_signature!: string;
}

/** What the browser reports when Razorpay Checkout says a payment failed. Used only to know which payment to look up. */
export class ReportRazorpayFailureDto {
  @ApiProperty({ example: 'order_Abc12345678' })
  @Matches(RAZORPAY_ID, { message: 'Invalid payment details.' })
  razorpay_order_id!: string;

  @ApiProperty({ example: 'pay_Abc12345678' })
  @Matches(RAZORPAY_ID, { message: 'Invalid payment details.' })
  razorpay_payment_id!: string;
}

export class PaymentMethodOptionsDto {
  @ApiProperty({
    description: 'Whether the shopper can pay online with Razorpay.',
  })
  razorpayAvailable!: boolean;
  @ApiProperty({
    description: 'Whether cash on delivery is offered for this order value.',
  })
  codAvailable!: boolean;
  @ApiProperty({
    description: 'The extra charge (paise) COD adds to the order.',
  })
  codFeeMinor!: number;
  @ApiProperty({
    nullable: true,
    description: 'Why COD is not offered, in words to show the shopper.',
  })
  codUnavailableReason!: string | null;
}
