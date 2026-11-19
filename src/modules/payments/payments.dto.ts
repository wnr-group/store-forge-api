import { ApiProperty } from '@nestjs/swagger';
import {
  IsString,
  Validate,
  ValidatorConstraint,
  type ValidatorConstraintInterface,
} from 'class-validator';
import { KEY_ID_PATTERN } from './key-id.js';
import { isValidKeySecret } from './key-secret.js';

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

/**
 * Body of `PUT /payments/razorpay`: exactly these two fields, both required. Unknown fields (including a tenant ID)
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
}
