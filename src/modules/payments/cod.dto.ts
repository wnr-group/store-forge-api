import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsBoolean, IsInt, IsOptional, Max, Min } from 'class-validator';

const MAX_MINOR = 100_000_000_000;

export class SaveCodSettingsDto {
  @ApiProperty({ description: 'Whether shoppers can choose cash on delivery.' })
  @IsBoolean()
  enabled!: boolean;

  @ApiProperty({
    minimum: 0,
    description:
      'Smallest items subtotal (in paise) that can be paid on delivery. 0 means no minimum.',
  })
  @Type(() => Number)
  @IsInt()
  @Min(0)
  @Max(MAX_MINOR)
  minOrderMinor!: number;

  @ApiPropertyOptional({
    nullable: true,
    description:
      'Largest items subtotal (in paise) allowed for cash on delivery. Leave out or null for no maximum.',
  })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  @Max(MAX_MINOR)
  maxOrderMinor?: number | null;

  @ApiProperty({
    minimum: 0,
    description:
      'Extra charge (in paise) added to every cash-on-delivery order. 0 means none.',
  })
  @Type(() => Number)
  @IsInt()
  @Min(0)
  @Max(MAX_MINOR)
  feeMinor!: number;
}

export class CodSettingsDto {
  @ApiProperty({
    description: 'False until the Owner saves settings for the first time.',
  })
  configured!: boolean;
  @ApiProperty() enabled!: boolean;
  @ApiProperty() minOrderMinor!: number;
  @ApiProperty({ nullable: true }) maxOrderMinor!: number | null;
  @ApiProperty() feeMinor!: number;
  @ApiPropertyOptional({ nullable: true }) updatedAt!: Date | null;
}
