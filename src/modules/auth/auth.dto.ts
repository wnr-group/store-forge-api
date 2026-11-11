import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsBoolean,
  IsOptional,
  IsString,
  MaxLength,
  MinLength,
} from 'class-validator';
import { EmailField, PasswordField } from '../../common/validation/fields.js';

/** Same rules as the Next.js login form: a trimmed, lower-cased e-mail and a non-empty password of at most 72 characters. */
export class LoginDto {
  @ApiProperty({ example: 'owner@example.com' })
  @EmailField('Email')
  email!: string;

  @ApiProperty({
    description: 'The existing account password. Never stored or logged.',
  })
  @IsString({ message: 'Enter your password' })
  @MinLength(1, { message: 'Enter your password' })
  @MaxLength(72)
  password!: string;

  @ApiPropertyOptional({
    default: true,
    description:
      'Set to false when the caller only needs the session cookies: the response then carries just `id`, `email` and `expiresAt`, and the profile/memberships lookup (a database transaction) is skipped.',
  })
  @IsOptional()
  @IsBoolean()
  includeProfile?: boolean;
}

export class ChangePasswordDto {
  @ApiProperty({ description: 'Current password, re-verified with Supabase.' })
  @IsString({ message: 'Enter your current password' })
  @MinLength(1, { message: 'Enter your current password' })
  @MaxLength(72)
  currentPassword!: string;

  @ApiProperty({
    description:
      '8-72 characters with at least one letter and one number. Must differ from the current password.',
  })
  @PasswordField()
  password!: string;

  @ApiProperty({ description: 'Must equal `password`.' })
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
    description: 'Owner-granted access level per module.',
  })
  permissions!: Record<string, string>;
  @ApiProperty() joinedAt!: Date;
}

export class MeDto {
  @ApiProperty({ format: 'uuid' }) id!: string;
  @ApiPropertyOptional({ nullable: true }) email!: string | null;
  @ApiPropertyOptional({
    nullable: true,
    description: 'Display name from the profile.',
  })
  fullName!: string | null;
  @ApiProperty({
    enum: ['super_admin', 'admin'],
    nullable: true,
    description: 'Platform Admin level, or null for everyone else.',
  })
  platformAdminLevel!: 'super_admin' | 'admin' | null;
  @ApiProperty({ type: [MembershipDto] }) memberships!: MembershipDto[];
}

/** What a successful sign-in returns: the safe profile (no tokens: those are only in HttpOnly cookies). */
export class LoginResponseDto extends MeDto {
  @ApiPropertyOptional({
    nullable: true,
    description:
      'Unix time (seconds) at which the access token in the cookie expires.',
  })
  expiresAt!: number | null;
}

/** The reduced sign-in answer (`includeProfile: false`): who signed in and when the session expires, nothing from the database. */
export type LoginSessionOnly = Pick<MeDto, 'id' | 'email'> & {
  expiresAt: number | null;
};

export class SessionUserDto {
  @ApiProperty({ format: 'uuid' }) id!: string;
  @ApiPropertyOptional({ nullable: true }) email!: string | null;
  @ApiPropertyOptional({
    nullable: true,
    description: 'Display name from the token (`user_metadata.full_name`).',
  })
  fullName?: string | null;
}

export class SessionDto {
  @ApiProperty({ type: SessionUserDto }) user!: SessionUserDto;
  @ApiPropertyOptional({
    nullable: true,
    description: 'Unix time (seconds) at which the access token expires.',
  })
  expiresAt!: number | null;
}

export class SignedOutDto {
  @ApiProperty({ example: true }) signedOut!: boolean;
}
