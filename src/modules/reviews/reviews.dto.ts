import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  IsBoolean,
  IsEnum,
  IsIn,
  IsInt,
  IsNotEmpty,
  IsOptional,
  IsString,
  IsUUID,
  Max,
  MaxLength,
  Min,
  MinLength,
} from 'class-validator';
import {
  REVIEW_SOURCES,
  REVIEW_STATUSES,
  type ReviewSource,
  type ReviewStatus,
} from '../../database/schema/studio.js';

export class CreateReviewDto {
  @ApiProperty({ description: 'The product this review belongs to' })
  @IsUUID()
  productId!: string;

  @ApiProperty({ description: 'Review author name', maxLength: 80 })
  @IsString()
  @IsNotEmpty()
  @MaxLength(80)
  authorName!: string;

  @ApiProperty({
    description: 'Star rating from 1 to 5',
    minimum: 1,
    maximum: 5,
  })
  @IsInt()
  @Min(1)
  @Max(5)
  @Type(() => Number)
  rating!: number;

  @ApiProperty({ description: 'Short headline for the review', maxLength: 120 })
  @IsString()
  @IsNotEmpty()
  @MaxLength(120)
  title!: string;

  @ApiProperty({ description: 'Full review text', maxLength: 5000 })
  @IsString()
  @IsNotEmpty()
  @MaxLength(5000)
  body!: string;

  @ApiPropertyOptional({
    description: 'Optional origin or source store name',
    maxLength: 60,
  })
  @IsOptional()
  @IsString()
  @MaxLength(60)
  originLabel?: string;

  @ApiPropertyOptional({ enum: REVIEW_STATUSES, default: 'published' })
  @IsOptional()
  @IsIn(REVIEW_STATUSES)
  status?: ReviewStatus;
}

export class UpdateReviewDto {
  @ApiPropertyOptional({ maxLength: 80 })
  @IsOptional()
  @IsString()
  @MaxLength(80)
  authorName?: string;

  @ApiPropertyOptional({ minimum: 1, maximum: 5 })
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(5)
  @Type(() => Number)
  rating?: number;

  @ApiPropertyOptional({ maxLength: 120 })
  @IsOptional()
  @IsString()
  @MaxLength(120)
  title?: string;

  @ApiPropertyOptional({ maxLength: 5000 })
  @IsOptional()
  @IsString()
  @MaxLength(5000)
  body?: string;

  @ApiPropertyOptional({ maxLength: 60 })
  @IsOptional()
  @IsString()
  @MaxLength(60)
  originLabel?: string;

  @ApiPropertyOptional({ enum: REVIEW_STATUSES })
  @IsOptional()
  @IsIn(REVIEW_STATUSES)
  status?: ReviewStatus;
}

export class ReviewFilterQueryDto {
  @ApiPropertyOptional({ description: 'Filter by product id' })
  @IsOptional()
  @IsUUID()
  productId?: string;

  @ApiPropertyOptional({ enum: REVIEW_STATUSES })
  @IsOptional()
  @IsIn(REVIEW_STATUSES)
  status?: ReviewStatus;

  @ApiPropertyOptional({ enum: REVIEW_SOURCES })
  @IsOptional()
  @IsIn(REVIEW_SOURCES)
  source?: ReviewSource;

  @ApiPropertyOptional({
    enum: ['newest', 'oldest', 'rating_desc', 'rating_asc'],
  })
  @IsOptional()
  @IsIn(['newest', 'oldest', 'rating_desc', 'rating_asc'])
  sort?: 'newest' | 'oldest' | 'rating_desc' | 'rating_asc';

  @ApiPropertyOptional({ default: 20, maximum: 50 })
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(50)
  @Type(() => Number)
  limit?: number = 20;

  @ApiPropertyOptional({ default: 0 })
  @IsOptional()
  @IsInt()
  @Min(0)
  @Type(() => Number)
  offset?: number = 0;
}

export class ReviewImportRowErrorDto {
  @ApiProperty()
  row!: number;

  @ApiProperty()
  column!: string;

  @ApiProperty()
  reason!: string;
}

export class ReviewImportRequestDto {
  @ApiPropertyOptional({
    description: 'Recorded attestation ID required for real import',
  })
  @IsOptional()
  @IsUUID()
  attestationId?: string;

  @ApiPropertyOptional({
    default: false,
    description: 'Dry run validation only',
  })
  @IsOptional()
  @IsBoolean()
  validateOnly?: boolean = false;

  @ApiProperty({ description: 'Raw CSV text with reviews' })
  @IsString()
  @IsNotEmpty()
  csvContent!: string;
}

export class ReviewImportResponseDto {
  @ApiProperty()
  valid!: boolean;

  @ApiProperty({ type: [ReviewImportRowErrorDto] })
  errors!: ReviewImportRowErrorDto[];

  @ApiPropertyOptional()
  totalRows?: number;

  @ApiPropertyOptional()
  importedRows?: number;

  @ApiPropertyOptional()
  importId?: string;
}

export class ReviewDto {
  @ApiProperty()
  id!: string;

  @ApiProperty()
  tenantId!: string;

  @ApiProperty()
  storeId!: string;

  @ApiProperty()
  productId!: string;

  @ApiProperty()
  authorName!: string;

  @ApiProperty()
  rating!: number;

  @ApiProperty()
  title!: string;

  @ApiProperty()
  body!: string;

  @ApiProperty()
  reviewedAt!: Date;

  @ApiProperty()
  status!: string;

  @ApiProperty()
  source!: string;

  @ApiPropertyOptional()
  originLabel?: string | null;

  @ApiProperty()
  verifiedPurchase!: boolean;

  @ApiPropertyOptional()
  importId?: string | null;

  @ApiProperty()
  createdAt!: Date;

  @ApiProperty()
  updatedAt!: Date;
}
