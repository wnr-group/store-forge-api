import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsBoolean,
  IsInt,
  IsOptional,
  IsString,
  MaxLength,
  Min,
  ValidateNested,
} from 'class-validator';
import { MAX_LEVELS } from './catalog-hierarchy.rules.js';

/** Rows per request. Larger files are sent in several requests: the import is idempotent, so that is safe. */
export const CATALOG_IMPORT_MAX_ROWS = 2000;

/** A text cell: optional, at most max characters. Everything arrives as text, as read from a CSV or Excel file. */
const cell = (max: number) => (target: object, key: string) => {
  IsOptional()(target, key);
  IsString()(target, key);
  MaxLength(max)(target, key);
};

export class CatalogImportSourceErrorDto {
  @ApiProperty() @IsString() @MaxLength(40) column!: string;
  @ApiProperty() @IsString() @MaxLength(200) message!: string;
}

export class CatalogImportLevelDto {
  @ApiProperty({
    description: 'The row of the levels sheet (the header is row 1).',
  })
  @IsInt()
  @Min(2)
  row!: number;

  @ApiPropertyOptional({
    description:
      'The name of the level. The first level in the list is the top level.',
  })
  @cell(100)
  name?: string;

  @ApiPropertyOptional({
    description:
      'true / false (also yes, no, 1, 0): may items of this level carry products? Leave it empty to keep the current setting (new levels start with false).',
  })
  @cell(20)
  can_hold_products?: string;
}

export class CatalogImportRowDto {
  @ApiProperty({
    description:
      'The spreadsheet row number (the header is row 1). It is only used to point at problems.',
  })
  @IsInt()
  @Min(2)
  row!: number;

  @ApiPropertyOptional({
    description:
      'The name of the top-level item. level_2 is the item below it, and so on; fill the cells from level_1 downward without gaps. The row describes the item of the LAST filled level.',
  })
  @cell(120)
  level_1?: string;

  @ApiPropertyOptional({ description: 'Name of the item on level 2.' })
  @cell(120)
  level_2?: string;

  @ApiPropertyOptional({ description: 'Name of the item on level 3.' })
  @cell(120)
  level_3?: string;

  @ApiPropertyOptional({ description: 'Name of the item on level 4.' })
  @cell(120)
  level_4?: string;

  @ApiPropertyOptional({ description: 'Name of the item on level 5.' })
  @cell(120)
  level_5?: string;

  @ApiPropertyOptional({ description: 'Name of the item on level 6.' })
  @cell(120)
  level_6?: string;

  @ApiPropertyOptional({ description: 'Name of the item on level 7.' })
  @cell(120)
  level_7?: string;

  @ApiPropertyOptional({ description: 'Name of the item on level 8.' })
  @cell(120)
  level_8?: string;

  @ApiPropertyOptional({ description: 'Name of the item on level 9.' })
  @cell(120)
  level_9?: string;

  @ApiPropertyOptional({ description: 'Name of the item on level 10.' })
  @cell(120)
  level_10?: string;

  @ApiPropertyOptional({ description: 'Name of the item on level 11.' })
  @cell(120)
  level_11?: string;

  @ApiPropertyOptional({ description: 'Name of the item on level 12.' })
  @cell(120)
  level_12?: string;

  @ApiPropertyOptional({ description: 'Name of the item on level 13.' })
  @cell(120)
  level_13?: string;

  @ApiPropertyOptional({ description: 'Name of the item on level 14.' })
  @cell(120)
  level_14?: string;

  @ApiPropertyOptional({ description: 'Name of the item on level 15.' })
  @cell(120)
  level_15?: string;

  @ApiPropertyOptional({ description: 'Name of the item on level 16.' })
  @cell(120)
  level_16?: string;

  @ApiPropertyOptional({ description: 'Name of the item on level 17.' })
  @cell(120)
  level_17?: string;

  @ApiPropertyOptional({ description: 'Name of the item on level 18.' })
  @cell(120)
  level_18?: string;

  @ApiPropertyOptional({ description: 'Name of the item on level 19.' })
  @cell(120)
  level_19?: string;

  @ApiPropertyOptional({ description: 'Name of the item on level 20.' })
  @cell(120)
  level_20?: string;

  @ApiPropertyOptional({
    description:
      'draft or active, for the item of this row. New items without a status get the defaultStatus of the request.',
  })
  @cell(20)
  status?: string;

  @ApiPropertyOptional({
    description: 'A description for the item of this row.',
  })
  @cell(2000)
  description?: string;

  @ApiPropertyOptional({
    description:
      'The order of the item among its siblings (a whole number, 0 or more).',
  })
  @cell(20)
  position?: string;

  @ApiPropertyOptional({
    description: 'Place a product on the item of this row: the product id ...',
  })
  @cell(50)
  product_id?: string;

  @ApiPropertyOptional({ description: '... or its SKU (exact) ...' })
  @cell(200)
  product_sku?: string;

  @ApiPropertyOptional({
    description:
      '... or its slug. If you send more than one they must all name the same product. A part number alone is never enough: it is not unique.',
  })
  @cell(500)
  product_slug?: string;

  @ApiPropertyOptional({ description: 'The order of the product on the item.' })
  @cell(20)
  product_position?: string;

  @ApiPropertyOptional({
    description:
      'Information only (it comes from the export): ignored, and never used to find a product.',
  })
  @cell(200)
  part_number?: string;

  @ApiPropertyOptional({
    description: 'Information only (it comes from the export): ignored.',
  })
  @cell(500)
  product_name?: string;

  @ApiPropertyOptional({
    type: [CatalogImportSourceErrorDto],
    maxItems: 20,
    description:
      'Problems the frontend found while reading this row (for example a formula without a value).',
  })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(20)
  @ValidateNested({ each: true })
  @Type(() => CatalogImportSourceErrorDto)
  source_errors?: CatalogImportSourceErrorDto[];
}

export class ImportCatalogDto {
  @ApiPropertyOptional({
    default: false,
    description:
      'true = check the file and report what would happen, without changing anything.',
  })
  @IsOptional()
  @IsBoolean()
  dryRun?: boolean;

  @ApiPropertyOptional({
    description:
      'The name for the catalog if the import has to create it (default: Catalog).',
  })
  @cell(80)
  hierarchyName?: string;

  @ApiPropertyOptional({
    enum: ['draft', 'active'],
    default: 'draft',
    description:
      'The status of NEW items that have no status of their own. Existing items are not changed.',
  })
  @cell(20)
  defaultStatus?: string;

  @ApiPropertyOptional({
    type: [CatalogImportLevelDto],
    maxItems: MAX_LEVELS,
    description:
      'The levels, top level first. They are created when they do not exist yet. An import never renames, reorders or deletes levels: existing levels must match by name.',
  })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(MAX_LEVELS)
  @ValidateNested({ each: true })
  @Type(() => CatalogImportLevelDto)
  levels?: CatalogImportLevelDto[];

  @ApiProperty({
    type: [CatalogImportRowDto],
    minItems: 1,
    maxItems: CATALOG_IMPORT_MAX_ROWS,
  })
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(CATALOG_IMPORT_MAX_ROWS)
  @ValidateNested({ each: true })
  @Type(() => CatalogImportRowDto)
  rows!: CatalogImportRowDto[];
}

export class CatalogImportSummaryDto {
  @ApiProperty() hierarchyCreated!: boolean;
  @ApiProperty() levelsCreated!: number;
  @ApiProperty() levelsUpdated!: number;
  @ApiProperty() nodesCreated!: number;
  @ApiProperty() nodesUpdated!: number;
  @ApiProperty({
    description: 'Items that were already there exactly as in the file.',
  })
  nodesUnchanged!: number;
  @ApiProperty() assignmentsCreated!: number;
  @ApiProperty({ description: 'Placements that already existed.' })
  assignmentsExisting!: number;
}

export class CatalogImportErrorDto {
  @ApiProperty() row!: number;
  @ApiProperty() column!: string;
  @ApiProperty() message!: string;
  @ApiProperty() value!: string;
}

export class CatalogImportResultDto {
  @ApiProperty({
    description: 'true when nothing was changed because dryRun was set.',
  })
  dryRun!: boolean;
  @ApiProperty({
    description:
      'false when the file has problems (only possible for a dry run: a real import with problems answers 400 and changes nothing).',
  })
  valid!: boolean;
  @ApiProperty({ type: CatalogImportSummaryDto })
  summary!: CatalogImportSummaryDto;
  @ApiProperty({
    type: [CatalogImportErrorDto],
    description: 'At most 500 problems, in row order.',
  })
  errors!: CatalogImportErrorDto[];
  @ApiProperty({ description: 'The true number of problems.' })
  totalErrors!: number;
}
