import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import type { TemplateDocument } from '../../../infrastructure/database/template-deps/document.js';

export class TemplateSummaryDto {
  @ApiProperty({ format: 'uuid' }) id!: string;
  @ApiProperty() kind!: string;
  @ApiProperty() name!: string;
  @ApiProperty() status!: string;
  @ApiProperty() isDefault!: boolean;
  @ApiProperty() revision!: number;
  @ApiProperty() publicationState!: string;
  @ApiPropertyOptional({ format: 'uuid', nullable: true })
  publishedVersionId!: string | null;
}

export class TemplateDetailDto extends TemplateSummaryDto {
  @ApiProperty({ description: 'Draft document JSON' })
  draft!: TemplateDocument;
}

export class VersionSummaryDto {
  @ApiProperty({ format: 'uuid' }) id!: string;
  @ApiProperty() number!: number;
  @ApiProperty() source!: string;
  @ApiPropertyOptional({ format: 'uuid', nullable: true })
  rolledBackFrom!: string | null;
  @ApiPropertyOptional({ nullable: true }) label!: string | null;
  @ApiProperty() publishedAt!: Date;
  @ApiPropertyOptional({ format: 'uuid', nullable: true })
  publishedBy!: string | null;
}

export class VersionDetailDto extends VersionSummaryDto {
  @ApiProperty({ description: 'Version document JSON' })
  document!: TemplateDocument;
}

export class SaveDraftResponseDto {
  @ApiProperty({ enum: ['saved', 'unchanged'] })
  outcome!: 'saved' | 'unchanged';

  @ApiProperty({ type: TemplateDetailDto })
  template!: TemplateDetailDto;
}

export class PublishResponseDto {
  @ApiProperty({ enum: ['published', 'unchanged'] })
  outcome!: 'published' | 'unchanged';

  @ApiPropertyOptional({ type: VersionSummaryDto, nullable: true })
  version!: VersionSummaryDto | null;

  @ApiProperty({ type: TemplateDetailDto })
  template!: TemplateDetailDto;
}

export class RollbackResponseDto {
  @ApiProperty({ enum: ['rolled_back', 'unchanged'] })
  outcome!: 'rolled_back' | 'unchanged';

  @ApiPropertyOptional({ type: VersionSummaryDto, nullable: true })
  version!: VersionSummaryDto | null;

  @ApiProperty({ type: TemplateDetailDto })
  template!: TemplateDetailDto;
}

export class RestoreVersionResponseDto {
  @ApiProperty({ enum: ['restored', 'unchanged'] })
  outcome!: 'restored' | 'unchanged';

  @ApiProperty({ type: TemplateDetailDto })
  template!: TemplateDetailDto;
}

export class AssignmentResultItemDto {
  @ApiProperty({ enum: ['product', 'collection'] })
  resourceType!: 'product' | 'collection';

  @ApiProperty({ format: 'uuid' })
  resourceId!: string;

  @ApiPropertyOptional({ format: 'uuid' })
  templateId?: string;

  @ApiProperty({
    enum: ['created', 'replaced', 'unchanged', 'removed', 'absent'],
  })
  outcome!: 'created' | 'replaced' | 'unchanged' | 'removed' | 'absent';
}

export class AssignmentResultsDto {
  @ApiProperty({ type: [AssignmentResultItemDto] })
  results!: AssignmentResultItemDto[];
}

export class TemplateImageItemDto {
  @ApiProperty() path!: string;
  @ApiProperty() name!: string;
  @ApiProperty() size!: number;
  @ApiProperty() mimeType!: string;
  @ApiProperty() createdAt!: string;
}
