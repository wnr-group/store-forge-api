import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform, Type } from 'class-transformer';
import { IsBoolean, IsIn, IsInt, IsOptional, Max, Min } from 'class-validator';
import { MAX_LEVELS } from './catalog-hierarchy.rules.js';

/**
 * The public catalog API. One shape for every storefront template: the same fields, the same names, whatever the theme.
 * Money is in minor units of the store currency (like the other public routes) and image paths are storage paths that
 * the template turns into URLs. Only ACTIVE items below ACTIVE parents and ACTIVE products ever appear.
 */

export class PublicCatalogStoreDto {
  @ApiProperty() name!: string;
  @ApiProperty() slug!: string;
  @ApiProperty({ example: 'INR' }) currency!: string;
  @ApiPropertyOptional({ nullable: true }) description?: string | null;
  @ApiPropertyOptional({ nullable: true }) logoPath?: string | null;
}

export class PublicCatalogHierarchyDto {
  @ApiProperty({ format: 'uuid' }) id!: string;
  @ApiProperty() name!: string;
}

export class PublicCatalogLevelDto {
  @ApiProperty({ format: 'uuid' }) id!: string;
  @ApiProperty({ example: 'Brand' }) name!: string;
  @ApiProperty({ description: '1 = the top level.' }) position!: number;
  @ApiProperty({
    description: 'Whether items of this level can show products.',
  })
  canHoldProducts!: boolean;
}

export class PublicCatalogNodeDto {
  @ApiProperty({ format: 'uuid' }) id!: string;
  @ApiPropertyOptional({ format: 'uuid', nullable: true }) parentId!:
    string | null;
  @ApiProperty({ format: 'uuid' }) levelId!: string;
  @ApiProperty() name!: string;
  @ApiProperty() slug!: string;
  @ApiProperty({
    example: 'toyota/camry',
    description:
      'The slugs from the top level down to this item, joined by "/". Use it in the address of the item page and in GET .../catalog/nodes/{path}.',
  })
  path!: string;
  @ApiPropertyOptional({ nullable: true }) description!: string | null;
  @ApiProperty({ description: 'The order among its siblings.' })
  position!: number;
  @ApiProperty({ description: '1 for a top-level item.' }) depth!: number;
  @ApiPropertyOptional({ nullable: true }) seoTitle?: string | null;
  @ApiPropertyOptional({ nullable: true }) seoDescription?: string | null;
  @ApiPropertyOptional({
    nullable: true,
    description:
      'Where the item image is stored in the public `products` bucket (a storage path, not a web address); null when the item has no image.',
  })
  imagePath!: string | null;
  @ApiPropertyOptional({
    nullable: true,
    description:
      'A short description of the image; use the item name when it is empty.',
  })
  imageAlt!: string | null;
  @ApiProperty({
    description:
      'Whether the item has active children (also when they were left out by `maxDepth`).',
  })
  hasChildren!: boolean;
  @ApiProperty({
    description: 'Active products placed directly on this item.',
  })
  productCount!: number;
}

export class PublicCatalogTreeDto {
  @ApiProperty({ type: PublicCatalogStoreDto }) store!: PublicCatalogStoreDto;
  @ApiPropertyOptional({
    type: PublicCatalogHierarchyDto,
    nullable: true,
    description: 'null when the store has no published catalog.',
  })
  hierarchy!: PublicCatalogHierarchyDto | null;
  @ApiProperty({ type: [PublicCatalogLevelDto] })
  levels!: PublicCatalogLevelDto[];
  @ApiProperty({
    type: [PublicCatalogNodeDto],
    description:
      'A flat list, top level first, in display order. Build the tree from `parentId`.',
  })
  nodes!: PublicCatalogNodeDto[];
  @ApiProperty({
    description: 'True when the list was cut at 5000 items.',
  })
  truncated!: boolean;
}

export class PublicCatalogBreadcrumbDto {
  @ApiProperty({ format: 'uuid' }) id!: string;
  @ApiProperty() name!: string;
  @ApiProperty() slug!: string;
  @ApiProperty({ description: 'The slugs down to this crumb, joined by "/".' })
  path!: string;
  @ApiProperty() depth!: number;
  @ApiProperty({ format: 'uuid' }) levelId!: string;
  @ApiProperty({ example: 'Brand' }) levelName!: string;
}

export class PublicCatalogProductDto {
  @ApiProperty() name!: string;
  @ApiProperty({ description: 'Use it in GET .../products/{slug}.' })
  slug!: string;
  @ApiPropertyOptional({ nullable: true }) partNumber!: string | null;
  @ApiPropertyOptional({ nullable: true }) shortDescription!: string | null;
  @ApiProperty({ description: 'In the smallest unit of the store currency.' })
  priceMinor!: number;
  @ApiPropertyOptional({ nullable: true }) compareAtPriceMinor!: number | null;
  @ApiPropertyOptional({ nullable: true }) imagePath!: string | null;
  @ApiProperty() available!: boolean;
}

export class PublicCatalogProductPageDto {
  @ApiProperty({ type: [PublicCatalogProductDto] })
  items!: PublicCatalogProductDto[];
  @ApiProperty() page!: number;
  @ApiProperty() limit!: number;
  @ApiProperty({ description: 'All matching products, over all pages.' })
  total!: number;
  @ApiProperty() includeDescendants!: boolean;
}

export class PublicCatalogNodeDetailDto extends PublicCatalogNodeDto {
  @ApiProperty({ type: PublicCatalogLevelDto }) level!: PublicCatalogLevelDto;
}

export class PublicCatalogNodePageDto {
  @ApiProperty({ type: PublicCatalogStoreDto }) store!: PublicCatalogStoreDto;
  @ApiProperty({ type: PublicCatalogHierarchyDto })
  hierarchy!: PublicCatalogHierarchyDto;
  @ApiProperty({ type: PublicCatalogNodeDetailDto })
  node!: PublicCatalogNodeDetailDto;
  @ApiProperty({
    type: [PublicCatalogBreadcrumbDto],
    description: 'From the top level down to (and including) the item.',
  })
  breadcrumbs!: PublicCatalogBreadcrumbDto[];
  @ApiProperty({
    type: [PublicCatalogNodeDto],
    description: 'The active children (up to 500), in display order.',
  })
  children!: PublicCatalogNodeDto[];
  @ApiProperty({ type: PublicCatalogProductPageDto })
  products!: PublicCatalogProductPageDto;
}

export const PUBLIC_PRODUCT_SORTS = [
  'position',
  'newest',
  'name',
  'price_asc',
  'price_desc',
] as const;

export class PublicCatalogTreeQueryDto {
  @ApiPropertyOptional({
    minimum: 1,
    maximum: MAX_LEVELS,
    description:
      'How many levels deep to return. Leave it out for everything (up to 5000 items).',
  })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(MAX_LEVELS)
  maxDepth?: number;
}

export class PublicCatalogNodeQueryDto {
  @ApiPropertyOptional({ default: 1, minimum: 1, maximum: 100000 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100_000)
  page: number = 1;

  @ApiPropertyOptional({ default: 24, minimum: 1, maximum: 100 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  limit: number = 24;

  @ApiPropertyOptional({
    default: false,
    description:
      'Also list the products of every active item below this one (each product once).',
  })
  @IsOptional()
  @Transform(({ value }) =>
    value === 'true' ? true : value === 'false' ? false : value,
  )
  @IsBoolean()
  includeDescendants: boolean = false;

  @ApiPropertyOptional({ enum: PUBLIC_PRODUCT_SORTS, default: 'position' })
  @IsOptional()
  @IsIn(PUBLIC_PRODUCT_SORTS)
  sort: (typeof PUBLIC_PRODUCT_SORTS)[number] = 'position';
}
