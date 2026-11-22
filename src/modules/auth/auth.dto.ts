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
    enum: ['super_admin', 'admin'],
    nullable: true,
    description:
      'Your Platform Admin level, or null if you are not a Platform Admin.',
  })
  platformAdminLevel!: 'super_admin' | 'admin' | null;
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
