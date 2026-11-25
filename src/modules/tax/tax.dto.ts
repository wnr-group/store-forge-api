import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import {
  IsBoolean,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  Matches,
  MaxLength,
  MinLength,
} from 'class-validator';
import { Type } from 'class-transformer';

const RATES = [0, 25, 300, 500, 1200, 1800, 2800, 4000];
const RATE_MESSAGE =
  'Choose a valid GST rate: 0%, 0.25%, 3%, 5%, 12%, 18%, 28% or 40%.';
const trim = ({ value }: { value: unknown }) =>
  typeof value === 'string' ? value.trim() : value;
const blankToNull = ({ value }: { value: unknown }) =>
  typeof value === 'string' ? value.trim() || null : value;

// --- Settings --------------------------------------------------------------------------------------------------------------

export class SaveTaxSettingsDto {
  @ApiProperty({
    description:
      'Charge GST on orders. Needs a valid GSTIN. While off, no tax is charged.',
  })
  @IsBoolean()
  enabled!: boolean;

  @ApiPropertyOptional({
    nullable: true,
    example: '27AAPFU0939F1ZV',
    description:
      'Your 15-character GSTIN. Its first two digits are your state, which decides CGST+SGST (same state) or IGST.',
  })
  @IsOptional()
  @Transform(({ value }: { value: unknown }) =>
    typeof value === 'string' ? value.trim().toUpperCase() || null : value,
  )
  @IsString()
  @MaxLength(15, { message: 'A GSTIN has 15 characters.' })
  gstin?: string | null;

  @ApiPropertyOptional({
    nullable: true,
    description: 'The registered business name shown on tax details.',
  })
  @IsOptional()
  @Transform(blankToNull)
  @IsString()
  @MinLength(1)
  @MaxLength(200)
  legalName?: string | null;

  @ApiProperty({
    description:
      'Your prices already include GST (the tax is taken out of them) instead of being added on top.',
  })
  @IsBoolean()
  pricesIncludeTax!: boolean;

  @ApiProperty({
    enum: RATES,
    description:
      'The rate (in basis points, 1800 = 18%) for products that have no rate of their own.',
  })
  @Type(() => Number)
  @IsInt({ message: RATE_MESSAGE })
  @IsIn(RATES, { message: RATE_MESSAGE })
  defaultRateBps!: number;

  @ApiProperty({
    description: 'Charge GST on delivery and cash-on-delivery charges too.',
  })
  @IsBoolean()
  chargesTaxable!: boolean;

  @ApiProperty({
    enum: RATES,
    description: 'The rate for delivery and cash-on-delivery charges.',
  })
  @Type(() => Number)
  @IsInt({ message: RATE_MESSAGE })
  @IsIn(RATES, { message: RATE_MESSAGE })
  chargesRateBps!: number;
}

export class TaxSettingsDto {
  @ApiProperty({
    description: 'False until the settings are saved for the first time.',
  })
  configured!: boolean;
  @ApiProperty() enabled!: boolean;
  @ApiPropertyOptional({ nullable: true }) gstin!: string | null;
  @ApiPropertyOptional({ nullable: true }) legalName!: string | null;
  @ApiPropertyOptional({
    nullable: true,
    description: 'Two-digit GST state code (from the GSTIN).',
  })
  stateCode!: string | null;
  @ApiPropertyOptional({ nullable: true }) stateName!: string | null;
  @ApiProperty() pricesIncludeTax!: boolean;
  @ApiProperty() defaultRateBps!: number;
  @ApiProperty() chargesTaxable!: boolean;
  @ApiProperty() chargesRateBps!: number;
  @ApiPropertyOptional({ nullable: true }) updatedAt!: Date | null;
}

// --- Tax on an order -------------------------------------------------------------------------------------------------------

export class OrderTaxLineDto {
  @ApiProperty({ enum: ['item', 'shipping', 'cod_fee'] }) kind!: string;
  @ApiProperty() description!: string;
  @ApiPropertyOptional({ nullable: true }) hsnCode!: string | null;
  @ApiProperty({ description: 'The value the tax is charged on.' })
  taxableMinor!: number;
  @ApiProperty({ description: 'In basis points: 1800 = 18%.' })
  rateBps!: number;
  @ApiProperty() cgstMinor!: number;
  @ApiProperty() sgstMinor!: number;
  @ApiProperty() igstMinor!: number;
  @ApiProperty() taxMinor!: number;
}

/** The GST an order was charged, as it was worked out at checkout. */
export class OrderTaxDto {
  @ApiProperty({
    enum: ['none', 'intra', 'inter'],
    description:
      '`intra`: CGST + SGST (seller and delivery in the same state). `inter`: IGST. `none`: no GST was charged.',
  })
  regime!: string;
  @ApiProperty({
    enum: ['sgst', 'utgst'],
    description:
      'UTGST replaces SGST in union territories without a legislature.',
  })
  stateTaxKind!: string;
  @ApiProperty() inclusive!: boolean;
  @ApiPropertyOptional({ nullable: true }) sellerGstin!: string | null;
  @ApiPropertyOptional({
    nullable: true,
    description: 'GST state code of the place of supply (the delivery state).',
  })
  placeOfSupplyStateCode!: string | null;
  @ApiProperty() cgstMinor!: number;
  @ApiProperty() sgstMinor!: number;
  @ApiProperty() igstMinor!: number;
  @ApiProperty() taxMinor!: number;
  @ApiProperty({ type: [OrderTaxLineDto] }) lines!: OrderTaxLineDto[];
}

// --- Reports ---------------------------------------------------------------------------------------------------------------

export class TaxReportQueryDto {
  @ApiPropertyOptional({
    example: '2026-04-01',
    description: 'First day (inclusive). Default: 30 days ago.',
  })
  @IsOptional()
  @Transform(trim)
  @Matches(/^\d{4}-\d{2}-\d{2}$/, {
    message: 'Use the date format YYYY-MM-DD.',
  })
  from?: string;

  @ApiPropertyOptional({
    example: '2026-04-30',
    description: 'Last day (inclusive). Default: today.',
  })
  @IsOptional()
  @Transform(trim)
  @Matches(/^\d{4}-\d{2}-\d{2}$/, {
    message: 'Use the date format YYYY-MM-DD.',
  })
  to?: string;
}

export class TaxReportRowDto {
  @ApiProperty({ description: 'In basis points: 1800 = 18%.' })
  rateBps!: number;
  @ApiProperty() lines!: number;
  @ApiProperty() taxableMinor!: number;
  @ApiProperty() cgstMinor!: number;
  @ApiProperty() sgstMinor!: number;
  @ApiProperty() igstMinor!: number;
  @ApiProperty() taxMinor!: number;
}

export class TaxReportDto {
  @ApiProperty() from!: string;
  @ApiProperty() to!: string;
  @ApiProperty({
    description: 'Orders in the period that were not cancelled or failed.',
  })
  orders!: number;
  @ApiProperty({
    description: 'Orders in the period on which GST was charged.',
  })
  taxedOrders!: number;
  @ApiProperty({
    type: [TaxReportRowDto],
    description: 'By GST rate, highest first.',
  })
  byRate!: TaxReportRowDto[];
  @ApiProperty({ description: 'Everything together.' })
  totals!: TaxReportRowDto;
  @ApiProperty({
    description:
      'What was charged on delivery and cash-on-delivery, included in the totals.',
  })
  chargesTaxMinor!: number;
}
