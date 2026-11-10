import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsIn, IsOptional, ValidateNested } from 'class-validator';
import { MODULE_LABELS } from '../../common/constants/permissions.js';
import {
  EmailField,
  PasswordField,
  RequiredText,
  WhenPresent,
} from '../../common/validation/fields.js';
import { MEMBERSHIP_STATUSES } from '../../database/schema/enums.js';

const levelsOf = (m: keyof typeof MODULE_LABELS) => [
  ...MODULE_LABELS[m].levels,
];

/**
 * The Owner picks a level per module. Each module accepts only the levels the product offers (orders are
 * read-only for now, store settings are always at least readable); the database re-validates the stored object.
 */
export class PermissionsDto {
  @ApiProperty({ enum: levelsOf('products') })
  @IsIn(levelsOf('products'), { message: 'Choose an access level.' })
  products!: 'none' | 'read' | 'write';

  @ApiProperty({
    enum: levelsOf('orders'),
    description: 'Orders are read-only for now.',
  })
  @IsIn(levelsOf('orders'), { message: 'Choose an access level.' })
  orders!: 'none' | 'read';

  @ApiProperty({ enum: levelsOf('customers') })
  @IsIn(levelsOf('customers'), { message: 'Choose an access level.' })
  customers!: 'none' | 'read' | 'write';

  @ApiProperty({
    enum: levelsOf('settings'),
    description: 'Store settings are always at least readable.',
  })
  @IsIn(levelsOf('settings'), { message: 'Choose an access level.' })
  settings!: 'read' | 'write';
}

export class TeamMemberDto {
  @ApiProperty({ format: 'uuid' }) userId!: string;
  @ApiPropertyOptional({ nullable: true }) fullName!: string | null;
  @ApiProperty() email!: string;
  @ApiProperty({ enum: ['owner', 'admin', 'staff'] }) role!: string;
  @ApiProperty({
    description: 'Display label: Owner, Manager, Staff, Viewer or Custom.',
  })
  roleLabel!: string;
  @ApiProperty({ enum: MEMBERSHIP_STATUSES }) status!: string;
  @ApiProperty() joinedAt!: Date;
  @ApiProperty() permissions!: Record<string, string>;
}

export class CreateMemberDto {
  @ApiProperty({ minLength: 2, maxLength: 120 })
  @RequiredText('Member name', 120, 2)
  fullName!: string;

  @ApiProperty()
  @EmailField('Member email')
  email!: string;

  @ApiProperty({
    description:
      'Initial password (8-72 chars, a letter and a number). Share it securely; it is never stored by StoreForge.',
  })
  @PasswordField()
  password!: string;

  @ApiProperty({ type: PermissionsDto })
  @ValidateNested()
  @Type(() => PermissionsDto)
  permissions!: PermissionsDto;
}

export class UpdateMemberDto {
  @ApiPropertyOptional({ minLength: 2, maxLength: 120 })
  @WhenPresent()
  @RequiredText('Member name', 120, 2)
  fullName?: string;

  @ApiPropertyOptional({ type: PermissionsDto })
  @IsOptional()
  @ValidateNested()
  @Type(() => PermissionsDto)
  permissions?: PermissionsDto;
}

export class MemberStatusDto {
  @ApiProperty({ enum: MEMBERSHIP_STATUSES })
  @IsIn(MEMBERSHIP_STATUSES, { message: 'Choose a status.' })
  status!: (typeof MEMBERSHIP_STATUSES)[number];
}

export class ResetPasswordDto {
  @ApiProperty({
    description: 'New password (8-72 chars, a letter and a number).',
  })
  @PasswordField()
  password!: string;
}

export class CreatedMemberDto {
  @ApiProperty({ format: 'uuid' }) userId!: string;
  @ApiProperty() email!: string;
}
