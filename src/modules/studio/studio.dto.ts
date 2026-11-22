import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsBoolean,
  IsIn,
  IsInt,
  IsISO8601,
  IsObject,
  IsOptional,
  IsString,
  IsUUID,
  Matches,
  Max,
  MaxLength,
  Min,
  MinLength,
} from 'class-validator';
import { Transform, Type } from 'class-transformer';
import {
  ATTESTATION_TYPES,
  MEDIA_KINDS,
} from '../../database/schema/studio.js';
import { IMAGE_MAX_BYTES, IMAGE_TYPES } from '../storage/storage-paths.js';
import { STUDIO_FEATURE_KEYS } from './feature-availability.js';

/** Largest width or height accepted for Studio media (the repo has no earlier dimension limit). */
export const MEDIA_MAX_DIMENSION = 8192;

const KEY = /^[a-z][a-z0-9_.-]{1,63}$/;
const LANGUAGE_TAG = /^[A-Za-z]{2,3}(-[A-Za-z0-9]{2,8})*$/;
const trim = ({ value }: { value: unknown }) =>
  typeof value === 'string' ? value.trim() : value;

export class StudioStatusDto {
  @ApiProperty({
    description: 'Is the new Studio switched on for this store? Default false.',
  })
  enabled!: boolean;
  @ApiProperty({
    description:
      'True when the store may save schema version 2 documents (the display rules). Equals `enabled`.',
  })
  schemaV2Capable!: boolean;
  @ApiProperty({
    description: 'The schema version new documents are saved with.',
    enum: [1, 2],
  })
  schemaVersion!: number;
  @ApiPropertyOptional({ nullable: true })
  pointOfNoReturnAt!: Date | null;
  @ApiProperty({
    type: 'object',
    additionalProperties: {
      type: 'string',
      enum: ['available', 'unavailable'],
    },
    description: `Legal gate per feature (${STUDIO_FEATURE_KEYS.join(', ')}). A feature is unavailable until legal approval is recorded.`,
  })
  features!: Record<string, 'available' | 'unavailable'>;
}

export class SetStudioRolloutDto {
  @ApiProperty() @IsBoolean() enabled!: boolean;
  @ApiProperty({
    minLength: 1,
    maxLength: 500,
    description:
      'Why the flag changes. Stored in the history and the audit log.',
  })
  @Transform(trim)
  @IsString()
  @MinLength(1, { message: 'A reason is required.' })
  @MaxLength(500)
  reason!: string;
}

export class StudioRolloutDto {
  @ApiProperty({ format: 'uuid' }) storeId!: string;
  @ApiProperty() enabled!: boolean;
  @ApiPropertyOptional({ nullable: true }) enabledAt!: Date | null;
  @ApiPropertyOptional({ nullable: true }) pointOfNoReturnAt!: Date | null;
}

export class StudioRolloutEventDto {
  @ApiProperty({ format: 'uuid' }) id!: string;
  @ApiProperty({ format: 'uuid' }) storeId!: string;
  @ApiProperty({ format: 'uuid' }) actorId!: string;
  @ApiProperty({ enum: ['enabled', 'disabled'] }) action!: string;
  @ApiProperty() reason!: string;
  @ApiPropertyOptional({
    nullable: true,
    type: 'object',
    additionalProperties: true,
  })
  previous!: Record<string, unknown> | null;
  @ApiPropertyOptional({
    nullable: true,
    type: 'object',
    additionalProperties: true,
  })
  new!: Record<string, unknown> | null;
  @ApiProperty() createdAt!: Date;
}

export class RolloutEventsQueryDto {
  @ApiPropertyOptional({ default: 1, minimum: 1 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100_000)
  page: number = 1;

  @ApiPropertyOptional({ default: 20, minimum: 1, maximum: 100 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  limit: number = 20;
}

export class LegalWordingDto {
  @ApiProperty({ format: 'uuid' }) id!: string;
  @ApiProperty() key!: string;
  @ApiProperty() version!: number;
  @ApiProperty({ example: 'en-IN' }) languageTag!: string;
  @ApiProperty() text!: string;
  @ApiProperty({ enum: ['draft', 'approved', 'retired'] }) status!: string;
  @ApiProperty() createdAt!: Date;
}

export class CreateLegalWordingDto {
  @ApiProperty({ example: 'badge_upload.attestation' })
  @IsString()
  @Matches(KEY, { message: 'Use lowercase letters, digits, "_", "." or "-".' })
  key!: string;

  @ApiProperty({ example: 'en-IN' })
  @IsString()
  @Matches(LANGUAGE_TAG, { message: 'Use a language tag such as en-IN.' })
  languageTag!: string;

  @ApiProperty({ minLength: 1, maxLength: 5000 })
  @IsString()
  @MinLength(1)
  @MaxLength(5000)
  text!: string;

  @ApiPropertyOptional({
    enum: ['draft', 'approved'],
    default: 'draft',
    description:
      'Approved wording can never be edited afterwards. The version number is assigned by the server (the next one for the key).',
  })
  @IsOptional()
  @IsIn(['draft', 'approved'])
  status: 'draft' | 'approved' = 'draft';
}

export class RecordFeatureApprovalDto {
  @ApiProperty({ example: 'badge_upload' })
  @IsString()
  @Matches(KEY)
  featureKey!: string;

  @ApiProperty() @IsString() @Matches(KEY) wordingKey!: string;

  @ApiProperty({ minimum: 1 }) @IsInt() @Min(1) wordingVersion!: number;

  @ApiProperty({
    description:
      'Who approved it and where (for example a ticket or document reference).',
    maxLength: 200,
  })
  @Transform(trim)
  @IsString()
  @MinLength(1)
  @MaxLength(200)
  approverRef!: string;

  @ApiProperty({ description: 'When legal approved it (ISO 8601).' })
  @IsISO8601({ strict: true })
  approvedAt!: string;

  @ApiProperty({
    description: 'The release the approval is for.',
    maxLength: 100,
  })
  @Transform(trim)
  @IsString()
  @MinLength(1)
  @MaxLength(100)
  release!: string;
}

export class FeatureApprovalDto {
  @ApiProperty({ format: 'uuid' }) id!: string;
  @ApiProperty() featureKey!: string;
  @ApiProperty() wordingKey!: string;
  @ApiProperty() wordingVersion!: number;
  @ApiProperty() approverRef!: string;
  @ApiProperty() approvedAt!: Date;
  @ApiProperty() release!: string;
  @ApiProperty() createdAt!: Date;
}

export class CreateAttestationDto {
  @ApiProperty({ enum: ATTESTATION_TYPES })
  @IsIn(ATTESTATION_TYPES)
  type!: (typeof ATTESTATION_TYPES)[number];

  @ApiProperty({
    description: 'Key of the approved wording the person accepted.',
  })
  @IsString()
  @Matches(KEY)
  wordingKey!: string;

  @ApiProperty({
    minimum: 1,
    description: 'The exact version that was shown. Must be approved.',
  })
  @IsInt()
  @Min(1)
  wordingVersion!: number;

  @ApiPropertyOptional({
    format: 'uuid',
    description: 'The media asset this attests (type `badge_upload`).',
  })
  @IsOptional()
  @IsUUID()
  assetId?: string;

  @ApiPropertyOptional({
    format: 'uuid',
    description: 'The import this attests (type `review_import`).',
  })
  @IsOptional()
  @IsUUID()
  importId?: string;

  @ApiPropertyOptional({
    type: 'object',
    additionalProperties: true,
    description: 'Small free-form context (at most 4 KB).',
  })
  @IsOptional()
  @IsObject()
  context?: Record<string, unknown>;
}

export class AttestationDto {
  @ApiProperty({ format: 'uuid' }) id!: string;
  @ApiProperty({ enum: ATTESTATION_TYPES }) type!: string;
  @ApiProperty({ format: 'uuid' }) wordingId!: string;
  @ApiProperty() wordingKey!: string;
  @ApiProperty() wordingVersion!: number;
  @ApiProperty({ format: 'uuid' }) userId!: string;
  @ApiProperty() acceptedAt!: Date;
  @ApiPropertyOptional({ format: 'uuid', nullable: true }) assetId!:
    string | null;
  @ApiPropertyOptional({ format: 'uuid', nullable: true }) importId!:
    string | null;
}

export class MediaUploadRequestDto {
  @ApiProperty({ enum: MEDIA_KINDS, default: 'badge_image' })
  @IsIn(MEDIA_KINDS)
  kind!: (typeof MEDIA_KINDS)[number];

  @ApiProperty({
    enum: IMAGE_TYPES,
    description: 'JPEG, PNG or WebP. SVG is never accepted.',
  })
  @IsIn(IMAGE_TYPES, { message: 'Only JPEG, PNG and WebP images are allowed.' })
  mimeType!: (typeof IMAGE_TYPES)[number];

  @ApiProperty({ description: 'File size in bytes, at most 5 MiB.' })
  @IsInt()
  @Min(1)
  @Max(IMAGE_MAX_BYTES, { message: 'The image must be 5 MB or smaller.' })
  sizeBytes!: number;

  @ApiProperty({ minimum: 1, maximum: MEDIA_MAX_DIMENSION })
  @IsInt()
  @Min(1)
  @Max(MEDIA_MAX_DIMENSION)
  width!: number;

  @ApiProperty({ minimum: 1, maximum: MEDIA_MAX_DIMENSION })
  @IsInt()
  @Min(1)
  @Max(MEDIA_MAX_DIMENSION)
  height!: number;

  @ApiPropertyOptional({ maxLength: 300 })
  @IsOptional()
  @Transform(trim)
  @IsString()
  @MaxLength(300)
  altText?: string;
}

export class MediaUploadTargetDto {
  @ApiProperty({ format: 'uuid' }) id!: string;
  @ApiProperty({ description: 'Object path: `{organization id}/{file}`.' })
  path!: string;
  @ApiProperty({ description: 'A token that can be used for one upload only.' })
  token!: string;
  @ApiProperty({ description: 'Upload the file here with a PUT request.' })
  signedUrl!: string;
}

export class FinalizeMediaDto {
  @ApiPropertyOptional({
    format: 'uuid',
    description:
      'Link the attestation made for this asset (type `badge_upload`).',
  })
  @IsOptional()
  @IsUUID()
  attestationId?: string;
}

export class MediaAssetDto {
  @ApiProperty({ format: 'uuid' }) id!: string;
  @ApiProperty({ enum: MEDIA_KINDS }) kind!: string;
  @ApiProperty() storagePath!: string;
  @ApiProperty({ enum: IMAGE_TYPES }) mimeType!: string;
  @ApiProperty() sizeBytes!: number;
  @ApiProperty() width!: number;
  @ApiProperty() height!: number;
  @ApiPropertyOptional({ nullable: true }) altText!: string | null;
  @ApiPropertyOptional({ format: 'uuid', nullable: true }) attestationId!:
    string | null;
  @ApiPropertyOptional({ nullable: true }) finalizedAt!: Date | null;
  @ApiProperty() createdAt!: Date;
}

export class StudioSettingsDto {
  @ApiProperty({ example: 'Feedback collected by the store.' })
  reviewDisclosureText!: string;

  @ApiProperty({ example: 'en' })
  reviewDisclosureLanguage!: string;
}

export class UpdateStudioSettingsDto {
  @ApiPropertyOptional({ minLength: 1, maxLength: 500 })
  @IsOptional()
  @Transform(trim)
  @IsString()
  @MinLength(1)
  @MaxLength(500)
  reviewDisclosureText?: string;

  @ApiPropertyOptional({ example: 'en' })
  @IsOptional()
  @Transform(trim)
  @IsString()
  @Matches(LANGUAGE_TAG)
  reviewDisclosureLanguage?: string;
}

export class RecordWebVitalsDto {
  @ApiProperty()
  @IsString()
  @MinLength(1)
  storeSlug!: string;

  @ApiPropertyOptional({ format: 'uuid' })
  @IsOptional()
  @IsUUID()
  publishId?: string;

  @ApiProperty({ enum: ['index', 'product', 'collection', 'page', 'other'] })
  @IsString()
  routeKind!: string;

  @ApiProperty({ enum: ['desktop', 'mobile'] })
  @IsIn(['desktop', 'mobile'])
  deviceClass!: string;

  @ApiProperty({ enum: ['LCP', 'CLS', 'INP', 'FCP', 'TTFB'] })
  @IsIn(['LCP', 'CLS', 'INP', 'FCP', 'TTFB'])
  metric!: string;

  @ApiProperty({ description: 'Value of the metric in ms or unitless for CLS' })
  @Type(() => Number)
  value!: number;
}

export class DiscardDraftDto {
  @ApiProperty({ format: 'uuid' })
  @IsUUID()
  templateId!: string;

  @ApiProperty({ minLength: 1, maxLength: 500 })
  @Transform(trim)
  @IsString()
  @MinLength(1)
  @MaxLength(500)
  reason!: string;
}

