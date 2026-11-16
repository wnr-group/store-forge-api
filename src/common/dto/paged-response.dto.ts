import { ApiProperty } from '@nestjs/swagger';

export interface PagedResponse<T> {
  items: T[];
  total: number;
  page: number;
  pageSize: number;
}

export class PagedResponseDto<T = unknown> implements PagedResponse<T> {
  @ApiProperty({
    description: 'List of items in current page',
    type: 'array',
    items: { type: 'object' },
  })
  items!: T[];

  @ApiProperty({
    description: 'Total number of items matching the query',
    example: 100,
  })
  total!: number;

  @ApiProperty({ description: 'Current page number', example: 1 })
  page!: number;

  @ApiProperty({ description: 'Page size limit', example: 20 })
  pageSize!: number;
}
