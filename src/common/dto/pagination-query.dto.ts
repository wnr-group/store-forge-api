import { ApiPropertyOptional } from '@nestjs/swagger';
import { Transform, Type } from 'class-transformer';
import {
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
} from 'class-validator';

export const DEFAULT_PAGE_SIZE = 20;

/** `?page=1&limit=20&search=phone&sortOrder=desc`. Subclasses add `sortBy` with their own allowed values. */
export class PaginationQueryDto {
  @ApiPropertyOptional({ default: 1, minimum: 1, maximum: 100000 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100_000)
  page: number = 1;

  @ApiPropertyOptional({ default: DEFAULT_PAGE_SIZE, minimum: 1, maximum: 100 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  limit: number = DEFAULT_PAGE_SIZE;

  @ApiPropertyOptional({ maxLength: 100, description: 'Words to search for' })
  @IsOptional()
  @Transform(({ value }) => (typeof value === 'string' ? value.trim() : value))
  @IsString()
  @MaxLength(100)
  search: string = '';

  @ApiPropertyOptional({ enum: ['asc', 'desc'], default: 'desc' })
  @IsOptional()
  @IsIn(['asc', 'desc'])
  sortOrder: 'asc' | 'desc' = 'desc';
}

export const offsetOf = (q: { page: number; limit: number }) =>
  (q.page - 1) * q.limit;

/** Escapes LIKE wildcards so user text is matched literally. */
export const likeTerm = (text: string) =>
  `%${text.replace(/[%_\\]/g, '\\$&')}%`;
