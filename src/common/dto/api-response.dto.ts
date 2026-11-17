import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

export class PaginationMetaDto {
  @ApiProperty({ example: 1 }) page!: number;
  @ApiProperty({ example: 20 }) limit!: number;
  @ApiProperty({ example: 100 }) total!: number;
  @ApiProperty({ example: 5 }) totalPages!: number;
}

export class SuccessResponseDto {
  @ApiProperty({ example: true }) success!: true;
  @ApiProperty({ example: 'Resource retrieved successfully' }) message!: string;
}

export class ErrorBodyDto {
  @ApiProperty({ example: 'PRODUCT_NOT_FOUND' }) code!: string;
  @ApiPropertyOptional({
    nullable: true,
    description:
      'Details about what went wrong, such as which fields have errors. It never contains sensitive data.',
    example: null,
  })
  details!: unknown;
}

export class ErrorResponseDto {
  @ApiProperty({ example: false }) success!: false;
  @ApiProperty({ example: 'Product not found' }) message!: string;
  @ApiProperty({ type: ErrorBodyDto }) error!: ErrorBodyDto;
  @ApiProperty({ example: '2026-11-10T10:00:00.000Z' }) timestamp!: string;
  @ApiProperty({ example: '/api/v1/products/123' }) path!: string;
}

/** Marker returned by list handlers; the response interceptor turns it into `data` + `meta`. */
export class Paginated<T> {
  constructor(
    readonly items: T[],
    readonly meta: { page: number; limit: number; total: number },
  ) {}
}

export const toMeta = (m: { page: number; limit: number; total: number }) => ({
  ...m,
  totalPages: Math.max(1, Math.ceil(m.total / m.limit)),
});
