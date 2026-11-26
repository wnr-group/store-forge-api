import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsIn, IsInt, IsString, Matches, Max, Min } from 'class-validator';
import { IMAGE_TYPES, LOGO_MAX_BYTES } from '../../storage/storage-paths.js';
import {
  CurrencyField,
  OptionalEmail,
  RequiredText,
  TimezoneField,
  WhenPresent,
} from '../../../common/validation/fields.js';

export class PlatformSettingsDto {
  @ApiProperty({ example: 'StoreForge' }) platformName!: string;
  @ApiPropertyOptional({ nullable: true }) supportEmail!: string | null;
  @ApiProperty({ example: 'INR' }) defaultCurrency!: string;
  @ApiProperty({ example: 'Asia/Kolkata' }) defaultTimezone!: string;
  @ApiProperty({ enum: ['active', 'inactive'] }) defaultStoreStatus!: string;
  @ApiPropertyOptional({
    nullable: true,
    description:
      'Public address of the platform logo, or null when the built-in logo is used.',
  })
  logoUrl!: string | null;
  @ApiProperty() updatedAt!: Date;
  @ApiPropertyOptional({ nullable: true }) updatedByEmail!: string | null;
}

/** Partial update: omitted fields keep their value. */
export class UpdatePlatformSettingsDto {
  @ApiPropertyOptional({ minLength: 2, maxLength: 60 })
  @WhenPresent()
  @RequiredText('Platform name', 60, 2)
  platformName?: string;

  @ApiPropertyOptional({ nullable: true })
  @OptionalEmail('Support email')
  supportEmail?: string | null;

  @ApiPropertyOptional({
    example: 'INR',
    description:
      'The default currency for organizations created from now on. Existing organizations are not affected.',
  })
  @WhenPresent()
  @CurrencyField()
  defaultCurrency?: string;

  @ApiPropertyOptional({ example: 'Asia/Kolkata' })
  @WhenPresent()
  @TimezoneField()
  defaultTimezone?: string;

  @ApiPropertyOptional({
    enum: ['active', 'inactive'],
    description: 'Whether new stores start as `active` or `inactive`.',
  })
  @WhenPresent()
  @IsIn(['active', 'inactive'], { message: 'Choose how new stores start.' })
  defaultStoreStatus?: 'active' | 'inactive';
}

export class LogoUploadRequestDto {
  @ApiProperty({ enum: IMAGE_TYPES })
  @IsIn([...IMAGE_TYPES], {
    message: 'The logo must be a JPEG, PNG or WebP image.',
  })
  type!: string;

  @ApiProperty({ description: 'File size in bytes. At most 2 MB.' })
  @IsInt()
  @Min(1)
  @Max(LOGO_MAX_BYTES, { message: 'The logo must be 2 MB or smaller.' })
  size!: number;
}

export class LogoUploadTargetDto {
  @ApiProperty({
    description:
      'Send this back to `PUT /platform/settings/logo` once the file is uploaded.',
  })
  path!: string;
  @ApiProperty({ description: 'A token that can be used for one upload only.' })
  token!: string;
  @ApiProperty({
    description: 'Upload the file to this address with a PUT request.',
  })
  signedUrl!: string;
}

export class SetLogoDto {
  @ApiProperty({
    example: 'logo/6f1c.png',
    description:
      'The `path` returned by the upload link, after the file was uploaded.',
  })
  @IsString()
  @Matches(/^logo\/[A-Za-z0-9._-]{1,120}$/, { message: 'Invalid logo path.' })
  path!: string;
}
