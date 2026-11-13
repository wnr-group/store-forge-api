import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import {
  IsIn,
  IsNotIn,
  IsOptional,
  IsString,
  Matches,
  MaxLength,
} from 'class-validator';
import {
  STORE_PAGE_STATUSES,
  type StorePageStatus,
} from '../../database/schema/templates.js';
import { RequiredText } from '../../common/validation/fields.js';

/** Addresses that already mean something on a store's own address. Mirrors `store_pages_slug_reserved_check`. */
export const RESERVED_PAGE_SLUGS = [
  'products',
  'collections',
  'search',
  'cart',
  'checkout',
  'login',
  'dashboard',
  'admin',
  'api',
  'pages',
  's',
  'no-workspace',
  'account',
];

const lower = ({ value }: { value: unknown }) =>
  typeof value === 'string' ? value.trim().toLowerCase() : value;

export class StorePageDto {
  @ApiProperty({ format: 'uuid' }) id!: string;
  @ApiProperty() title!: string;
  @ApiProperty({ example: 'about' }) slug!: string;
  @ApiProperty() body!: string;
  @ApiProperty({ enum: STORE_PAGE_STATUSES }) status!: StorePageStatus;
  @ApiProperty() createdAt!: Date;
  @ApiProperty() updatedAt!: Date;
}

export class CreatePageDto {
  @ApiProperty({ maxLength: 120 })
  @RequiredText('Title', 120)
  title!: string;

  @ApiPropertyOptional({
    description:
      'The address of the page on your store: `/about`. If you leave it out it is made from the title.',
  })
  @IsOptional()
  @Transform(lower)
  @Matches(/^[a-z0-9][a-z0-9-]{0,59}$/, {
    message:
      'Use lowercase letters, numbers and hyphens only (up to 60 characters).',
  })
  @IsNotIn(RESERVED_PAGE_SLUGS, {
    message: 'That address is used by the store itself. Please pick another.',
  })
  slug?: string;

  @ApiPropertyOptional({
    maxLength: 20000,
    description:
      'Plain text. A blank line starts a new paragraph; a line starting with `# ` is a heading.',
  })
  @IsOptional()
  @IsString({ message: 'Content must be text.' })
  @MaxLength(20000, { message: 'Content must be at most 20,000 characters.' })
  body?: string;

  @ApiPropertyOptional({ enum: STORE_PAGE_STATUSES, default: 'draft' })
  @IsOptional()
  @IsIn(STORE_PAGE_STATUSES, { message: 'Please select a valid status.' })
  status?: StorePageStatus;
}

export class UpdatePageDto {
  @ApiPropertyOptional({ maxLength: 120 })
  @IsOptional()
  @RequiredText('Title', 120)
  title?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @Transform(lower)
  @Matches(/^[a-z0-9][a-z0-9-]{0,59}$/, {
    message:
      'Use lowercase letters, numbers and hyphens only (up to 60 characters).',
  })
  @IsNotIn(RESERVED_PAGE_SLUGS, {
    message: 'That address is used by the store itself. Please pick another.',
  })
  slug?: string;

  @ApiPropertyOptional({ maxLength: 20000 })
  @IsOptional()
  @IsString({ message: 'Content must be text.' })
  @MaxLength(20000, { message: 'Content must be at most 20,000 characters.' })
  body?: string;

  @ApiPropertyOptional({ enum: STORE_PAGE_STATUSES })
  @IsOptional()
  @IsIn(STORE_PAGE_STATUSES, { message: 'Please select a valid status.' })
  status?: StorePageStatus;
}
