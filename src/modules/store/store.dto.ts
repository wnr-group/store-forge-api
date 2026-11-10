import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsOptional, IsString, MaxLength } from 'class-validator';
import {
  CurrencyField,
  OptionalEmail,
  OptionalPhone,
  OptionalText,
  RequiredText,
  StoreSlug,
  TimezoneField,
  WhenPresent,
} from '../../common/validation/fields.js';

export class StoreDto {
  @ApiProperty({ format: 'uuid' }) id!: string;
  @ApiProperty() name!: string;
  @ApiProperty({ example: 'acme-store' }) slug!: string;
  @ApiPropertyOptional({ nullable: true }) description!: string | null;
  @ApiPropertyOptional({
    nullable: true,
    description:
      'Object path of the logo in the `products` bucket (`{tenantId}/store/...`), not a URL.',
  })
  logoPath!: string | null;
  @ApiPropertyOptional({ nullable: true }) contactEmail!: string | null;
  @ApiPropertyOptional({ nullable: true }) contactPhone!: string | null;
  @ApiProperty({ example: 'INR' }) currency!: string;
  @ApiProperty({ example: 'Asia/Kolkata' }) timezone!: string;
  @ApiProperty({ enum: ['active', 'inactive', 'suspended'] }) status!: string;
  @ApiProperty({
    description:
      'True once the organization has products or orders: the currency can no longer change.',
  })
  currencyLocked!: boolean;
  @ApiProperty() createdAt!: Date;
  @ApiProperty() updatedAt!: Date;
}

/** Partial update: omitted fields keep their current value; `null` clears an optional field. */
export class UpdateStoreDto {
  @ApiPropertyOptional({ minLength: 2, maxLength: 80 })
  @WhenPresent()
  @RequiredText('Store name', 80, 2)
  name?: string;

  @ApiPropertyOptional({
    description:
      'Store address: 3-40 chars, lowercase letters, digits, hyphens. Reserved names are refused.',
  })
  @WhenPresent()
  @StoreSlug()
  slug?: string;

  @ApiPropertyOptional({ nullable: true, maxLength: 500 })
  @OptionalText('Store description', 500)
  description?: string | null;

  @ApiPropertyOptional({ nullable: true })
  @OptionalEmail('Store email')
  contactEmail?: string | null;

  @ApiPropertyOptional({ nullable: true })
  @OptionalPhone()
  contactPhone?: string | null;

  @ApiPropertyOptional({
    example: 'INR',
    description: 'Locked once products or orders exist.',
  })
  @WhenPresent()
  @CurrencyField()
  currency?: string;

  @ApiPropertyOptional({ example: 'Asia/Kolkata' })
  @WhenPresent()
  @TimezoneField()
  timezone?: string;

  @ApiPropertyOptional({
    nullable: true,
    description:
      "Path returned by POST /uploads/signed-urls with scope `store`. Must exist under this organization's store folder.",
  })
  @IsOptional()
  @IsString()
  @MaxLength(300)
  logoPath?: string | null;
}
