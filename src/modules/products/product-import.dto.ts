import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsInt,
  IsOptional,
  IsString,
  MaxLength,
  Min,
  ValidateNested,
} from 'class-validator';
import { IMPORT_MAX_ROWS } from './product-import.rules.js';

export class ImportSourceErrorDto {
  @ApiProperty() @IsString() @MaxLength(40) column!: string;
  @ApiProperty() @IsString() @MaxLength(200) message!: string;
}

const optionalText = (max: number) => (t: object, k: string) => {
  IsOptional()(t, k);
  IsString()(t, k);
  MaxLength(max)(t, k);
};

export class ImportRowDto {
  @ApiProperty({ description: 'Spreadsheet row number (the header is row 1).' })
  @IsInt()
  @Min(2)
  row!: number;
  @ApiPropertyOptional() @optionalText(500) name?: string;
  @ApiPropertyOptional() @optionalText(50) price?: string;
  @ApiPropertyOptional() @optionalText(500) slug?: string;
  @ApiPropertyOptional() @optionalText(200) sku?: string;
  @ApiPropertyOptional() @optionalText(2000) short_description?: string;
  @ApiPropertyOptional() @optionalText(25000) description?: string;
  @ApiPropertyOptional() @optionalText(500) product_type?: string;
  @ApiPropertyOptional() @optionalText(50) compare_at_price?: string;
  @ApiPropertyOptional() @optionalText(50) cost?: string;
  @ApiPropertyOptional() @optionalText(50) quantity?: string;
  @ApiPropertyOptional() @optionalText(20) track_inventory?: string;
  @ApiPropertyOptional() @optionalText(50) low_stock_threshold?: string;
  @ApiPropertyOptional() @optionalText(20) status?: string;
  @ApiPropertyOptional() @optionalText(500) category?: string;
  @ApiPropertyOptional() @optionalText(500) subcategory?: string;
  @ApiPropertyOptional({ type: [ImportSourceErrorDto], maxItems: 20 })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(20)
  @ValidateNested({ each: true })
  @Type(() => ImportSourceErrorDto)
  source_errors?: ImportSourceErrorDto[];
}

export class ImportProductsDto {
  @ApiProperty({ type: [ImportRowDto], minItems: 1, maxItems: IMPORT_MAX_ROWS })
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(IMPORT_MAX_ROWS)
  @ValidateNested({ each: true })
  @Type(() => ImportRowDto)
  rows!: ImportRowDto[];
}

export class ImportResultDto {
  @ApiProperty({ description: 'How many products were created.' })
  count!: number;
}
