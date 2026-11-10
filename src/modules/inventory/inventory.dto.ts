import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsIn, IsInt, IsOptional, IsUUID, Max, Min } from 'class-validator';
import { PaginationQueryDto } from '../../common/dto/pagination-query.dto.js';
import { OptionalText, WholeNumber } from '../../common/validation/fields.js';
import { INVENTORY_REASONS } from '../../database/schema/enums.js';

export const STOCK_STATES = ['in', 'low', 'out', 'untracked'] as const;
export type StockState = (typeof STOCK_STATES)[number];

export class InventoryRowDto {
  @ApiProperty({ format: 'uuid' }) productId!: string;
  @ApiPropertyOptional({ format: 'uuid', nullable: true }) variantId!:
    string | null;
  @ApiProperty() productName!: string;
  @ApiPropertyOptional({ nullable: true }) variantTitle!: string | null;
  @ApiPropertyOptional({ nullable: true }) sku!: string | null;
  @ApiProperty() quantity!: number;
  @ApiProperty() tracked!: boolean;
  @ApiProperty() threshold!: number;
  @ApiProperty({ enum: STOCK_STATES }) state!: StockState;
}

export class AdjustmentDto {
  @ApiProperty({ format: 'uuid' }) id!: string;
  @ApiProperty({ format: 'uuid' }) productId!: string;
  @ApiPropertyOptional({ format: 'uuid', nullable: true }) variantId!:
    string | null;
  @ApiProperty() productName!: string;
  @ApiPropertyOptional({ nullable: true }) variantTitle!: string | null;
  @ApiProperty({ description: 'Change applied (never 0).' }) delta!: number;
  @ApiProperty() quantityAfter!: number;
  @ApiProperty({ enum: INVENTORY_REASONS }) reason!: string;
  @ApiPropertyOptional({ nullable: true }) note!: string | null;
  @ApiPropertyOptional({ format: 'uuid', nullable: true }) createdBy!:
    string | null;
  @ApiProperty() createdAt!: Date;
}

export class StockLevelDto {
  @ApiProperty({ description: 'Stock after the adjustment.' })
  quantity!: number;
}

export class InventoryQueryDto extends PaginationQueryDto {
  @ApiPropertyOptional({ enum: ['all', ...STOCK_STATES], default: 'all' })
  @IsOptional()
  @IsIn(['all', ...STOCK_STATES])
  stock: 'all' | StockState = 'all';
}

export class AdjustmentsQueryDto {
  @ApiPropertyOptional({ default: 15, minimum: 1, maximum: 100 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  limit: number = 15;
}

export class AdjustStockDto {
  @ApiProperty({ format: 'uuid' })
  @IsUUID()
  productId!: string;

  @ApiPropertyOptional({
    format: 'uuid',
    nullable: true,
    description:
      'Required when the product has variants; refused when it has none.',
  })
  @IsOptional()
  @IsUUID()
  variantId?: string | null;

  @ApiProperty({
    enum: ['add', 'set'],
    description:
      '`add` changes stock by `value` (may be negative); `set` sets it to `value`.',
  })
  @IsIn(['add', 'set'], { message: 'Please select an adjustment type.' })
  mode!: 'add' | 'set';

  @ApiProperty({ minimum: -1_000_000, maximum: 1_000_000 })
  @WholeNumber('Quantity', { min: -1_000_000, max: 1_000_000 })
  value!: number;

  @ApiProperty({ enum: INVENTORY_REASONS })
  @IsIn(INVENTORY_REASONS, { message: 'Please select a reason.' })
  reason!: (typeof INVENTORY_REASONS)[number];

  @ApiPropertyOptional({ nullable: true, maxLength: 500 })
  @OptionalText('Note', 500)
  note?: string | null;
}
