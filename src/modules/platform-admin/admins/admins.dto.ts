import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsIn } from 'class-validator';
import {
  EmailField,
  PasswordField,
  RequiredText,
} from '../../../common/validation/fields.js';
import { PLATFORM_ADMIN_ROLES } from '../../../database/schema/enums.js';

export class PlatformAdminDto {
  @ApiProperty({ format: 'uuid' }) userId!: string;
  @ApiProperty() email!: string;
  @ApiPropertyOptional({ nullable: true }) fullName!: string | null;
  @ApiProperty({ enum: PLATFORM_ADMIN_ROLES }) role!: string;
  @ApiProperty() createdAt!: Date;
  @ApiPropertyOptional({ format: 'uuid', nullable: true }) createdBy!:
    string | null;
  @ApiPropertyOptional({ nullable: true }) createdByEmail!: string | null;
}

export class AddPlatformAdminDto {
  @ApiProperty({ minLength: 2, maxLength: 120 })
  @RequiredText('Name', 120, 2)
  fullName!: string;

  @ApiProperty()
  @EmailField('Email')
  email!: string;

  @ApiProperty({
    description:
      'Initial password (8-72 chars, a letter and a number). Never stored or logged.',
  })
  @PasswordField()
  password!: string;

  @ApiProperty({ enum: PLATFORM_ADMIN_ROLES })
  @IsIn(PLATFORM_ADMIN_ROLES, { message: 'Choose an access level.' })
  role!: (typeof PLATFORM_ADMIN_ROLES)[number];
}

export class SetPlatformAdminRoleDto {
  @ApiProperty({ enum: PLATFORM_ADMIN_ROLES })
  @IsIn(PLATFORM_ADMIN_ROLES, { message: 'Choose an access level.' })
  role!: (typeof PLATFORM_ADMIN_ROLES)[number];
}

export class AddedPlatformAdminDto {
  @ApiProperty() email!: string;
}
