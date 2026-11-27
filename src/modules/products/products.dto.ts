import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform, Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsBoolean,
  IsIn,
  IsInt,
  IsObject,
  IsOptional,
  IsString,
  IsUUID,
  Matches,
  MaxLength,
  MinLength,
  ValidateNested,
} from 'class-validator';
import {
  DEFAULT_PAGE_SIZE,
  PaginationQueryDto,
} from '../../common/dto/pagination-query.dto.js';
import {
  CatalogSlug,
  Check,
  MoneyText,
  OptionalMoneyText,
  OptionalText,
  RequiredText,
  WhenPresent,
  WholeNumber,
} from '../../common/validation/fields.js';
import { PRODUCT_STATUSES } from '../../database/schema/enums.js';
import { MAX_IMAGES_PER_PRODUCT } from '../storage/storage-paths.js';
import { MAX_VARIANTS } from './product-rules.js';

// ---------------------------------------------------------------------------------------------------------------------
// Responses
// ---------------------------------------------------------------------------------------------------------------------

export class ProductListItemDto {
  @ApiProperty({ format: 'uuid' }) id!: string;
  @ApiProperty() name!: string;
  @ApiProperty() slug!: string;
  @ApiPropertyOptional({ nullable: true }) sku!: string | null;
  @ApiPropertyOptional({
    nullable: true,
    description:
      'The part number. It is not unique and never replaces the SKU.',
  })
  partNumber!: string | null;
  @ApiProperty({ enum: PRODUCT_STATUSES }) status!: string;
  @ApiProperty({
    description:
      "The price in the currency's smallest unit (for example cents or paise).",
  })
  priceMinor!: number;
  @ApiProperty() hasVariants!: boolean;
  @ApiProperty() variantCount!: number;
  @ApiProperty() trackInventory!: boolean;
  @ApiProperty({
    description:
      'How many can be sold. If the product has variants, this is the total of all active variants. Otherwise it is the product quantity.',
  })
  stock!: number;
  @ApiProperty() lowStockThreshold!: number;
  @ApiPropertyOptional({ nullable: true }) categoryName!: string | null;
  @ApiPropertyOptional({
    nullable: true,
    description: 'Where the main image is stored.',
  })
  imagePath!: string | null;
  @ApiProperty() updatedAt!: Date;
  @ApiProperty() createdAt!: Date;
}

export class ProductOptionDto {
  @ApiProperty({ format: 'uuid' }) id!: string;
  @ApiProperty() name!: string;
  @ApiProperty() position!: number;
  @ApiProperty({ type: [String] }) values!: string[];
}

export class ProductVariantDto {
  @ApiProperty({ format: 'uuid' }) id!: string;
  @ApiProperty() title!: string;
  @ApiProperty({ example: { Size: 'M', Color: 'Black' } }) options!: Record<
    string,
    string
  >;
  @ApiPropertyOptional({ nullable: true }) sku!: string | null;
  @ApiProperty() priceMinor!: number;
  @ApiPropertyOptional({ nullable: true }) compareAtPriceMinor!: number | null;
  @ApiProperty() quantity!: number;
  @ApiPropertyOptional({ format: 'uuid', nullable: true }) imageId!:
    string | null;
  @ApiProperty() isActive!: boolean;
  @ApiProperty() position!: number;
}

export class ProductImageDto {
  @ApiProperty({ format: 'uuid' }) id!: string;
  @ApiProperty({
    description:
      'Where the image file is stored in the `products` storage bucket.',
  })
  storagePath!: string;
  @ApiPropertyOptional({ nullable: true }) altText!: string | null;
  @ApiProperty() position!: number;
  @ApiProperty() isPrimary!: boolean;
  @ApiProperty() mimeType!: string;
  @ApiProperty() sizeBytes!: number;
}

export class ProductDetailDto {
  @ApiProperty({ format: 'uuid' }) id!: string;
  @ApiProperty() name!: string;
  @ApiProperty() slug!: string;
  @ApiPropertyOptional({ nullable: true }) description!: string | null;
  @ApiPropertyOptional({ nullable: true }) shortDescription!: string | null;
  @ApiPropertyOptional({ nullable: true }) productType!: string | null;
  @ApiPropertyOptional({ format: 'uuid', nullable: true }) categoryId!:
    string | null;
  @ApiPropertyOptional({
    nullable: true,
    description:
      'The product code (SKU). It is used only when the product has no variants.',
  })
  sku!: string | null;
  @ApiPropertyOptional({
    nullable: true,
    description:
      'The part number (for example a manufacturer or catalogue number). It is not unique, may be shared by several products and is never used to identify a product; the SKU stays the product code.',
  })
  partNumber!: string | null;
  @ApiProperty() priceMinor!: number;
  @ApiPropertyOptional({ nullable: true }) compareAtPriceMinor!: number | null;
  @ApiPropertyOptional({ nullable: true }) costMinor!: number | null;
  @ApiProperty() hasVariants!: boolean;
  @ApiProperty() trackInventory!: boolean;
  @ApiProperty() quantity!: number;
  @ApiProperty() lowStockThreshold!: number;
  @ApiProperty({
    description:
      'Shipping weight in grams. 0 means it is not set; weight-priced shipping is not offered for a cart that contains such a product.',
  })
  weightGrams!: number;
  @ApiPropertyOptional({
    nullable: true,
    enum: [0, 25, 300, 500, 1200, 1800, 2800, 4000],
    description:
      'GST rate in basis points (1800 = 18%). Null means the organization default rate is used.',
  })
  taxRateBps!: number | null;
  @ApiPropertyOptional({
    nullable: true,
    description: 'HSN (goods) or SAC (services) code: 4, 6 or 8 digits.',
  })
  hsnCode!: string | null;
  @ApiProperty({ enum: PRODUCT_STATUSES }) status!: string;
  @ApiProperty() createdAt!: Date;
  @ApiProperty() updatedAt!: Date;
  @ApiProperty({ type: [ProductOptionDto] }) options!: ProductOptionDto[];
  @ApiProperty({ type: [ProductVariantDto] }) variants!: ProductVariantDto[];
  @ApiProperty({ type: [ProductImageDto] }) images!: ProductImageDto[];
  @ApiProperty({ type: [String], format: 'uuid' }) collectionIds!: string[];
}

export class BulkCountDto {
  @ApiProperty({ description: 'How many products were changed.' })
  count!: number;
}

// ---------------------------------------------------------------------------------------------------------------------
// Requests
// ---------------------------------------------------------------------------------------------------------------------

const trimArray = ({ value }: { value: unknown }) =>
  Array.isArray(value)
    ? value.map((v) => (typeof v === 'string' ? v.trim() : v))
    : value;

const nullableSku = () =>
  [
    Transform(({ value }) =>
      typeof value === 'string' ? value.trim() || null : value,
    ),
    IsOptional(),
    IsString(),
    MaxLength(64, { message: 'SKU must be at most 64 characters.' }),
  ] as const;

function Sku() {
  return (target: object, key: string | symbol) => {
    for (const d of nullableSku()) d(target, key);
  };
}

export class ProductImageInputDto {
  @ApiProperty({
    description:
      'The file path you received from POST /uploads/signed-urls. It is checked again against your organization, the product folder and the storage bucket.',
  })
  @IsString()
  @MinLength(10)
  @MaxLength(300)
  path!: string;

  @ApiPropertyOptional({ nullable: true, maxLength: 300 })
  @OptionalText('Alt text', 300)
  altText?: string | null;
}

export class ProductOptionInputDto {
  @ApiProperty({ maxLength: 40, example: 'Size' })
  @RequiredText('Option name', 40)
  name!: string;

  @ApiProperty({
    type: [String],
    minItems: 1,
    maxItems: 20,
    example: ['S', 'M', 'L'],
  })
  @Transform(trimArray)
  @IsArray()
  @ArrayMinSize(1, { message: 'Add at least one option value.' })
  @ArrayMaxSize(20, { message: 'At most 20 option values.' })
  @IsString({ each: true })
  @MinLength(1, { each: true, message: 'Option value is required.' })
  @MaxLength(40, {
    each: true,
    message: 'Option value must be at most 40 characters.',
  })
  values!: string[];
}

export class ProductVariantInputDto {
  @ApiPropertyOptional({
    format: 'uuid',
    description:
      'The id of an existing variant when you are editing it. Leave it out for a new combination.',
  })
  @IsOptional()
  @IsUUID()
  id?: string;

  @ApiProperty({ example: { Size: 'M', Color: 'Black' } })
  @IsObject()
  @Check(
    (v) =>
      typeof v === 'object' &&
      v !== null &&
      Object.values(v).every((x) => typeof x === 'string'),
    'Variant options must map option names to values.',
  )
  options!: Record<string, string>;

  @ApiPropertyOptional({ nullable: true, maxLength: 64 })
  @Sku()
  sku?: string | null;

  @ApiProperty({
    example: '1299.50',
    description:
      'The price as plain decimal text. How many decimal places are allowed depends on the store currency.',
  })
  @MoneyText('Variant price', { required: true, positive: true })
  price!: string;

  @ApiPropertyOptional({ nullable: true, example: '1499.00' })
  @OptionalMoneyText('Compare-at price')
  compareAtPrice?: string | null;

  @ApiProperty({ minimum: 0 })
  @WholeNumber('Variant stock')
  quantity!: number;

  @ApiPropertyOptional({
    nullable: true,
    description: "Where one of this product's images is stored.",
  })
  @IsOptional()
  @IsString()
  @MaxLength(300)
  imagePath?: string | null;

  @ApiPropertyOptional({ default: true })
  @IsOptional()
  @IsBoolean()
  isActive?: boolean;
}

class ProductWritableFields {
  @ApiPropertyOptional({ nullable: true, maxLength: 20000 })
  @OptionalText('Description', 20000)
  description?: string | null;

  @ApiPropertyOptional({ nullable: true, maxLength: 300 })
  @OptionalText('Short description', 300)
  shortDescription?: string | null;

  @ApiPropertyOptional({ nullable: true, maxLength: 80 })
  @OptionalText('Product type', 80)
  productType?: string | null;

  @ApiPropertyOptional({ format: 'uuid', nullable: true })
  @IsOptional()
  @IsUUID('all', { message: 'Please select a valid category.' })
  categoryId?: string | null;

  @ApiPropertyOptional({ type: [String], format: 'uuid', maxItems: 50 })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(50)
  @IsUUID('all', { each: true })
  collectionIds?: string[];

  @ApiPropertyOptional({
    nullable: true,
    maxLength: 64,
    description:
      'The product code (SKU). It is ignored when the product has variants.',
  })
  @Sku()
  sku?: string | null;

  @ApiPropertyOptional({
    nullable: true,
    maxLength: 64,
    description:
      'The part number. It is optional, not unique and independent of the SKU. Send null or an empty text to clear it.',
  })
  @OptionalText('Part number', 64)
  partNumber?: string | null;

  @ApiPropertyOptional({ nullable: true, example: '1299.50' })
  @OptionalMoneyText('Compare-at price')
  compareAtPrice?: string | null;

  @ApiPropertyOptional({ nullable: true, example: '800.00' })
  @OptionalMoneyText('Cost per item')
  cost?: string | null;

  @ApiPropertyOptional({ default: true })
  @IsOptional()
  @IsBoolean()
  trackInventory?: boolean;

  @ApiPropertyOptional({
    minimum: 0,
    default: 0,
    description:
      'How many are in stock. It is ignored when the product has variants.',
  })
  @IsOptional()
  @WholeNumber('Inventory quantity')
  quantity?: number;

  @ApiPropertyOptional({ minimum: 0, default: 5 })
  @IsOptional()
  @WholeNumber('Low-stock threshold')
  lowStockThreshold?: number;

  @ApiPropertyOptional({
    minimum: 0,
    maximum: 1000000,
    default: 0,
    description:
      'Shipping weight in grams (packed, per unit). Needed for weight-based shipping rates.',
  })
  @IsOptional()
  @WholeNumber('Weight', { max: 1_000_000 })
  weightGrams?: number;

  @ApiPropertyOptional({
    nullable: true,
    enum: [0, 25, 300, 500, 1200, 1800, 2800, 4000],
    description:
      'GST rate in basis points (1800 = 18%). Leave out or send null to use the organization default rate.',
  })
  @IsOptional()
  @Type(() => Number)
  @IsInt({ message: 'Choose a GST rate.' })
  @IsIn([0, 25, 300, 500, 1200, 1800, 2800, 4000], {
    message:
      'Choose a valid GST rate: 0%, 0.25%, 3%, 5%, 12%, 18%, 28% or 40%.',
  })
  taxRateBps?: number | null;

  @ApiPropertyOptional({
    nullable: true,
    description: 'HSN (goods) or SAC (services) code: 4, 6 or 8 digits.',
  })
  @IsOptional()
  @Transform(({ value }: { value: unknown }) =>
    typeof value === 'string' ? value.trim() || null : value,
  )
  @Matches(/^(\d{4}|\d{6}|\d{8})$/, {
    message: 'Enter a 4, 6 or 8 digit HSN/SAC code.',
  })
  hsnCode?: string | null;

  @ApiPropertyOptional({ enum: PRODUCT_STATUSES, default: 'draft' })
  @IsOptional()
  @IsIn(PRODUCT_STATUSES, { message: 'Please select a valid status.' })
  status?: (typeof PRODUCT_STATUSES)[number];

  @ApiPropertyOptional({ type: [ProductOptionInputDto], maxItems: 3 })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(3, { message: 'At most 3 options.' })
  @ValidateNested({ each: true })
  @Type(() => ProductOptionInputDto)
  options?: ProductOptionInputDto[];

  @ApiPropertyOptional({
    type: [ProductVariantInputDto],
    maxItems: MAX_VARIANTS,
  })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(MAX_VARIANTS, { message: `At most ${MAX_VARIANTS} variants.` })
  @ValidateNested({ each: true })
  @Type(() => ProductVariantInputDto)
  variants?: ProductVariantInputDto[];

  @ApiPropertyOptional({
    type: [ProductImageInputDto],
    maxItems: MAX_IMAGES_PER_PRODUCT,
    description:
      'The product images in order. The first one is the main image.',
  })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(MAX_IMAGES_PER_PRODUCT, {
    message: `At most ${MAX_IMAGES_PER_PRODUCT} images.`,
  })
  @ValidateNested({ each: true })
  @Type(() => ProductImageInputDto)
  images?: ProductImageInputDto[];
}

export class CreateProductDto extends ProductWritableFields {
  @ApiPropertyOptional({
    format: 'uuid',
    description:
      'An id you create yourself, so you can upload images into `{organizationId}/{id}/` before the product exists. If you leave it out, the server makes one.',
  })
  @IsOptional()
  @IsUUID()
  id?: string;

  @ApiProperty({ maxLength: 200 })
  @RequiredText('Product name', 200)
  name!: string;

  @ApiPropertyOptional({
    description:
      'The short name used in web addresses, 2 to 80 characters long. If you leave it out, a unique one is made from the product name.',
  })
  @CatalogSlug()
  slug?: string;

  @ApiProperty({
    example: '1299.50',
    description:
      'The price as plain decimal text in the store currency. It must be greater than zero.',
  })
  @MoneyText('Price', { required: true, positive: true })
  price!: string;
}

/**
 * Partial update. Omitted fields keep their value. `options`, `variants`, `images` and `collectionIds`, when sent,
 * replace the whole set. The merged result is validated with the same rules as a create.
 */
export class UpdateProductDto extends ProductWritableFields {
  @ApiPropertyOptional({ maxLength: 200 })
  @WhenPresent()
  @RequiredText('Product name', 200)
  name?: string;

  @ApiPropertyOptional()
  @CatalogSlug()
  slug?: string;

  @ApiPropertyOptional({ example: '1299.50' })
  @WhenPresent()
  @MoneyText('Price', { required: true, positive: true })
  price?: string;
}

export class BulkDeleteProductsDto {
  @ApiProperty({ type: [String], format: 'uuid', minItems: 1, maxItems: 100 })
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(100)
  @IsUUID('all', { each: true })
  ids!: string[];
}

export class BulkProductStatusDto extends BulkDeleteProductsDto {
  @ApiProperty({ enum: PRODUCT_STATUSES })
  @IsIn(PRODUCT_STATUSES, { message: 'Please select a valid status.' })
  status!: (typeof PRODUCT_STATUSES)[number];
}

export class ProductListQueryDto extends PaginationQueryDto {
  @ApiPropertyOptional({
    enum: ['createdAt', 'name', 'price'],
    default: 'createdAt',
  })
  @IsOptional()
  @IsIn(['createdAt', 'name', 'price'])
  sortBy: 'createdAt' | 'name' | 'price' = 'createdAt';

  @ApiPropertyOptional({ enum: ['all', ...PRODUCT_STATUSES], default: 'all' })
  @IsOptional()
  @IsIn(['all', ...PRODUCT_STATUSES])
  status: 'all' | (typeof PRODUCT_STATUSES)[number] = 'all';

  @ApiPropertyOptional({
    default: 'all',
    description:
      'A category id to show only that category, `none` for products without a category, or `all` to show every product.',
  })
  @IsOptional()
  @Check(
    (v) =>
      v === 'all' ||
      v === 'none' ||
      (typeof v === 'string' &&
        /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
          v,
        )),
    'category must be a category id, "none" or "all".',
  )
  category: string = 'all';

  @ApiPropertyOptional({
    enum: ['all', 'in', 'low', 'out', 'untracked'],
    default: 'all',
  })
  @IsOptional()
  @IsIn(['all', 'in', 'low', 'out', 'untracked'])
  stock: 'all' | 'in' | 'low' | 'out' | 'untracked' = 'all';
}

export { DEFAULT_PAGE_SIZE };
