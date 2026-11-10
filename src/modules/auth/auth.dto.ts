import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsString, MaxLength, MinLength } from 'class-validator';
import { PasswordField } from '../../common/validation/fields.js';

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
  @ApiProperty({
    enum: ['super_admin', 'admin'],
    nullable: true,
    description: 'Platform Admin level, or null for everyone else.',
  })
  platformAdminLevel!: 'super_admin' | 'admin' | null;
  @ApiProperty({ type: [MembershipDto] }) memberships!: MembershipDto[];
}
