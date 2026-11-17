import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsInt, IsObject, IsOptional, Min } from 'class-validator';
import { PaginationQueryDto } from '../../common/dto/pagination-query.dto.js';

/** `default` = no customization (the product inherits the store's design), the others describe the stored row. */
export const PRESENTATION_STATES = [
  'default',
  'draft',
  'published',
  'published_with_changes',
] as const;
export type PresentationState = (typeof PRESENTATION_STATES)[number];

export class ProductPresentationListQueryDto extends PaginationQueryDto {}

export class ProductPresentationSummaryDto {
  @ApiProperty({ format: 'uuid' }) productId!: string;
  @ApiProperty() revision!: number;
  @ApiProperty({ enum: PRESENTATION_STATES }) publicationState!: string;
  @ApiPropertyOptional({ nullable: true }) publishedAt!: Date | null;
  @ApiProperty() updatedAt!: Date;
}

export class ProductPresentationDto {
  @ApiProperty({ format: 'uuid' }) productId!: string;
  @ApiProperty({
    description:
      'Send this back when you save. 0 means the product has no customization yet.',
  })
  revision!: number;
  @ApiProperty({ enum: PRESENTATION_STATES }) publicationState!: string;
  @ApiProperty({
    type: 'object',
    additionalProperties: true,
    description:
      'The draft settings: `{ schemaVersion, gallery?, focalPoint?, hiddenBlocks? }`. Omitted settings inherit the store design.',
  })
  document!: Record<string, unknown>;
  @ApiPropertyOptional({
    type: 'object',
    additionalProperties: true,
    nullable: true,
    description: 'The settings shoppers see now. Null when never published.',
  })
  publishedDocument!: Record<string, unknown> | null;
  @ApiPropertyOptional({ nullable: true }) publishedAt!: Date | null;
  @ApiPropertyOptional({ nullable: true }) updatedAt!: Date | null;
}

export class SaveProductPresentationDto {
  @ApiProperty({
    type: 'object',
    additionalProperties: true,
    description:
      'The whole settings document. Unknown settings are rejected; an empty document `{ "schemaVersion": 1 }` inherits everything.',
  })
  @IsObject({ message: 'The document must be an object.' })
  document!: Record<string, unknown>;

  @ApiProperty({
    minimum: 0,
    description:
      'The revision you started editing from; 0 when the product has no customization yet.',
  })
  @Type(() => Number)
  @IsInt()
  @Min(0)
  expectedRevision!: number;
}

export class PublishProductPresentationDto {
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

export class PublishProductPresentationResultDto extends ProductPresentationDto {
  @ApiProperty({
    description: 'False when the draft already matched what shoppers see.',
  })
  published!: boolean;
}

export class ProductPresentationsPublishedDto {
  @ApiProperty({
    description: 'How many products had their draft settings published.',
  })
  published!: number;
}
