import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsIn, IsInt, IsOptional, Max, Min } from 'class-validator';
import { PRODUCT_STATUSES } from '../../database/schema/enums.js';

export const PRODUCT_EXPORT_MAX_PAGE_SIZE = 1000;

export class ProductExportQueryDto {
  @ApiPropertyOptional({ default: 1, minimum: 1 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100_000)
  page: number = 1;

  @ApiPropertyOptional({
    default: 500,
    minimum: 1,
    maximum: PRODUCT_EXPORT_MAX_PAGE_SIZE,
  })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(PRODUCT_EXPORT_MAX_PAGE_SIZE)
  limit: number = 500;

  @ApiPropertyOptional({ enum: ['all', ...PRODUCT_STATUSES], default: 'all' })
  @IsOptional()
  @IsIn(['all', ...PRODUCT_STATUSES])
  status: 'all' | (typeof PRODUCT_STATUSES)[number] = 'all';
}

export class ProductExportDto {
  @ApiProperty({
    type: [String],
    description:
      'The column headers, in order. They are the columns of the product import, plus `id` and `has_variants`, which the import ignores.',
  })
  columns!: string[];
  @ApiProperty({
    type: 'array',
    items: { type: 'object', additionalProperties: { type: 'string' } },
    description:
      'One row per product, oldest first. Every value is text. Prices are plain decimals in the store currency. Products with variants are listed too (has_variants = true): the product import only creates simple products, so leave those rows out when you import again.',
  })
  rows!: Record<string, string>[];
  @ApiProperty() page!: number;
  @ApiProperty() limit!: number;
  @ApiProperty({ description: 'The number of products over all pages.' })
  total!: number;
  @ApiProperty() totalPages!: number;
}
