import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  IsArray,
  IsIn,
  IsInt,
  IsNotEmpty,
  IsOptional,
  IsString,
  IsUUID,
  Max,
  Min,
  ValidateNested,
} from 'class-validator';
import {
  RECOMMENDATION_RELATIONS,
  type RecommendationRelation,
} from '../../database/schema/studio.js';

export class RecommendationItemDto {
  @ApiProperty({ description: 'The recommended product ID' })
  @IsUUID()
  recommendedProductId!: string;

  @ApiPropertyOptional({
    enum: RECOMMENDATION_RELATIONS,
    default: 'cross_sell',
  })
  @IsOptional()
  @IsIn(RECOMMENDATION_RELATIONS)
  relationKind?: RecommendationRelation = 'cross_sell';

  @ApiPropertyOptional({ default: 0 })
  @IsOptional()
  @IsInt()
  @Min(0)
  @Type(() => Number)
  position?: number = 0;
}

export class SetRecommendationsDto {
  @ApiProperty({ type: [RecommendationItemDto] })
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => RecommendationItemDto)
  recommendations!: RecommendationItemDto[];
}

export class PublicRecommendationsQueryDto {
  @ApiPropertyOptional({
    enum: [
      'related',
      'merchant_picked',
      'collection',
      'newest',
      'recently_viewed',
    ],
    default: 'related',
  })
  @IsOptional()
  @IsIn([
    'related',
    'merchant_picked',
    'collection',
    'newest',
    'recently_viewed',
  ])
  source?:
    | 'related'
    | 'merchant_picked'
    | 'collection'
    | 'newest'
    | 'recently_viewed' = 'related';

  @ApiPropertyOptional({
    description: 'Current product slug (excluded from results)',
  })
  @IsOptional()
  @IsString()
  productSlug?: string;

  @ApiPropertyOptional({ description: 'Collection slug for collection source' })
  @IsOptional()
  @IsString()
  collectionSlug?: string;

  @ApiPropertyOptional({
    description:
      'Comma-separated slugs for recently_viewed source (browser-stored)',
  })
  @IsOptional()
  @IsString()
  viewedSlugs?: string;

  @ApiPropertyOptional({ default: 4, maximum: 8 })
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(8)
  @Type(() => Number)
  limit?: number = 4;
}
