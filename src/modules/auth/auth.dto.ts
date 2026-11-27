import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  Equals,
  IsBoolean,
  IsOptional,
  IsString,
  Matches,
  MaxLength,
  MinLength,
} from 'class-validator';
import {
  PLATFORM_ADMIN_ROLES,
  type PlatformAdminRole,
} from '../../database/schema/enums.js';
import {
  EmailField,
  PasswordField,
  RequiredText,
} from '../../common/validation/fields.js';
import { HOST_LABEL } from './handoff-code.js';

/** Same rules as the Next.js login form: a trimmed, lower-cased e-mail and a non-empty password of at most 72 characters. */
export class LoginDto {
  @ApiProperty({ example: 'owner@example.com' })
  @EmailField('Email')
  email!: string;

  @ApiProperty({
    description:
      'The password of your account. It is never saved or written to logs.',
  })
  @IsString({ message: 'Enter your password' })
  @MinLength(1, { message: 'Enter your password' })
  @MaxLength(72)
  password!: string;

  @ApiPropertyOptional({
    default: true,
    description:
      'Set this to false if you only need the session cookies. The response then contains just `id`, `email` and `expiresAt`, and the database lookup for your profile and organizations is skipped.',
  })
  @IsOptional()
  @IsBoolean()
  includeProfile?: boolean;
}

/**
 * Self-service account creation (no email verification in this version). The same password rules as every other place that sets
 * one; the confirmation and the terms are checked here too, never only in the browser.
 */
export class RegisterDto {
  @ApiProperty({ example: 'Asha Rao', description: 'Your full name.' })
  @RequiredText('Full name', 80, 2)
  fullName!: string;

  @ApiProperty({ example: 'asha@example.com' })
  @EmailField('Email')
  email!: string;

  @ApiProperty({
    description:
      'A password of 8 to 72 characters with at least one letter and one number. It is never saved or written to logs.',
  })
  @PasswordField()
  password!: string;

  @ApiProperty({
    description: 'Type the password again. It must be exactly the same.',
  })
  @IsString({ message: 'Confirm your password' })
  @MaxLength(72)
  confirmPassword!: string;

  @ApiProperty({
    example: true,
    description:
      'Must be true: you accept the Terms and Conditions. The time of acceptance is saved with the account.',
  })
  @Equals(true, { message: 'Accept the Terms and Conditions to continue' })
  acceptTerms!: boolean;

  @ApiPropertyOptional({
    default: true,
    description:
      'Set this to false if you only need the session cookies (see sign-in).',
  })
  @IsOptional()
  @IsBoolean()
  includeProfile?: boolean;
}

export class ChangePasswordDto {
  @ApiProperty({
    description: 'Your current password. It is checked again with Supabase.',
  })
  @IsString({ message: 'Enter your current password' })
  @MinLength(1, { message: 'Enter your current password' })
  @MaxLength(72)
  currentPassword!: string;

  @ApiProperty({
    description:
      'Your new password. It must be 8 to 72 characters long, contain at least one letter and one number, and be different from your current password.',
  })
  @PasswordField()
  password!: string;

  @ApiProperty({
    description:
      'Type the new password again. It must be exactly the same as `password`.',
  })
  @IsString({ message: 'Confirm your new password' })
  confirmPassword!: string;
}

export class MembershipDto {
  @ApiProperty({ format: 'uuid' }) organizationId!: string;
  @ApiProperty() organizationName!: string;
  @ApiProperty() organizationSlug!: string;
  @ApiProperty({ enum: ['owner', 'admin', 'staff'] }) role!: string;
  @ApiProperty({
    example: { products: 'write', orders: 'read' },
    description:
      'The access level the Owner has given you for each part (module) of the store.',
  })
  permissions!: Record<string, string>;
  @ApiProperty({
    type: [String],
    example: ['attest'],
    description: 'Independent capabilities (attest, discard).',
  })
  capabilities!: string[];
  @ApiProperty() joinedAt!: Date;
}

export class MeDto {
  @ApiProperty({ format: 'uuid' }) id!: string;
  @ApiPropertyOptional({ nullable: true }) email!: string | null;
  @ApiPropertyOptional({
    nullable: true,
    description: 'The name shown on your profile.',
  })
  fullName!: string | null;
  @ApiProperty({
    enum: PLATFORM_ADMIN_ROLES,
    nullable: true,
    description:
      'Your platform role (`super_admin`, `admin`, `billing_admin` or `support_admin`), or null if you are not platform staff. It says who you are; what the role may do is returned by `GET /platform/me`, and every platform route checks it again.',
  })
  platformAdminLevel!: PlatformAdminRole | null;
  @ApiProperty({ type: [MembershipDto] }) memberships!: MembershipDto[];
}

/** What a successful sign-in returns: the safe profile (no tokens: those are only in HttpOnly cookies). */
export class LoginResponseDto extends MeDto {
  @ApiPropertyOptional({
    nullable: true,
    description:
      'The time when the access token in your cookie stops working, as a Unix timestamp in seconds.',
  })
  expiresAt!: number | null;
}

/** The reduced sign-in answer (`includeProfile: false`): who signed in and when the session expires, nothing from the database. */
export type LoginSessionOnly = Pick<MeDto, 'id' | 'email'> & {
  expiresAt: number | null;
};

/** The reduced sign-in answer (see `LoginSessionOnly`): who signed in and when the session ends. */
export class LoginSessionDto {
  @ApiProperty({ format: 'uuid' }) id!: string;
  @ApiPropertyOptional({ nullable: true }) email!: string | null;
  @ApiPropertyOptional({ nullable: true }) expiresAt!: number | null;
}

export class SessionUserDto {
  @ApiProperty({ format: 'uuid' }) id!: string;
  @ApiPropertyOptional({ nullable: true }) email!: string | null;
  @ApiPropertyOptional({
    nullable: true,
    description:
      'The name stored in your sign-in token (`user_metadata.full_name`).',
  })
  fullName?: string | null;
}

export class SessionDto {
  @ApiProperty({ type: SessionUserDto }) user!: SessionUserDto;
  @ApiPropertyOptional({
    nullable: true,
    description:
      'The time when your access token stops working, as a Unix timestamp in seconds.',
  })
  expiresAt!: number | null;
}

export class SignedOutDto {
  @ApiProperty({ example: true }) signedOut!: boolean;
}

export class HandoffRequestDto {
  @ApiProperty({
    example: 'urban-nest-zqkod2',
    description:
      'The host label of the store to open, `{store slug}-{public id}`: the part before the root domain. You must be an active member of that store.',
  })
  @IsString()
  @Matches(HOST_LABEL, { message: 'Enter a valid store address.' })
  audience!: string;
}

export class HandoffDto {
  @ApiProperty({
    description:
      'A one-time code. It works once, only for the store it was made for, and only for one minute.',
  })
  code!: string;
  @ApiProperty({ example: 60 }) expiresInSeconds!: number;
}

export class HandoffExchangeDto {
  @ApiProperty({ description: 'The code from `POST /auth/handoff`.' })
  @IsString()
  @MinLength(20)
  @MaxLength(2000)
  code!: string;

  @ApiProperty({
    example: 'urban-nest-zqkod2',
    description: 'The store host that is receiving the code.',
  })
  @IsString()
  @Matches(HOST_LABEL, { message: 'Enter a valid store address.' })
  audience!: string;
}
