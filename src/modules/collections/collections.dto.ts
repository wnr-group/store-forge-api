import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  ArrayMaxSize,
  IsArray,
  IsIn,
  IsOptional,
  IsString,
  IsUUID,
  Matches,
  MaxLength,
} from 'class-validator';
import {
  CatalogSlug,
  OptionalText,
  RequiredText,
  WhenPresent,
} from '../../common/validation/fields.js';
import { COLLECTION_STATUSES } from '../../database/schema/enums.js';

export class CollectionDto {
  @ApiProperty({ format: 'uuid' }) id!: string;
  @ApiProperty() name!: string;
  @ApiProperty() slug!: string;
  @ApiPropertyOptional({ nullable: true }) description!: string | null;
  @ApiProperty({ enum: COLLECTION_STATUSES }) status!: string;
  @ApiPropertyOptional({
    nullable: true,
    description:
      'Where the image file is stored in the `products` storage bucket (`{tenantId}/collections/{id}/...`). This is a storage path, not a web address.',
  })
  imagePath!: string | null;
  @ApiProperty() productCount!: number;
  @ApiProperty() createdAt!: Date;
  @ApiProperty() updatedAt!: Date;
}

export class CollectionDetailDto extends CollectionDto {
  @ApiProperty({
    type: [String],
    format: 'uuid',
    description:
      'The ids of the products in this collection, in the order they are shown.',
  })
  productIds!: string[];
}

export class ProductOptionChoiceDto {
  @ApiProperty({ format: 'uuid' }) id!: string;
  @ApiProperty() name!: string;
}

export class CreateCollectionDto {
  @ApiPropertyOptional({
    format: 'uuid',
    description:
      'An id you create yourself, so you can upload the image into `{tenantId}/collections/{id}/` before the collection exists. If you leave it out, the server makes one.',
  })
  @IsOptional()
  @IsUUID()
  id?: string;

  @ApiProperty({ maxLength: 80 })
  @RequiredText('Collection name', 80)
  name!: string;

  @ApiPropertyOptional()
  @CatalogSlug()
  slug?: string;

  @ApiPropertyOptional({ nullable: true, maxLength: 1000 })
  @OptionalText('Description', 1000)
  description?: string | null;

  @ApiPropertyOptional({ enum: COLLECTION_STATUSES, default: 'draft' })
  @IsOptional()
  @IsIn(COLLECTION_STATUSES, { message: 'Please select a valid status.' })
  status?: (typeof COLLECTION_STATUSES)[number];

  @ApiPropertyOptional({ nullable: true })
  @IsOptional()
  @IsString()
  @MaxLength(300)
  imagePath?: string | null;

  @ApiPropertyOptional({ type: [String], format: 'uuid', maxItems: 500 })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(500, { message: 'At most 500 products per collection.' })
  @IsUUID('all', { each: true })
  productIds?: string[];
}

/** Partial update. `productIds`, when sent, replaces the whole product list. */
export class UpdateCollectionDto {
  @ApiPropertyOptional({ maxLength: 80 })
  @WhenPresent()
  @RequiredText('Collection name', 80)
  name?: string;

  @ApiPropertyOptional()
  @CatalogSlug()
  slug?: string;

  @ApiPropertyOptional({ nullable: true, maxLength: 1000 })
  @OptionalText('Description', 1000)
  description?: string | null;

  @ApiPropertyOptional({ enum: COLLECTION_STATUSES })
  @IsOptional()
  @IsIn(COLLECTION_STATUSES, { message: 'Please select a valid status.' })
  status?: (typeof COLLECTION_STATUSES)[number];

  @ApiPropertyOptional({ nullable: true })
  @IsOptional()
  @IsString()
  @MaxLength(300)
  imagePath?: string | null;

  @ApiPropertyOptional({ type: [String], format: 'uuid', maxItems: 500 })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(500, { message: 'At most 500 products per collection.' })
  @IsUUID('all', { each: true })
  productIds?: string[];
}

export class CollectionUsageRefDto {
  @ApiProperty({ format: 'uuid' }) templateId!: string;
  @ApiProperty() templateName!: string;
  @ApiProperty() kind!: string;
  @ApiProperty({
    description: 'The page kind, or the generated page ("cart page").',
  })
  location!: string;
  @ApiProperty() sectionId!: string;
  @ApiProperty() inDraft!: boolean;
  @ApiProperty({
    description: 'True when the live (published) design also uses it.',
  })
  inPublished!: boolean;
}

export class CollectionUsageDto {
  @ApiProperty({ description: 'Number of sections that use this collection.' })
  total!: number;
  @ApiProperty({
    description:
      'Send this back as `usage` when deleting to confirm you saw the current list.',
  })
  hash!: string;
  @ApiProperty({ type: [CollectionUsageRefDto] })
  references!: CollectionUsageRefDto[];
}

export class DeleteCollectionQueryDto {
  @ApiPropertyOptional({
    description:
      'The `hash` from the usage check you confirmed. Required when the collection is used.',
  })
  @IsOptional()
  @Matches(/^[a-f0-9]{64}$/)
  usage?: string;
}
