import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

export class PublicBrandingDto {
  @ApiProperty({ example: 'StoreForge' }) platformName!: string;
  @ApiPropertyOptional({ nullable: true }) supportEmail!: string | null;
}

export class StorefrontProductDto {
  @ApiProperty() name!: string;
  @ApiProperty() slug!: string;
  @ApiPropertyOptional({ nullable: true }) shortDescription!: string | null;
  @ApiProperty({ description: 'Minor units of the store currency.' })
  priceMinor!: number;
  @ApiPropertyOptional({ nullable: true }) compareAtPriceMinor!: number | null;
  @ApiPropertyOptional({
    nullable: true,
    description: 'Object path in the public `products` bucket.',
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
      'Template settings chosen by the database function, passed through unchanged. Template customization is outside this API.',
    type: 'object',
    additionalProperties: true,
  })
  template!: Record<string, unknown> | null;
}
