import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

export class PublicBrandingDto {
  @ApiProperty({ example: 'StoreForge' }) platformName!: string;
  @ApiPropertyOptional({ nullable: true }) supportEmail!: string | null;
}

export class StorefrontProductDto {
  @ApiProperty() name!: string;
  @ApiProperty() slug!: string;
  @ApiPropertyOptional({ nullable: true }) shortDescription!: string | null;
  @ApiProperty({
    description:
      "The price in the currency's smallest unit (for example cents).",
  })
  priceMinor!: number;
  @ApiPropertyOptional({ nullable: true }) compareAtPriceMinor!: number | null;
  @ApiPropertyOptional({
    nullable: true,
    description:
      'Where the image is stored in the public `products` storage bucket.',
  })
  imagePath!: string | null;
  @ApiProperty({
    description:
      'Whether the product can be bought now. Stock counts are never shown.',
  })
  available!: boolean;
}

export class StorefrontDto {
  @ApiProperty() name!: string;
  @ApiProperty() slug!: string;
  @ApiProperty({
    example: 'zqkod2',
    description:
      "The organization's read-only public identifier. A storefront address is {slug}-{publicId}, so a host whose public id does not match can be rejected.",
  })
  publicId!: string;
  @ApiPropertyOptional({ nullable: true }) description!: string | null;
  @ApiPropertyOptional({ nullable: true }) logoPath!: string | null;
  @ApiProperty({ example: 'INR' }) currency!: string;
  @ApiProperty({ type: [StorefrontProductDto] })
  products!: StorefrontProductDto[];
  @ApiPropertyOptional({
    nullable: true,
    description:
      'The look of the store (template settings). They come straight from the database and are passed on unchanged. Changing them is not possible through this API.',
    type: 'object',
    additionalProperties: true,
  })
  template!: Record<string, unknown> | null;
}

export class PublicHostDto {
  @ApiProperty({ example: 'urban-nest' }) slug!: string;
  @ApiProperty({ example: 'zqkod2' }) publicId!: string;
}

export class PublicLayoutDto {
  @ApiPropertyOptional({
    nullable: true,
    enum: ['assigned', 'default'],
    description:
      'Which step found the page design; null when none is published.',
  })
  source!: string | null;
  @ApiPropertyOptional({
    nullable: true,
    type: 'object',
    additionalProperties: true,
    description:
      'The published page: `{ name, version_number, document }`. Null when nothing is published yet.',
  })
  template!: Record<string, unknown> | null;
  @ApiPropertyOptional({
    nullable: true,
    type: 'object',
    additionalProperties: true,
    description: 'The published theme settings (colours, fonts, spacing).',
  })
  theme!: Record<string, unknown> | null;
  @ApiProperty({
    type: 'object',
    additionalProperties: true,
    description:
      'Published header, footer and announcement documents (each may be null).',
  })
  groups!: Record<string, unknown>;
}

export class PublicCollectionDto {
  @ApiProperty() id!: string;
  @ApiProperty() name!: string;
  @ApiProperty() slug!: string;
  @ApiPropertyOptional({ nullable: true }) description!: string | null;
  @ApiPropertyOptional({ nullable: true }) image_path!: string | null;
  @ApiProperty() product_count!: number;
}

export class PublicResourceDto {
  @ApiProperty({
    type: 'object',
    additionalProperties: true,
    description:
      'Public store details: name, slug, description, logo_path, currency.',
  })
  store!: Record<string, unknown>;
  @ApiPropertyOptional({
    type: 'object',
    additionalProperties: true,
    description: 'The product or collection itself (public fields only).',
  })
  product?: Record<string, unknown>;
  @ApiPropertyOptional({
    type: 'object',
    additionalProperties: true,
  })
  collection?: Record<string, unknown>;
  @ApiPropertyOptional({
    type: 'array',
    items: { type: 'object', additionalProperties: true },
    description:
      'Images, options, variants, related products or the collection products.',
  })
  images?: Record<string, unknown>[];
  @ApiPropertyOptional({
    type: 'array',
    items: { type: 'object', additionalProperties: true },
  })
  options?: Record<string, unknown>[];
  @ApiPropertyOptional({
    type: 'array',
    items: { type: 'object', additionalProperties: true },
  })
  variants?: Record<string, unknown>[];
  @ApiPropertyOptional({
    type: 'array',
    items: { type: 'object', additionalProperties: true },
  })
  related?: Record<string, unknown>[];
  @ApiPropertyOptional({
    type: 'array',
    items: { type: 'object', additionalProperties: true },
  })
  products?: Record<string, unknown>[];
}

export class PublicPageDto {
  @ApiProperty({
    type: 'object',
    additionalProperties: true,
    description: 'Public store details.',
  })
  store!: Record<string, unknown>;
  @ApiProperty({
    type: 'object',
    additionalProperties: true,
    description: 'The published page: `{ title, slug, body, updated_at }`.',
  })
  page!: Record<string, unknown>;
}

export class PublicPageLinkDto {
  @ApiProperty() title!: string;
  @ApiProperty() slug!: string;
}
