import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform, Type } from 'class-transformer';
import {
  IsBoolean,
  IsEmail,
  IsInt,
  IsOptional,
  IsString,
  Matches,
  Max,
  MaxLength,
  Min,
  MinLength,
} from 'class-validator';
import { CheckoutAddressDto, PublicOrderDto } from '../orders/checkout.dto.js';

const trim = ({ value }: { value: unknown }) =>
  typeof value === 'string' ? value.trim() : value;
const lower = ({ value }: { value: unknown }) =>
  typeof value === 'string' ? value.trim().toLowerCase() : value;

const MOBILE = /^(?:\+?91[\s-]?)?[6-9]\d{9}$/;
const PASSWORD_RULE = {
  message: 'Use at least 8 characters, with a letter and a number.',
};

export class RegisterCustomerDto {
  @ApiProperty({ example: 'Asha Rao' })
  @Transform(trim)
  @IsString()
  @MinLength(1, { message: 'Enter your name.' })
  @MaxLength(120)
  fullName!: string;

  @ApiProperty({ format: 'email' })
  @Transform(lower)
  @IsEmail({}, { message: 'Enter a valid email address.' })
  @MaxLength(254)
  email!: string;

  @ApiPropertyOptional({ example: '9876543210' })
  @IsOptional()
  @Transform(trim)
  @Matches(MOBILE, { message: 'Enter a valid 10-digit Indian mobile number.' })
  phone?: string;

  @ApiProperty({ minLength: 8, maxLength: 128 })
  @IsString()
  @MinLength(8, PASSWORD_RULE)
  @MaxLength(128, { message: 'Use at most 128 characters.' })
  @Matches(/[A-Za-z]/, PASSWORD_RULE)
  @Matches(/\d/, PASSWORD_RULE)
  password!: string;
}

export class LoginCustomerDto {
  @ApiProperty({ format: 'email' })
  @Transform(lower)
  @IsEmail({}, { message: 'Enter a valid email address.' })
  @MaxLength(254)
  email!: string;

  @ApiProperty()
  @IsString()
  @MinLength(1, { message: 'Enter your password.' })
  @MaxLength(128)
  password!: string;
}

export class UpdateCustomerProfileDto {
  @ApiPropertyOptional()
  @IsOptional()
  @Transform(trim)
  @IsString()
  @MinLength(1, { message: 'Enter your name.' })
  @MaxLength(120)
  fullName?: string;

  @ApiPropertyOptional({
    nullable: true,
    description: 'An empty value removes the phone number.',
  })
  @IsOptional()
  @Transform(trim)
  @Matches(/^$|^(?:\+?91[\s-]?)?[6-9]\d{9}$/, {
    message: 'Enter a valid 10-digit Indian mobile number.',
  })
  phone?: string;
}

export class ChangeCustomerPasswordDto {
  @ApiProperty()
  @IsString()
  @MinLength(1, { message: 'Enter your current password.' })
  @MaxLength(128)
  currentPassword!: string;

  @ApiProperty({ minLength: 8, maxLength: 128 })
  @IsString()
  @MinLength(8, PASSWORD_RULE)
  @MaxLength(128, { message: 'Use at most 128 characters.' })
  @Matches(/[A-Za-z]/, PASSWORD_RULE)
  @Matches(/\d/, PASSWORD_RULE)
  newPassword!: string;
}

/** A saved address: the checkout address plus a label and the default flag. */
export class CustomerAddressInputDto extends CheckoutAddressDto {
  @ApiPropertyOptional({ example: 'Home' })
  @IsOptional()
  @Transform(trim)
  @IsString()
  @MaxLength(40)
  label?: string;

  @ApiPropertyOptional({ default: false })
  @IsOptional()
  @IsBoolean()
  isDefault?: boolean;
}

export class CustomerAccountOrdersQueryDto {
  @ApiPropertyOptional({ default: 1, minimum: 1 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100_000)
  page: number = 1;

  @ApiPropertyOptional({ default: 10, minimum: 1, maximum: 50 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(50)
  limit: number = 10;
}

export class CustomerProfileDto {
  @ApiProperty() fullName!: string;
  @ApiProperty() email!: string;
  @ApiPropertyOptional({ nullable: true }) phone!: string | null;
}

export class CustomerSessionDto {
  @ApiProperty({
    description:
      'The session token. Shown ONCE; the storefront keeps it in an HttpOnly cookie and sends it back as X-Customer-Session.',
  })
  sessionToken!: string;
  @ApiProperty() expiresAt!: Date;
  @ApiProperty({ type: CustomerProfileDto }) profile!: CustomerProfileDto;
}

export class CustomerAddressDto {
  @ApiProperty({ format: 'uuid' }) id!: string;
  @ApiPropertyOptional({ nullable: true }) label!: string | null;
  @ApiProperty() fullName!: string;
  @ApiProperty() phone!: string;
  @ApiProperty() line1!: string;
  @ApiPropertyOptional({ nullable: true }) line2!: string | null;
  @ApiProperty() city!: string;
  @ApiProperty() state!: string;
  @ApiProperty() postalCode!: string;
  @ApiProperty() isDefault!: boolean;
}

export class OrderTimelineEntryDto {
  @ApiProperty({
    description:
      'The status the order moved INTO (pending_payment shows as "Order placed").',
  })
  status!: string;
  @ApiProperty() at!: Date;
}

export class AccountOrderDto extends PublicOrderDto {
  @ApiProperty({
    type: [OrderTimelineEntryDto],
    description: 'Every status change, oldest first, with its time.',
  })
  timeline!: OrderTimelineEntryDto[];
}

export class AccountOrderSummaryDto {
  @ApiProperty() orderNumber!: number;
  @ApiProperty() status!: string;
  @ApiProperty() paymentStatus!: string;
  @ApiProperty() paymentMethod!: string;
  @ApiProperty() currency!: string;
  @ApiProperty() totalMinor!: number;
  @ApiProperty() placedAt!: Date;
  @ApiProperty() itemCount!: number;
  @ApiPropertyOptional({ nullable: true }) firstItemName!: string | null;
}
