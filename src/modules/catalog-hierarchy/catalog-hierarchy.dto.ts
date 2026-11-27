import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform, Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  ArrayUnique,
  IsArray,
  IsBoolean,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  IsUUID,
  Matches,
  Max,
  MaxLength,
  Min,
  MinLength,
} from 'class-validator';
import { PaginationQueryDto } from '../../common/dto/pagination-query.dto.js';
import {
  OptionalText,
  RequiredText,
  WhenPresent,
} from '../../common/validation/fields.js';
import { CATALOG_STATUSES } from '../../database/schema/enums.js';
import {
  MAX_ASSIGNMENT_PAIRS,
  MAX_LEVELS,
  MAX_NODES_PER_REQUEST,
  MAX_PRODUCTS_PER_REQUEST,
  SLUG_PATTERN,
} from './catalog-hierarchy.rules.js';

// ---------------------------------------------------------------------------------------------------------------------
// Responses
// ---------------------------------------------------------------------------------------------------------------------

export class CatalogLevelDto {
  @ApiProperty({ format: 'uuid' }) id!: string;
  @ApiProperty({ example: 'Brand' }) name!: string;
  @ApiProperty({
    description: 'The place of the level, 1 = the top level.',
    minimum: 1,
  })
  position!: number;
  @ApiProperty({
    description: 'Whether items on this level may carry products.',
  })
  canHoldProducts!: boolean;
  @ApiProperty({ description: 'How many items are on this level.' })
  nodeCount!: number;
  @ApiProperty() createdAt!: Date;
  @ApiProperty() updatedAt!: Date;
}

export class CatalogHierarchyDto {
  @ApiProperty({ format: 'uuid' }) id!: string;
  @ApiProperty({ example: 'Parts catalog' }) name!: string;
  @ApiProperty({
    enum: CATALOG_STATUSES,
    description: 'Shoppers see the catalog only while it is active.',
  })
  status!: string;
  @ApiProperty({ type: [CatalogLevelDto] }) levels!: CatalogLevelDto[];
  @ApiProperty({ description: 'How many items the whole catalog has.' })
  nodeCount!: number;
  @ApiProperty() createdAt!: Date;
  @ApiProperty() updatedAt!: Date;
}

export class CatalogNodeDto {
  @ApiProperty({ format: 'uuid' }) id!: string;
  @ApiProperty({ format: 'uuid' }) levelId!: string;
  @ApiProperty({ example: 'Brand' }) levelName!: string;
  @ApiProperty({ example: 1 }) levelPosition!: number;
  @ApiPropertyOptional({ format: 'uuid', nullable: true }) parentId!:
    string | null;
  @ApiProperty() name!: string;
  @ApiProperty({
    description: 'The address segment, unique among the items of one parent.',
  })
  slug!: string;
  @ApiPropertyOptional({ nullable: true }) description!: string | null;
  @ApiProperty({ description: 'The order among the items of one parent.' })
  position!: number;
  @ApiProperty({ enum: CATALOG_STATUSES }) status!: string;
  @ApiPropertyOptional({ nullable: true }) seoTitle!: string | null;
  @ApiPropertyOptional({ nullable: true }) seoDescription!: string | null;
  @ApiProperty({ description: '1 for a top-level item.' }) depth!: number;
  @ApiProperty({
    type: [String],
    format: 'uuid',
    description: 'The ids from the top level down to this item (inclusive).',
  })
  pathIds!: string[];
  @ApiProperty({ description: 'How many items are directly below this one.' })
  childCount!: number;
  @ApiProperty({
    description: 'How many products are directly placed on this item.',
  })
  productCount!: number;
  @ApiProperty() createdAt!: Date;
  @ApiProperty() updatedAt!: Date;
}

export class CatalogBreadcrumbDto {
  @ApiProperty({ format: 'uuid' }) id!: string;
  @ApiProperty() name!: string;
  @ApiProperty() slug!: string;
  @ApiProperty({ description: 'The slugs from the top down, joined by "/".' })
  path!: string;
  @ApiProperty() levelName!: string;
}

export class CatalogNodeDetailDto extends CatalogNodeDto {
  @ApiProperty({
    type: [CatalogBreadcrumbDto],
    description: 'From the top level down to (and including) this item.',
  })
  breadcrumbs!: CatalogBreadcrumbDto[];
  @ApiProperty({ description: 'The slugs from the top down, joined by "/".' })
  path!: string;
  @ApiProperty({
    description: 'Whether products may be placed on this item (its level).',
  })
  canHoldProducts!: boolean;
}

export class CatalogTreeNodeDto extends CatalogNodeDto {
  @ApiProperty({ type: () => [CatalogTreeNodeDto] })
  children!: CatalogTreeNodeDto[];
}

export class CatalogTreeDto {
  @ApiProperty({ type: [CatalogTreeNodeDto] }) nodes!: CatalogTreeNodeDto[];
  @ApiProperty({
    description: 'True when the tree was cut because it is very large.',
  })
  truncated!: boolean;
}

export class CatalogDeletedDto {
  @ApiProperty({ description: 'How many items were deleted (with children).' })
  deleted!: number;
}

export class CatalogNodeProductDto {
  @ApiProperty({ format: 'uuid' }) id!: string;
  @ApiProperty() name!: string;
  @ApiProperty() slug!: string;
  @ApiPropertyOptional({ nullable: true }) sku!: string | null;
  @ApiPropertyOptional({ nullable: true }) partNumber!: string | null;
  @ApiProperty({ enum: ['draft', 'active'] }) status!: string;
  @ApiProperty() priceMinor!: number;
  @ApiPropertyOptional({ nullable: true }) imagePath!: string | null;
  @ApiProperty({ description: 'The order of the product on the item.' })
  position!: number;
}

export class CatalogAssignResultDto {
  @ApiProperty({ description: 'New placements made.' }) assigned!: number;
  @ApiProperty({ description: 'Placements that already existed.' })
  alreadyAssigned!: number;
}

export class CatalogUnassignResultDto {
  @ApiProperty({ description: 'Placements removed.' }) removed!: number;
}

export class CatalogProductPlacementDto {
  @ApiProperty({ format: 'uuid' }) nodeId!: string;
  @ApiProperty() name!: string;
  @ApiProperty() levelName!: string;
  @ApiProperty({ description: 'The slugs from the top down, joined by "/".' })
  path!: string;
  @ApiProperty({
    type: [String],
    description: 'The names of the items from the top level down to this one.',
  })
  names!: string[];
  @ApiProperty({ enum: CATALOG_STATUSES }) status!: string;
  @ApiProperty() position!: number;
}

// ---------------------------------------------------------------------------------------------------------------------
// Requests
// ---------------------------------------------------------------------------------------------------------------------

/** A node address segment. Unlike product slugs, one character is fine ("5", "x"). */
function NodeSlug() {
  return (target: object, key: string | symbol) => {
    Transform(({ value }) =>
      typeof value === 'string' ? value.trim().toLowerCase() : value,
    )(target, key);
    IsOptional()(target, key);
    IsString({ message: 'Slug must be text.' })(target, key);
    MinLength(1, { message: 'Slug is required.' })(target, key);
    MaxLength(80, { message: 'Slug must be at most 80 characters.' })(
      target,
      key,
    );
    Matches(SLUG_PATTERN, {
      message: 'Use lowercase letters, numbers and single hyphens.',
    })(target, key);
  };
}

const uuidList = (max: number, label: string) => (t: object, k: string) => {
  IsArray()(t, k);
  ArrayMinSize(1, { message: `Choose at least one ${label}.` })(t, k);
  ArrayMaxSize(max, { message: `At most ${max} ${label}s at once.` })(t, k);
  ArrayUnique()(t, k);
  IsUUID('all', { each: true })(t, k);
};

export class CreateCatalogHierarchyDto {
  @ApiProperty({ maxLength: 80, example: 'Parts catalog' })
  @RequiredText('Catalog name', 80)
  name!: string;

  @ApiPropertyOptional({ enum: CATALOG_STATUSES, default: 'draft' })
  @IsOptional()
  @IsIn(CATALOG_STATUSES, { message: 'Please select a valid status.' })
  status?: (typeof CATALOG_STATUSES)[number];
}

export class UpdateCatalogHierarchyDto {
  @ApiPropertyOptional({ maxLength: 80 })
  @WhenPresent()
  @RequiredText('Catalog name', 80)
  name?: string;

  @ApiPropertyOptional({ enum: CATALOG_STATUSES })
  @IsOptional()
  @IsIn(CATALOG_STATUSES, { message: 'Please select a valid status.' })
  status?: (typeof CATALOG_STATUSES)[number];
}

export class CreateCatalogLevelDto {
  @ApiProperty({ maxLength: 60, example: 'Vehicle' })
  @RequiredText('Level name', 60)
  name!: string;

  @ApiPropertyOptional({
    default: false,
    description: 'Whether items on this level may carry products.',
  })
  @IsOptional()
  @IsBoolean()
  canHoldProducts?: boolean;

  @ApiPropertyOptional({
    minimum: 1,
    maximum: MAX_LEVELS,
    description:
      'Where to put the new level (1 = top). Leave it out to add it at the end. Inserting before levels that already have items is refused when it would break their relations.',
  })
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(MAX_LEVELS)
  position?: number;
}

export class UpdateCatalogLevelDto {
  @ApiPropertyOptional({ maxLength: 60 })
  @WhenPresent()
  @RequiredText('Level name', 60)
  name?: string;

  @ApiPropertyOptional({
    description:
      'Cannot be switched off while products are placed on items of this level.',
  })
  @IsOptional()
  @IsBoolean()
  canHoldProducts?: boolean;
}

export class ReorderCatalogLevelsDto {
  @ApiProperty({
    type: [String],
    format: 'uuid',
    description:
      'EVERY level id, in the new order (first = top level). The order is accepted only if all existing parent/child relations stay valid.',
  })
  @uuidList(MAX_LEVELS, 'level')
  levelIds!: string[];
}

export class CreateCatalogNodeDto {
  @ApiProperty({ maxLength: 120, example: 'Toyota' })
  @RequiredText('Name', 120)
  name!: string;

  @ApiPropertyOptional({
    description:
      'The address segment. Leave it out to make one from the name (made unique among its siblings).',
  })
  @NodeSlug()
  slug?: string;

  @ApiPropertyOptional({
    format: 'uuid',
    nullable: true,
    description:
      'The parent item. Leave it out (or send null) for a top-level item. The item goes on the level right after its parent.',
  })
  @IsOptional()
  @IsUUID()
  parentId?: string | null;

  @ApiPropertyOptional({ nullable: true, maxLength: 2000 })
  @OptionalText('Description', 2000)
  description?: string | null;

  @ApiPropertyOptional({ enum: CATALOG_STATUSES, default: 'draft' })
  @IsOptional()
  @IsIn(CATALOG_STATUSES, { message: 'Please select a valid status.' })
  status?: (typeof CATALOG_STATUSES)[number];

  @ApiPropertyOptional({
    minimum: 0,
    description: 'Leave it out to add the item after its siblings.',
  })
  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(1_000_000)
  position?: number;

  @ApiPropertyOptional({ nullable: true, maxLength: 70 })
  @OptionalText('SEO title', 70)
  seoTitle?: string | null;

  @ApiPropertyOptional({ nullable: true, maxLength: 160 })
  @OptionalText('SEO description', 160)
  seoDescription?: string | null;
}

export class UpdateCatalogNodeDto {
  @ApiPropertyOptional({ maxLength: 120 })
  @WhenPresent()
  @RequiredText('Name', 120)
  name?: string;

  @ApiPropertyOptional()
  @NodeSlug()
  slug?: string;

  @ApiPropertyOptional({ nullable: true, maxLength: 2000 })
  @OptionalText('Description', 2000)
  description?: string | null;

  @ApiPropertyOptional({ enum: CATALOG_STATUSES })
  @IsOptional()
  @IsIn(CATALOG_STATUSES, { message: 'Please select a valid status.' })
  status?: (typeof CATALOG_STATUSES)[number];

  @ApiPropertyOptional({ minimum: 0 })
  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(1_000_000)
  position?: number;

  @ApiPropertyOptional({ nullable: true, maxLength: 70 })
  @OptionalText('SEO title', 70)
  seoTitle?: string | null;

  @ApiPropertyOptional({ nullable: true, maxLength: 160 })
  @OptionalText('SEO description', 160)
  seoDescription?: string | null;
}

export class MoveCatalogNodeDto {
  @ApiProperty({
    format: 'uuid',
    nullable: true,
    description:
      'The new parent, or null to make it a top-level item. It must be on the level just above this item, and not be this item or one of its descendants. The whole subtree moves with it.',
  })
  @IsOptional()
  @IsUUID()
  parentId!: string | null;

  @ApiPropertyOptional({
    minimum: 0,
    description: 'Leave it out to put the item last among its new siblings.',
  })
  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(1_000_000)
  position?: number;
}

export class ReorderCatalogNodesDto {
  @ApiPropertyOptional({
    format: 'uuid',
    nullable: true,
    description:
      'The parent whose children are reordered; null for the top level.',
  })
  @IsOptional()
  @IsUUID()
  parentId?: string | null;

  @ApiProperty({
    type: [String],
    format: 'uuid',
    description: 'EVERY child of that parent, in the new order.',
  })
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(5000)
  @ArrayUnique()
  @IsUUID('all', { each: true })
  nodeIds!: string[];
}

export class DeleteCatalogNodeQueryDto {
  @ApiPropertyOptional({
    description:
      'Send true to delete the item together with everything below it. Without it, an item that has children is not deleted. Products are never deleted, only their placement.',
  })
  @IsOptional()
  @Transform(({ value }) =>
    value === 'true' ? true : value === 'false' ? false : value,
  )
  @IsBoolean()
  cascade?: boolean;
}

export class CatalogNodeListQueryDto extends PaginationQueryDto {
  @ApiPropertyOptional({
    description:
      'Only the children of this item. Use `root` for the top level. Leave it out for all items.',
  })
  @IsOptional()
  @Matches(/^(root|[0-9a-fA-F-]{36})$/, {
    message: 'Use root or the id of an item.',
  })
  parentId?: string;

  @ApiPropertyOptional({ format: 'uuid' })
  @IsOptional()
  @IsUUID()
  levelId?: string;

  @ApiPropertyOptional({ enum: [...CATALOG_STATUSES, 'all'], default: 'all' })
  @IsOptional()
  @IsIn([...CATALOG_STATUSES, 'all'])
  status: (typeof CATALOG_STATUSES)[number] | 'all' = 'all';

  @ApiPropertyOptional({
    enum: ['position', 'name', 'createdAt'],
    default: 'position',
  })
  @IsOptional()
  @IsIn(['position', 'name', 'createdAt'])
  sortBy: 'position' | 'name' | 'createdAt' = 'position';

  @ApiPropertyOptional({ enum: ['asc', 'desc'], default: 'asc' })
  @IsOptional()
  @IsIn(['asc', 'desc'])
  sortOrder: 'asc' | 'desc' = 'asc';
}

export class CatalogTreeQueryDto {
  @ApiPropertyOptional({
    format: 'uuid',
    description:
      'Only the subtree below this item (the item itself is the root).',
  })
  @IsOptional()
  @IsUUID()
  parentId?: string;

  @ApiPropertyOptional({
    minimum: 1,
    maximum: MAX_LEVELS,
    description: 'How many levels deep to go. Leave it out for everything.',
  })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(MAX_LEVELS)
  maxDepth?: number;
}

export class NodeProductsQueryDto extends PaginationQueryDto {
  @ApiPropertyOptional({
    default: false,
    description: 'Also list the products of every item below this one.',
  })
  @IsOptional()
  @Transform(({ value }) =>
    value === 'true' ? true : value === 'false' ? false : value,
  )
  @IsBoolean()
  includeDescendants?: boolean;

  @ApiPropertyOptional({ enum: ['position', 'name', 'createdAt'] })
  @IsOptional()
  @IsIn(['position', 'name', 'createdAt'])
  sortBy: 'position' | 'name' | 'createdAt' = 'position';

  @ApiPropertyOptional({ enum: ['asc', 'desc'], default: 'asc' })
  @IsOptional()
  @IsIn(['asc', 'desc'])
  sortOrder: 'asc' | 'desc' = 'asc';
}

export class AssignProductsDto {
  @ApiProperty({
    type: [String],
    format: 'uuid',
    maxItems: MAX_PRODUCTS_PER_REQUEST,
    description:
      'The products to place. They are added after the products already on the item, in this order. A product that is already there is left alone.',
  })
  @uuidList(MAX_PRODUCTS_PER_REQUEST, 'product')
  productIds!: string[];
}

export class UnassignProductsDto extends AssignProductsDto {}

export class ReorderNodeProductsDto {
  @ApiProperty({
    type: [String],
    format: 'uuid',
    description: 'EVERY product on the item, in the new order.',
  })
  @uuidList(5000, 'product')
  productIds!: string[];
}

export class BulkAssignmentDto {
  @ApiProperty({ enum: ['assign', 'unassign'] })
  @IsIn(['assign', 'unassign'])
  action!: 'assign' | 'unassign';

  @ApiProperty({
    type: [String],
    format: 'uuid',
    maxItems: MAX_NODES_PER_REQUEST,
  })
  @uuidList(MAX_NODES_PER_REQUEST, 'item')
  nodeIds!: string[];

  @ApiProperty({
    type: [String],
    format: 'uuid',
    maxItems: MAX_PRODUCTS_PER_REQUEST,
    description: `Items times products may not be more than ${MAX_ASSIGNMENT_PAIRS}.`,
  })
  @uuidList(MAX_PRODUCTS_PER_REQUEST, 'product')
  productIds!: string[];
}

export class SetProductNodesDto {
  @ApiProperty({
    type: [String],
    format: 'uuid',
    description:
      'EVERY item this product should be on. Placements not in the list are removed, new ones are added.',
  })
  @IsArray()
  @ArrayMaxSize(200)
  @ArrayUnique()
  @IsUUID('all', { each: true })
  nodeIds!: string[];
}
