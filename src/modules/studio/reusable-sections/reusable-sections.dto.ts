import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  IsInt,
  IsNotEmpty,
  IsObject,
  IsOptional,
  IsString,
  MaxLength,
  Min,
  MinLength,
} from 'class-validator';

export class CreateReusableSectionDto {
  @ApiProperty({ description: 'The component type (e.g. hero, banner)' })
  @IsString()
  @MinLength(1)
  @MaxLength(64)
  componentId!: string;

  @ApiProperty({ description: 'Name of the reusable section' })
  @IsString()
  @MinLength(1)
  @MaxLength(100)
  name!: string;

  @ApiPropertyOptional({ description: 'Optional description' })
  @IsOptional()
  @IsString()
  @MaxLength(300)
  description?: string;

  @ApiProperty({ description: 'Section content document' })
  @IsObject()
  content!: Record<string, unknown>;
}

export class UpdateReusableSectionDto {
  @ApiPropertyOptional({ description: 'New name' })
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(100)
  name?: string;

  @ApiPropertyOptional({ description: 'New description' })
  @IsOptional()
  @IsString()
  @MaxLength(300)
  description?: string;

  @ApiPropertyOptional({ description: 'Updated section content' })
  @IsOptional()
  @IsObject()
  content?: Record<string, unknown>;
}

export class RestoreReusableSectionVersionDto {
  @ApiProperty({ description: 'Version number to restore' })
  @IsInt()
  @Min(1)
  @Type(() => Number)
  versionNumber!: number;
}
