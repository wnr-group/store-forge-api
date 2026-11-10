import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsIn, IsNotEmpty, IsOptional, IsString } from 'class-validator';
import { PAGE_KINDS } from '../../../infrastructure/database/template-deps/document.js';

export const INDEX_PRESET_KEYS = ['classic', 'spotlight'] as const;
export type IndexPresetKey = (typeof INDEX_PRESET_KEYS)[number];
export type PageKind = (typeof PAGE_KINDS)[number];

export class CreateTemplateDto {
  @ApiProperty({
    enum: PAGE_KINDS,
    description: 'Page template kind (index, product, collection)',
  })
  @IsIn(PAGE_KINDS)
  kind!: PageKind;

  @ApiProperty({
    description: 'Template display name (1..80 code points)',
    maxLength: 80,
  })
  @IsString()
  @IsNotEmpty()
  name!: string;

  @ApiPropertyOptional({
    enum: INDEX_PRESET_KEYS,
    description:
      'Preset key for index templates (classic, spotlight). Required for index, rejected for other kinds.',
  })
  @IsOptional()
  @IsIn(INDEX_PRESET_KEYS)
  presetKey?: IndexPresetKey;
}
