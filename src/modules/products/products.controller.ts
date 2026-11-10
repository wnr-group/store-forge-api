import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
} from '@nestjs/common';
import { ApiParam, ApiTags } from '@nestjs/swagger';
import { ApiEndpoint } from '../../common/decorators/api-endpoint.decorator.js';
import {
  CurrentOrg,
  CurrentUser,
  OrgScoped,
  RequirePermission,
} from '../../common/decorators/decorators.js';
import type {
  AuthUser,
  OrgContext,
} from '../../common/interfaces/request-context.js';
import {
  BulkCountDto,
  BulkDeleteProductsDto,
  BulkProductStatusDto,
  CreateProductDto,
  ProductDetailDto,
  ProductListItemDto,
  ProductListQueryDto,
  UpdateProductDto,
} from './products.dto.js';
import { ProductsService } from './products.service.js';

@ApiTags('products')
@Controller('products')
@OrgScoped()
export class ProductsController {
  constructor(private readonly products: ProductsService) {}

  @Get()
  @RequirePermission('catalog:view')
  @ApiEndpoint({
    summary: 'List products',
    description:
      'Server-side search (name / SKU), filters (status, category, stock level), sorting and pagination. `GET /products?page=1&limit=20&search=tee&status=active&stock=low&sortBy=price&sortOrder=asc`.',
    auth: 'org',
    permission: 'catalog:view',
    response: [ProductListItemDto],
    paginated: true,
    message: 'Products retrieved successfully',
  })
  list(@CurrentOrg() org: OrgContext, @Query() query: ProductListQueryDto) {
    return this.products.list(org, query);
  }

  @Get(':id')
  @RequirePermission('catalog:view')
  @ApiParam({ name: 'id', format: 'uuid' })
  @ApiEndpoint({
    summary: 'Get a product with options, variants, images and collections',
    auth: 'org',
    permission: 'catalog:view',
    response: ProductDetailDto,
    message: 'Product retrieved successfully',
    errors: [404],
  })
  get(@CurrentOrg() org: OrgContext, @Param('id', ParseUUIDPipe) id: string) {
    return this.products.get(org, id);
  }

  @Post()
  @RequirePermission('catalog:manage')
  @ApiEndpoint({
    summary: 'Create a product',
    description:
      "Everything is saved in one transaction: product, options, images (the first is primary), variants and collections. Prices are decimal text parsed with the store currency's decimals and stored in minor units. Uploaded image paths are re-verified against the bucket.",
    auth: 'org',
    permission: 'catalog:manage',
    body: CreateProductDto,
    response: ProductDetailDto,
    status: 201,
    message: 'Product created successfully',
    errors: [404, 409],
  })
  create(
    @CurrentOrg() org: OrgContext,
    @CurrentUser() user: AuthUser,
    @Body() dto: CreateProductDto,
  ) {
    return this.products.create(org, user, dto);
  }

  // Bulk routes are declared before `:id` routes with the same verb so their literal segment wins.
  @Post('bulk-delete')
  @RequirePermission('catalog:delete')
  @ApiEndpoint({
    summary: 'Delete several products',
    description:
      'Up to 100 ids. Ids from other organizations are ignored. Image files are removed afterwards if nothing else references them.',
    auth: 'org',
    permission: 'catalog:delete',
    body: BulkDeleteProductsDto,
    response: BulkCountDto,
    message: 'Products deleted successfully',
  })
  async bulkDelete(
    @CurrentOrg() org: OrgContext,
    @CurrentUser() user: AuthUser,
    @Body() dto: BulkDeleteProductsDto,
  ) {
    return { count: await this.products.remove(org, user, dto.ids) };
  }

  @Post('bulk-status')
  @RequirePermission('catalog:manage')
  @ApiEndpoint({
    summary: 'Publish or unpublish several products',
    auth: 'org',
    permission: 'catalog:manage',
    body: BulkProductStatusDto,
    response: BulkCountDto,
    message: 'Products updated successfully',
  })
  bulkStatus(@CurrentOrg() org: OrgContext, @Body() dto: BulkProductStatusDto) {
    return this.products.setStatus(org, dto.ids, dto.status);
  }

  @Post(':id/duplicate')
  @RequirePermission('catalog:manage')
  @ApiParam({ name: 'id', format: 'uuid' })
  @ApiEndpoint({
    summary: 'Duplicate a product as a draft',
    description:
      'Copies options and variants; SKUs are cleared and images are not copied.',
    auth: 'org',
    permission: 'catalog:manage',
    response: ProductDetailDto,
    status: 201,
    message: 'Product duplicated successfully',
    errors: [404],
  })
  duplicate(
    @CurrentOrg() org: OrgContext,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return this.products.duplicate(org, id);
  }

  @Patch(':id')
  @RequirePermission('catalog:manage')
  @ApiParam({ name: 'id', format: 'uuid' })
  @ApiEndpoint({
    summary: 'Update a product',
    description:
      'Partial update: omitted fields keep their value; `options`, `variants`, `images` and `collectionIds`, when sent, replace the whole set. The merged result is validated like a create. Removed image files are deleted afterwards if nothing else references them.',
    auth: 'org',
    permission: 'catalog:manage',
    body: UpdateProductDto,
    response: ProductDetailDto,
    message: 'Product updated successfully',
    errors: [404, 409],
  })
  update(
    @CurrentOrg() org: OrgContext,
    @CurrentUser() user: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateProductDto,
  ) {
    return this.products.update(org, user, id, dto);
  }

  @Delete(':id')
  @RequirePermission('catalog:delete')
  @ApiParam({ name: 'id', format: 'uuid' })
  @ApiEndpoint({
    summary: 'Delete a product',
    auth: 'org',
    permission: 'catalog:delete',
    response: null,
    message: 'Product deleted successfully',
    errors: [404],
  })
  async remove(
    @CurrentOrg() org: OrgContext,
    @CurrentUser() user: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    await this.products.removeOne(org, user, id);
  }
}
