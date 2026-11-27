import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsIn, IsString, Matches, MaxLength } from 'class-validator';
import { RequiredText } from '../../common/validation/fields.js';

const INTERVALS = ['monthly', 'yearly'] as const;

export class StartCheckoutDto {
  @ApiProperty({
    example: 'growth',
    description:
      'The code of a plan shown on the public pricing page. Only published plans can be bought.',
  })
  @IsString({ message: 'Choose a plan.' })
  @MaxLength(40, { message: 'Choose a plan.' })
  @Matches(/^[a-z0-9][a-z0-9_-]{1,38}[a-z0-9]$/, {
    message: 'Choose a plan.',
  })
  planCode!: string;

  @ApiProperty({ enum: INTERVALS })
  @IsIn(INTERVALS, { message: 'Choose monthly or yearly billing.' })
  billingInterval!: (typeof INTERVALS)[number];
}

export class CreateStoreDto {
  @ApiProperty({
    example: 'Blue Door Coffee',
    description:
      'The name of the store. The store address is made from it automatically; two stores can have the same name.',
  })
  @RequiredText('Store name', 80, 2)
  storeName!: string;
}

export class SignupPaymentDto {
  @ApiProperty({ description: 'Pass to Razorpay Checkout as `order_id`.' })
  orderId!: string;
  @ApiProperty({
    description:
      'The public Razorpay Key ID. The secret never leaves the server.',
  })
  keyId!: string;
}

export class SignupStatusDto {
  @ApiProperty({
    enum: ['none', 'payment_required', 'store_required', 'provisioned'],
    description:
      'What to do next: `none` (nothing started), `payment_required` (pay for the plan), `store_required` (paid, now name the store) or `provisioned` (the store exists).',
  })
  state!: 'none' | 'payment_required' | 'store_required' | 'provisioned';
  @ApiPropertyOptional({ format: 'uuid', nullable: true }) signupId!:
    string | null;
  @ApiPropertyOptional({ nullable: true }) planCode!: string | null;
  @ApiPropertyOptional({ nullable: true }) planName!: string | null;
  @ApiPropertyOptional({ enum: INTERVALS, nullable: true })
  billingInterval!: 'monthly' | 'yearly' | null;
  @ApiPropertyOptional({ nullable: true }) currency!: string | null;
  @ApiPropertyOptional({ nullable: true }) subtotalMinor!: number | null;
  @ApiPropertyOptional({ nullable: true }) taxMinor!: number | null;
  @ApiPropertyOptional({ nullable: true }) totalMinor!: number | null;
  @ApiPropertyOptional({ format: 'uuid', nullable: true }) tenantId!:
    string | null;
  @ApiPropertyOptional({
    nullable: true,
    description: 'Why the last payment attempt failed, if it did.',
  })
  lastFailure!: string | null;
}

export class SignupCheckoutDto extends SignupStatusDto {
  @ApiPropertyOptional({
    type: SignupPaymentDto,
    nullable: true,
    description:
      'What Razorpay Checkout needs. Null when there is nothing to pay (a free plan, or the plan is already paid).',
  })
  payment!: SignupPaymentDto | null;
}

export class SignupPaymentVerifiedDto {
  @ApiProperty({ enum: ['captured', 'duplicate'] }) result!: string;
  @ApiProperty({ enum: ['store_required', 'provisioned'] }) state!: string;
}

export class SignupStoreDto {
  @ApiProperty({ format: 'uuid' }) tenantId!: string;
  @ApiProperty() storeSlug!: string;
  @ApiProperty() publicId!: string;
  @ApiProperty({
    description:
      'False when the store already existed (the same request was sent twice).',
  })
  created!: boolean;
}
