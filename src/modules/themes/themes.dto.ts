import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  IsIn,
  IsInt,
  IsNotEmpty,
  IsObject,
  IsOptional,
  IsString,
  IsUUID,
  Matches,
  MaxLength,
  Min,
} from 'class-validator';
import { PaginationQueryDto } from '../../common/dto/pagination-query.dto.js';
import {
  THEME_INDUSTRIES,
  TEMPLATE_KINDS,
} from '../../database/schema/templates.js';
import { ProductPresentationsPublishedDto } from './product-presentations.dto.js';

export class ThemeListQueryDto extends PaginationQueryDto {
  @ApiPropertyOptional({
    enum: THEME_INDUSTRIES,
    description: 'Only themes made for this kind of store',
  })
  @IsOptional()
  @IsIn(THEME_INDUSTRIES, { message: 'Please select a valid industry.' })
  industry?: (typeof THEME_INDUSTRIES)[number];
}

export class ThemeSummaryDto {
  @ApiProperty({ format: 'uuid' }) id!: string;
  @ApiProperty({ example: 'atelier' }) slug!: string;
  @ApiProperty({ example: 'Atelier' }) name!: string;
  @ApiProperty() description!: string;
  @ApiProperty({ enum: THEME_INDUSTRIES }) industry!: string;
  @ApiProperty({ example: 1 }) version!: number;
  @ApiPropertyOptional({
    nullable: true,
    description: 'Address of the preview picture, served by the storefront.',
  })
  previewImage!: string | null;
  @ApiProperty({ description: 'True for the theme this store uses now.' })
  isCurrent!: boolean;
}

export class ThemeDetailDto extends ThemeSummaryDto {
  @ApiProperty({
    type: 'object',
    additionalProperties: true,
    description:
      "The theme's starting documents by template kind: `index`, `product`, `collection`, `theme_settings`, `group_header`, `group_footer` and `group_announcement`. Render them with the storefront engine to preview the theme before applying it.",
  })
  documents!: Record<string, unknown>;
}

export class CurrentThemeDto {
  @ApiPropertyOptional({ type: ThemeSummaryDto, nullable: true })
  theme!: ThemeSummaryDto | null;
  @ApiPropertyOptional({
    nullable: true,
    description: 'The theme version this store started from.',
  })
  appliedVersion!: number | null;
  @ApiPropertyOptional({ nullable: true }) appliedAt!: Date | null;
  @ApiProperty({
    description:
      'True when the catalogue has a newer version of the theme. Applying it again replaces your drafts.',
  })
  updateAvailable!: boolean;
}

export class ApplyThemeDto {
  @ApiProperty({ example: 'atelier' })
  @IsString()
  @Matches(/^[a-z][a-z0-9-]{1,39}$/, { message: 'Please choose a theme.' })
  themeSlug!: string;
}

export class ApplyThemeResultDto {
  @ApiProperty({ type: ThemeSummaryDto }) theme!: ThemeSummaryDto;
  @ApiProperty({ description: 'How many page and shared drafts were written.' })
  draftsWritten!: number;
  @ApiProperty({
    description:
      'How many of those drafts replaced different work you had already saved. Published versions are never changed by applying a theme.',
  })
  draftsReplaced!: number;
}

export class TemplateSummaryDto {
  @ApiProperty({ format: 'uuid' }) id!: string;
  @ApiProperty({ enum: TEMPLATE_KINDS }) kind!: string;
  @ApiProperty() name!: string;
  @ApiProperty({ enum: ['active', 'archived'] }) status!: string;
  @ApiProperty() isDefault!: boolean;
  @ApiProperty({
    description:
      'Goes up by one each time the draft changes. Send it back when saving so a second editor cannot be overwritten.',
  })
  revision!: number;
  @ApiProperty({
    enum: ['draft', 'published', 'published_with_changes', 'archived'],
  })
  publicationState!: string;
  @ApiPropertyOptional({ nullable: true }) publishedVersion!: number | null;
  @ApiPropertyOptional({ nullable: true }) publishedAt!: Date | null;
  @ApiProperty() updatedAt!: Date;
}

export class TemplateDetailDto extends TemplateSummaryDto {
  @ApiProperty({ type: 'object', additionalProperties: true })
  document!: Record<string, unknown>;
}

export class PreviewBundleDto {
  @ApiProperty({ type: TemplateDetailDto }) template!: TemplateDetailDto;
  @ApiPropertyOptional({
    type: 'object',
    additionalProperties: true,
    nullable: true,
    description: 'Draft theme settings (colours, fonts, spacing).',
  })
  theme!: Record<string, unknown> | null;
  @ApiProperty({
    type: 'object',
    additionalProperties: true,
    description: 'Draft header, footer and announcement groups.',
  })
  groups!: Record<string, unknown>;
  @ApiProperty({ example: 'acme-store' }) storeSlug!: string;
}

export class SaveDraftDto {
  @ApiProperty({
    type: 'object',
    additionalProperties: true,
    description: 'The whole template document.',
  })
  @IsObject({ message: 'The document must be an object.' })
  document!: Record<string, unknown>;

  @ApiProperty({
    minimum: 1,
    description: 'The revision you started editing from.',
  })
  @Type(() => Number)
  @IsInt()
  @Min(1)
  expectedRevision!: number;
}

export class PublishDto {
  @ApiPropertyOptional({ maxLength: 80, description: 'A note for the history' })
  @IsOptional()
  @IsString()
  @MaxLength(80)
  label?: string;

  @ApiPropertyOptional({
    minimum: 1,
    description:
      'If set, publishing fails when the draft has changed since you saw this revision.',
  })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  expectedRevision?: number;
}

export class PublishThemeDto {
  @ApiPropertyOptional({ maxLength: 80 })
  @IsOptional()
  @IsString()
  @MaxLength(80)
  label?: string;
}

export class PublishedItemDto {
  @ApiProperty({ format: 'uuid' }) templateId!: string;
  @ApiProperty({ enum: TEMPLATE_KINDS }) kind!: string;
  @ApiProperty() versionNumber!: number;
}

export class PublishResultDto {
  @ApiProperty({ type: [PublishedItemDto] }) published!: PublishedItemDto[];
  @ApiProperty({
    description: 'How many documents already matched their live version.',
  })
  unchanged!: number;
  @ApiProperty({ example: 'acme-store' }) storeSlug!: string;
  @ApiProperty() publishedAt!: Date;
  @ApiPropertyOptional({
    type: ProductPresentationsPublishedDto,
    description:
      'Only when the whole theme is published: how many product design settings went live.',
  })
  productPresentations?: ProductPresentationsPublishedDto;
}

export class TemplateVersionDto {
  @ApiProperty({ format: 'uuid' }) id!: string;
  @ApiProperty() versionNumber!: number;
  @ApiProperty({ enum: ['publish', 'rollback', 'migration'] }) source!: string;
  @ApiPropertyOptional({ format: 'uuid', nullable: true }) rolledBackFrom!:
    string | null;
  @ApiPropertyOptional({ format: 'uuid', nullable: true }) publishedBy!:
    string | null;
  @ApiPropertyOptional({ nullable: true }) label!: string | null;
  @ApiProperty() publishedAt!: Date;
  @ApiProperty({ description: 'True for the version shoppers see now.' })
  isLive!: boolean;
}

export class RollbackDto {
  @ApiProperty({ format: 'uuid' })
  @IsUUID()
  @IsNotEmpty()
  versionId!: string;

  @ApiPropertyOptional({ maxLength: 80 })
  @IsOptional()
  @IsString()
  @MaxLength(80)
  label?: string;
}
