import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsIn } from 'class-validator';
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
    description: 'Applied to organizations created from now on.',
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
    description: 'How new stores start.',
  })
  @WhenPresent()
  @IsIn(['active', 'inactive'], { message: 'Choose how new stores start.' })
  defaultStoreStatus?: 'active' | 'inactive';
}
