import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsBoolean,
  IsOptional,
  IsString,
  Validate,
  ValidatorConstraint,
  type ValidatorConstraintInterface,
} from 'class-validator';
import { KEY_ID_PATTERN } from './key-id.js';
import { isValidKeySecret } from './key-secret.js';
import {
  isValidWebhookSecret,
  WEBHOOK_SECRET_PATTERN,
} from './webhook-secret.js';

/** Custom constraints, so the messages are fixed text and can never interpolate the submitted value. */
@ValidatorConstraint({ name: 'razorpayKeyId' })
class KeyIdConstraint implements ValidatorConstraintInterface {
  validate(value: unknown) {
    return typeof value === 'string' && KEY_ID_PATTERN.test(value);
  }
  defaultMessage() {
    return 'Enter a valid Razorpay Key ID, like rzp_test_ or rzp_live_ followed by at least 8 letters or numbers.';
  }
}

@ValidatorConstraint({ name: 'razorpayKeySecret' })
class KeySecretConstraint implements ValidatorConstraintInterface {
  validate(value: unknown) {
    return isValidKeySecret(value);
  }
  defaultMessage() {
    return 'Enter a valid Razorpay Key Secret: 16 to 128 letters and numbers, with no spaces or symbols.';
  }
}

@ValidatorConstraint({ name: 'razorpayWebhookSecret' })
class WebhookSecretConstraint implements ValidatorConstraintInterface {
  validate(value: unknown) {
    return isValidWebhookSecret(value);
  }
  defaultMessage() {
    return 'Enter a valid webhook secret: 8 to 128 letters, numbers or symbols, with no spaces.';
  }
}

/**
 * Body of `PUT /payments/razorpay`: the Key ID and Key Secret (both required) and an optional webhook secret. Unknown fields (including a tenant ID)
 * are rejected by the global ValidationPipe. Neither value is ever echoed back in an error.
 */
export class SaveRazorpayConfigDto {
  @ApiProperty({
    example: 'rzp_test_AbCdEfGh12345678',
    description:
      'Your Razorpay Key ID. Test or Live mode is taken from its prefix.',
    pattern: KEY_ID_PATTERN.source,
  })
  @IsString({ message: 'Enter your Razorpay Key ID.' })
  @Validate(KeyIdConstraint)
  keyId!: string;

  @ApiProperty({
    description:
      'Your Razorpay Key Secret: 16 to 128 letters and numbers. It is stored encrypted and is never shown again or written to logs.',
    pattern: '^[A-Za-z0-9]{16,128}$',
    minLength: 16,
    maxLength: 128,
    writeOnly: true,
  })
  @IsString({ message: 'Enter your Razorpay Key Secret.' })
  @Validate(KeySecretConstraint)
  keySecret!: string;

  @ApiPropertyOptional({
    description:
      'The webhook secret you set in Razorpay (Settings > Webhooks). 8 to 128 visible characters, no spaces. Optional: when left out, a webhook secret that is already saved is kept. It is stored encrypted and is never shown again or written to logs.',
    pattern: WEBHOOK_SECRET_PATTERN.source,
    minLength: 8,
    maxLength: 128,
    writeOnly: true,
  })
  @IsOptional()
  @IsString({ message: 'Enter your Razorpay webhook secret.' })
  @Validate(WebhookSecretConstraint)
  webhookSecret?: string;
}

/**
 * What `GET`, `PUT` and `DELETE /payments/razorpay` return: whether credentials are saved, and only safe facts about them.
 * `{ configured: false }` carries no other field. The secret, its ciphertext, IV, tag and key version are never returned, and
 * "configured" means saved, NOT verified with Razorpay.
 */
export class SetRazorpayEnabledDto {
  @ApiProperty({
    description:
      'Turn Razorpay payments on or off at checkout. Turning them on needs a successful connection check first.',
  })
  @IsBoolean({ message: 'Choose on or off.' })
  enabled!: boolean;
}

export class RazorpayStatusDto {
  @ApiProperty({
    description:
      'True when a Key ID and Key Secret are saved. It does not mean they were checked with Razorpay.',
  })
  configured!: boolean;

  @ApiPropertyOptional({
    description:
      'True when shoppers can pay with Razorpay. It is off until the connection check succeeds and the Owner turns it on, and it switches off again whenever the keys are replaced.',
  })
  enabled?: boolean;

  @ApiPropertyOptional({
    example: '/webhooks/razorpay/k3x9a2',
    description:
      'The path to give Razorpay under Settings > Webhooks (add your API address in front). Use the webhook secret you saved here, and tick payment.authorized, payment.captured, payment.failed, order.paid and the refund events.',
  })
  webhookPath?: string;

  @ApiPropertyOptional({
    enum: ['unverified', 'verified', 'failed'],
    description: 'Result of the last connection check against Razorpay.',
  })
  verificationStatus?: 'unverified' | 'verified' | 'failed';

  @ApiPropertyOptional({ nullable: true })
  verifiedAt?: Date | null;

  @ApiPropertyOptional({
    nullable: true,
    description: 'A short, safe reason when the last connection check failed.',
  })
  verificationError?: string | null;

  @ApiPropertyOptional({
    description:
      'True when a webhook secret is saved. The secret itself is never returned.',
  })
  webhookSecretConfigured?: boolean;

  @ApiPropertyOptional({
    nullable: true,
    description:
      'When the webhook secret was last saved, or null when none is saved.',
  })
  webhookSecretUpdatedAt?: Date | null;

  @ApiPropertyOptional({
    example: 'rzp_test_••••5678',
    description:
      'The Key ID with its middle hidden: the prefix and the last four characters.',
  })
  keyIdMasked?: string;

  @ApiPropertyOptional({
    enum: ['test', 'live'],
    description: 'Taken from the Key ID prefix.',
  })
  mode?: 'test' | 'live';

  @ApiPropertyOptional({
    description: 'When the credentials were last saved.',
  })
  updatedAt?: Date;

  @ApiPropertyOptional({
    nullable: true,
    description:
      'The name of the person who last saved them, or null when that person is no longer on the team.',
  })
  updatedByName?: string | null;
}
