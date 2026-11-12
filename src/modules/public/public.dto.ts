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
}

export class StorefrontDto {
  @ApiProperty() name!: string;
  @ApiProperty() slug!: string;
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
