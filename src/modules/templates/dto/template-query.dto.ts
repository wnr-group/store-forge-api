import { ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsIn, IsInt, IsOptional, Min } from 'class-validator';

export class TemplateListQueryDto {
  @ApiPropertyOptional({ default: 1, description: 'Page number (starts at 1)' })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page: number = 1;

  @ApiPropertyOptional({
    enum: [10, 20, 50, 100],
    default: 20,
    description: 'Items per page',
  })
  @IsOptional()
  @Type(() => Number)
  @IsIn([10, 20, 50, 100])
  pageSize: number = 20;
}

export class TemplateImagesQueryDto {
  @ApiPropertyOptional({ default: 1, description: 'Page number (starts at 1)' })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page: number = 1;

  @ApiPropertyOptional({
    enum: [10, 20, 50, 100],
    default: 20,
    description: 'Images per page',
  })
  @IsOptional()
  @Type(() => Number)
  @IsIn([10, 20, 50, 100])
  pageSize: number = 20;
}
