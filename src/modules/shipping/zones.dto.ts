import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform, Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsBoolean,
  IsDefined,
  IsOptional,
  IsString,
  MaxLength,
  MinLength,
  ValidateNested,
} from 'class-validator';
import { MAX_AREAS_PER_ZONE } from './shipping-areas.js';

const trim = ({ value }: { value: unknown }) =>
  typeof value === 'string' ? value.trim() : value;

export class ZoneCityDto {
  @ApiProperty({
    example: 'Karnataka',
    description: 'The state name or its two-digit GST code.',
  })
  @IsString()
  state!: string;

  @ApiProperty({ example: 'Mysuru' })
  @IsString()
  @MaxLength(100)
  city!: string;
}

export class ZoneRangeDto {
  @ApiProperty({ example: '560001' }) @IsString() from!: string;
  @ApiProperty({ example: '560099', description: 'Inclusive.' })
  @IsString()
  to!: string;
}

export class ZoneAreasDto {
  @ApiPropertyOptional({
    description:
      'Cover all of India (the "everywhere else" zone). Only one zone can.',
  })
  @IsOptional()
  @IsBoolean()
  country?: boolean;

  @ApiPropertyOptional({
    type: [String],
    example: ['Karnataka', 'Kerala'],
    description: 'State or union territory names, or two-digit GST codes.',
  })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(MAX_AREAS_PER_ZONE)
  @IsString({ each: true })
  states?: string[];

  @ApiPropertyOptional({ type: [ZoneCityDto] })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(MAX_AREAS_PER_ZONE)
  @ValidateNested({ each: true })
  @Type(() => ZoneCityDto)
  cities?: ZoneCityDto[];

  @ApiPropertyOptional({
    type: [String],
    example: ['560001', '560002'],
    description: 'Single 6-digit PIN codes.',
  })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(MAX_AREAS_PER_ZONE)
  @IsString({ each: true })
  postalCodes?: string[];

  @ApiPropertyOptional({
    type: [ZoneRangeDto],
    description:
      'Inclusive PIN code ranges. Ranges of different zones may not overlap.',
  })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(MAX_AREAS_PER_ZONE)
  @ValidateNested({ each: true })
  @Type(() => ZoneRangeDto)
  postalRanges?: ZoneRangeDto[];
}

export class SaveZoneDto {
  @ApiProperty({ example: 'South India', minLength: 1, maxLength: 80 })
  @Transform(trim)
  @IsString()
  @MinLength(1, { message: 'Enter a name for the zone.' })
  @MaxLength(80)
  name!: string;

  @ApiPropertyOptional({
    default: true,
    description:
      'A zone that is off is "not served": its addresses cannot check out.',
  })
  @IsOptional()
  @IsBoolean()
  enabled?: boolean;

  @ApiPropertyOptional({
    default: true,
    description:
      'Whether cash on delivery may be used for addresses in this zone.',
  })
  @IsOptional()
  @IsBoolean()
  codAllowed?: boolean;

  @ApiProperty({
    type: ZoneAreasDto,
    description: 'What the zone covers. Replaces the previous areas.',
  })
  @IsDefined({ message: 'Add at least one area to this zone.' })
  @ValidateNested()
  @Type(() => ZoneAreasDto)
  areas!: ZoneAreasDto;
}

export class ZoneAreaSummaryDto {
  @ApiProperty() country!: boolean;
  @ApiProperty() states!: number;
  @ApiProperty() cities!: number;
  @ApiProperty() postalCodes!: number;
  @ApiProperty() postalRanges!: number;
}

export class ZoneStateDto {
  @ApiProperty() code!: string;
  @ApiProperty() name!: string;
}

export class ZoneCityOutDto {
  @ApiProperty() stateCode!: string;
  @ApiProperty() state!: string;
  @ApiProperty() city!: string;
}

export class ZoneAreasOutDto {
  @ApiProperty() country!: boolean;
  @ApiProperty({ type: [ZoneStateDto] }) states!: ZoneStateDto[];
  @ApiProperty({ type: [ZoneCityOutDto] }) cities!: ZoneCityOutDto[];
  @ApiProperty({ type: [String] }) postalCodes!: string[];
  @ApiProperty({ type: [ZoneRangeDto] }) postalRanges!: ZoneRangeDto[];
}

export class ZoneDto {
  @ApiProperty({ format: 'uuid' }) id!: string;
  @ApiProperty() name!: string;
  @ApiProperty() enabled!: boolean;
  @ApiProperty() codAllowed!: boolean;
  @ApiProperty({ type: ZoneAreaSummaryDto }) areaSummary!: ZoneAreaSummaryDto;
  @ApiProperty() methodCount!: number;
  @ApiProperty() createdAt!: Date;
  @ApiProperty() updatedAt!: Date;
}

export class ZoneDetailDto extends ZoneDto {
  @ApiProperty({ type: ZoneAreasOutDto }) areas!: ZoneAreasOutDto;
}
