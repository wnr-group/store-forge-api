import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  ArrayUnique,
  IsArray,
  IsIn,
  IsOptional,
  ValidateNested,
} from 'class-validator';
import { MODULE_LABELS } from '../../common/constants/permissions.js';
import {
  EmailField,
  PasswordField,
  RequiredText,
  WhenPresent,
} from '../../common/validation/fields.js';
import {
  MEMBER_CAPABILITIES,
  MEMBERSHIP_STATUSES,
  type MemberCapability,
} from '../../database/schema/enums.js';

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
    description: 'Orders can only be viewed for now, not changed.',
  })
  @IsIn(levelsOf('orders'), { message: 'Choose an access level.' })
  orders!: 'none' | 'read';

  @ApiProperty({ enum: levelsOf('customers') })
  @IsIn(levelsOf('customers'), { message: 'Choose an access level.' })
  customers!: 'none' | 'read' | 'write';

  @ApiProperty({
    enum: levelsOf('settings'),
    description: 'Members can always at least view the store settings.',
  })
  @IsIn(levelsOf('settings'), { message: 'Choose an access level.' })
  settings!: 'read' | 'write';

  @ApiPropertyOptional({
    enum: levelsOf('design'),
    description:
      'Studio access: none, read, write (edit drafts) or publish. Left out on an edit, the member keeps their current level; left out on a new member it means none. Attest and discard are separate (capabilities).',
  })
  @IsOptional()
  @IsIn(levelsOf('design'), { message: 'Choose an access level.' })
  design?: 'none' | 'read' | 'write' | 'publish';
}

/** Independent capabilities: they do not depend on any design level. */
export class CapabilitiesField {
  @ApiPropertyOptional({
    enum: MEMBER_CAPABILITIES,
    isArray: true,
    description:
      'Independent grants: attest and discard. They are not access levels and work with any design level.',
  })
  @IsOptional()
  @IsArray()
  @ArrayUnique()
  @IsIn(MEMBER_CAPABILITIES, {
    each: true,
    message: 'Choose attest and/or discard.',
  })
  capabilities?: MemberCapability[];
}

export class TeamMemberDto {
  @ApiProperty({ format: 'uuid' }) userId!: string;
  @ApiPropertyOptional({ nullable: true }) fullName!: string | null;
  @ApiProperty() email!: string;
  @ApiProperty({ enum: ['owner', 'admin', 'staff'] }) role!: string;
  @ApiProperty({
    description:
      "The name shown for this member's role: Owner, Manager, Staff, Viewer or Custom.",
  })
  roleLabel!: string;
  @ApiProperty({ enum: MEMBERSHIP_STATUSES }) status!: string;
  @ApiProperty() joinedAt!: Date;
  @ApiProperty() permissions!: Record<string, string>;
  @ApiProperty({ enum: MEMBER_CAPABILITIES, isArray: true })
  capabilities!: string[];
}

export class CreateMemberDto extends CapabilitiesField {
  @ApiProperty({ minLength: 2, maxLength: 120 })
  @RequiredText('Member name', 120, 2)
  fullName!: string;

  @ApiProperty()
  @EmailField('Member email')
  email!: string;

  @ApiProperty({
    description:
      'The first password for this member, 8 to 72 characters with at least one letter and one number. Share it with them in a safe way. StoreForge never saves it.',
  })
  @PasswordField()
  password!: string;

  @ApiProperty({ type: PermissionsDto })
  @ValidateNested()
  @Type(() => PermissionsDto)
  permissions!: PermissionsDto;
}

export class UpdateMemberDto extends CapabilitiesField {
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
    description:
      'The new password, 8 to 72 characters with at least one letter and one number.',
  })
  @PasswordField()
  password!: string;
}

export class CreatedMemberDto {
  @ApiProperty({ format: 'uuid' }) userId!: string;
  @ApiProperty() email!: string;
}
