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
      'Where the logo file is stored in the `products` storage bucket (`{tenantId}/store/...`). This is a storage path, not a web address.',
  })
  logoPath!: string | null;
  @ApiPropertyOptional({
    nullable: true,
    maxLength: 70,
    description: 'SEO title of the storefront home page.',
  })
  metaTitle!: string | null;
  @ApiPropertyOptional({
    nullable: true,
    maxLength: 160,
    description: 'SEO description of the storefront home page.',
  })
  metaDescription!: string | null;
  @ApiPropertyOptional({ nullable: true }) contactEmail!: string | null;
  @ApiPropertyOptional({ nullable: true }) contactPhone!: string | null;
  @ApiProperty({ example: 'INR' }) currency!: string;
  @ApiProperty({ example: 'Asia/Kolkata' }) timezone!: string;
  @ApiProperty({ enum: ['active', 'inactive', 'suspended'] }) status!: string;
  @ApiProperty({
    description:
      'Becomes true once the organization has products or orders. From then on the currency can no longer be changed.',
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
      'The store web address: 3 to 40 characters, using only lowercase letters, digits and hyphens. Reserved names cannot be used.',
  })
  @WhenPresent()
  @StoreSlug()
  slug?: string;

  @ApiPropertyOptional({ nullable: true, maxLength: 500 })
  @OptionalText('Store description', 500)
  description?: string | null;

  @ApiPropertyOptional({
    nullable: true,
    maxLength: 70,
    description:
      'SEO title of the storefront home page. Send null or an empty value to clear it.',
  })
  @OptionalText('Meta title', 70)
  metaTitle?: string | null;

  @ApiPropertyOptional({
    nullable: true,
    maxLength: 160,
    description:
      'SEO description of the storefront home page. Send null or an empty value to clear it.',
  })
  @OptionalText('Meta description', 160)
  metaDescription?: string | null;

  @ApiPropertyOptional({ nullable: true })
  @OptionalEmail('Store email')
  contactEmail?: string | null;

  @ApiPropertyOptional({ nullable: true })
  @OptionalPhone()
  contactPhone?: string | null;

  @ApiPropertyOptional({
    example: 'INR',
    description: 'Cannot be changed once the store has products or orders.',
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
      "The path you received from POST /uploads/signed-urls with scope `store`. The file must be in your organization's own store folder.",
  })
  @IsOptional()
  @IsString()
  @MaxLength(300)
  logoPath?: string | null;
}
