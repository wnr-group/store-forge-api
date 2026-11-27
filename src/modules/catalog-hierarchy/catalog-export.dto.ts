import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsInt, IsOptional, Max, Min } from 'class-validator';

export const EXPORT_MAX_PAGE_SIZE = 1000;

export class CatalogExportQueryDto {
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
    maximum: EXPORT_MAX_PAGE_SIZE,
  })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(EXPORT_MAX_PAGE_SIZE)
  limit: number = 500;
}

export class CatalogExportHierarchyDto {
  @ApiProperty({ format: 'uuid' }) id!: string;
  @ApiProperty() name!: string;
  @ApiProperty({ enum: ['draft', 'active'] }) status!: string;
}

export class CatalogExportLevelDto {
  @ApiProperty({ example: 'Brand' }) name!: string;
  @ApiProperty({
    example: 'false',
    description: 'true or false, ready to be written into the levels sheet.',
  })
  can_hold_products!: string;
}

export class CatalogExportDto {
  @ApiProperty({ type: CatalogExportHierarchyDto })
  hierarchy!: CatalogExportHierarchyDto;
  @ApiProperty({
    type: [CatalogExportLevelDto],
    description:
      'The levels, top level first: the "levels" sheet of the file (and the `levels` of an import request).',
  })
  levels!: CatalogExportLevelDto[];
  @ApiProperty({
    type: [String],
    description: 'The column headers of the rows, in order.',
  })
  columns!: string[];
  @ApiProperty({
    type: 'array',
    items: { type: 'object', additionalProperties: { type: 'string' } },
    description:
      'One row per item and placed product (or one row for an item without products), parents before children. Every value is text; put each column header and value into the sheet as they are.',
  })
  rows!: Record<string, string>[];
  @ApiProperty() page!: number;
  @ApiProperty() limit!: number;
  @ApiProperty({ description: 'The number of rows over all pages.' })
  total!: number;
  @ApiProperty() totalPages!: number;
}
