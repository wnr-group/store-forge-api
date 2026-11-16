import { Transform } from 'class-transformer';
import { IsIn, IsInt, IsOptional, Max, Min } from 'class-validator';

export class PaginationQueryDto {
  @IsOptional()
  @Transform(({ value }) => {
    if (value === undefined || value === '') return 1;
    if (typeof value === 'string' && !/^[1-9]\d*$/.test(value)) return -1;
    const num = Number(value);
    if (!Number.isSafeInteger(num) || num > 1000000) return -1;
    return num;
  })
  @IsInt({ message: 'page must be an integer' })
  @Min(1, { message: 'page must be at least 1' })
  @Max(1000000, { message: 'page must not exceed 1000000' })
  page: number = 1;

  @IsOptional()
  @Transform(({ value }) => {
    if (value === undefined || value === '') return 20;
    if (typeof value === 'string' && !/^\d+$/.test(value)) return value;
    return Number(value);
  })
  @IsIn([10, 20, 50, 100], {
    message: 'pageSize must be one of: 10, 20, 50, 100',
  })
  pageSize: number = 20;
}
