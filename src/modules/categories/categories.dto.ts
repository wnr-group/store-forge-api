import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsOptional, IsUUID } from 'class-validator';
import {
  CatalogSlug,
  OptionalText,
  RequiredText,
  WhenPresent,
} from '../../common/validation/fields.js';

export class CategoryDto {
  @ApiProperty({ format: 'uuid' }) id!: string;
  @ApiProperty() name!: string;
  @ApiProperty({ example: 'summer-wear' }) slug!: string;
  @ApiPropertyOptional({ nullable: true }) description!: string | null;
  @ApiPropertyOptional({ format: 'uuid', nullable: true }) parentId!:
    string | null;
  @ApiPropertyOptional({ nullable: true }) parentName!: string | null;
  @ApiProperty({
    description: 'The number of products in this category right now.',
  })
  productCount!: number;
  @ApiProperty() createdAt!: Date;
  @ApiProperty() updatedAt!: Date;
}

export class CreateCategoryDto {
  @ApiProperty({ maxLength: 80 })
  @RequiredText('Category name', 80)
  name!: string;

  @ApiPropertyOptional({
    description:
      'The short name used in web addresses, 2 to 80 characters long. If you leave it out, it is made from the category name.',
  })
  @CatalogSlug()
  slug?: string;

  @ApiPropertyOptional({ nullable: true, maxLength: 1000 })
  @OptionalText('Description', 1000)
  description?: string | null;

  @ApiPropertyOptional({
    format: 'uuid',
    nullable: true,
    description:
      'The category this one sits inside. It must be in the same organization.',
  })
  @IsOptional()
  @IsUUID('all', { message: 'Please select a valid parent category.' })
  parentId?: string | null;
}

/** Partial update: omitted fields are unchanged. */
export class UpdateCategoryDto {
  @ApiPropertyOptional({ maxLength: 80 })
  @WhenPresent()
  @RequiredText('Category name', 80)
  name?: string;

  @ApiPropertyOptional()
  @CatalogSlug()
  slug?: string;

  @ApiPropertyOptional({ nullable: true, maxLength: 1000 })
  @OptionalText('Description', 1000)
  description?: string | null;

  @ApiPropertyOptional({ format: 'uuid', nullable: true })
  @IsOptional()
  @IsUUID('all', { message: 'Please select a valid parent category.' })
  parentId?: string | null;
}
