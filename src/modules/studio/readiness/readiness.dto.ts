import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsOptional, IsUUID } from 'class-validator';
import { READINESS_SEVERITIES } from './types.js';

export class ReadinessRequestDto {
  @ApiPropertyOptional({
    format: 'uuid',
    description:
      'Check only this page or shared part. Leave it out to check every page and shared part of the store.',
  })
  @IsOptional()
  @IsUUID()
  templateId?: string;
}

export class ReadinessTargetDto {
  @ApiProperty({ format: 'uuid' }) documentId!: string;
  @ApiPropertyOptional({
    nullable: true,
    description:
      'The section or block, or null for a problem with the whole document.',
  })
  nodeId!: string | null;
}

export class ReadinessIssueDto {
  @ApiProperty({
    description:
      'Stable key. Send the keys of the warnings you accept back as `acknowledgedWarnings` when you publish.',
    example: 'a11y.contrast.unknown:6f1c0d0e-0000-4000-8000-000000000000:hero',
  })
  key!: string;
  @ApiProperty({ example: 'media.alt.missing' }) ruleId!: string;
  @ApiProperty({ enum: READINESS_SEVERITIES }) severity!: string;
  @ApiProperty() message!: string;
  @ApiProperty({ example: 'readiness.media.alt.missing' }) messageKey!: string;
  @ApiProperty({ type: ReadinessTargetDto }) target!: ReadinessTargetDto;
  @ApiProperty({ example: 'add_alt_text' }) fixAction!: string;
  @ApiProperty({ example: 'settings.image.alt' }) controlPath!: string;
}

export class ReadinessCountsDto {
  @ApiProperty() blockers!: number;
  @ApiProperty() warnings!: number;
  @ApiProperty() information!: number;
}

export class ReadinessReportDto {
  @ApiProperty({
    type: [ReadinessIssueDto],
    description: 'Blockers first, then warnings, then information.',
  })
  issues!: ReadinessIssueDto[];
  @ApiProperty({ type: ReadinessCountsDto }) counts!: ReadinessCountsDto;
  @ApiProperty({
    description:
      'False while any blocker exists. Blockers cannot be overridden.',
  })
  canPublish!: boolean;
  @ApiProperty({
    description:
      'The server time the check ran (schedules are judged against it).',
  })
  evaluatedAt!: string;
  @ApiProperty({
    description:
      'True when the new Studio is on for this store, so a publish runs these checks and refuses blockers. When false the report is advice only.',
  })
  enforced!: boolean;
}
