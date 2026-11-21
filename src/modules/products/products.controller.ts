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
import { ImportProductsDto, ImportResultDto } from './product-import.dto.js';
import { ProductImportService } from './product-import.service.js';
import { ProductsService } from './products.service.js';

@ApiTags('products')
@Controller('products')
@OrgScoped()
export class ProductsController {
  constructor(
    private readonly products: ProductsService,
    private readonly importer: ProductImportService,
  ) {}

  @Get()
  @RequirePermission('catalog:view')
  @ApiEndpoint({
    summary: 'List products',
    description:
      'See the products in your store, a page at a time. You can search by product name or SKU (the product code), filter by status, category or stock level, and sort the results. Searching, filtering and paging are all done by the server, so only the page you asked for is sent back. For example: `GET /products?page=1&limit=20&search=tee&status=active&stock=low&sortBy=price&sortOrder=asc`.',
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
    summary: 'View one product',
    description:
      'Get everything about a single product: its options (such as size or color), its variants (each size and color combination), its images, and the collections it belongs to.',
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
    summary: 'Add a product',
    description:
      'Create a new product together with its options, images, variants and collections. Everything is saved in one go, so if anything fails, nothing is saved. The first image in the list becomes the main image. Send prices as plain decimal text (for example `"19.99"`). They are read using the number of decimal places of your store currency and saved in the currency\'s smallest unit (for example cents). The uploaded image files are checked again in storage before they are accepted.',
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

  @Post('import')
  @RequirePermission('catalog:manage')
  @ApiEndpoint({
    summary: 'Import products from rows',
    description:
      'Create up to 500 simple products at once from rows read from a CSV or Excel file. Every row is checked first; if any row has a problem, nothing is created and the response lists each problem with its row, column, message and value. If every row is fine, all products are created in one go, or none are. Categories and subcategories must already exist and are matched by name or handle. All products created by one import share the same creation time, so their relative order by creation time is not guaranteed.',
    auth: 'org',
    permission: 'catalog:manage',
    body: ImportProductsDto,
    response: ImportResultDto,
    status: 201,
    message: 'Products imported successfully',
    errors: [409],
  })
  importProducts(
    @CurrentOrg() org: OrgContext,
    @Body() dto: ImportProductsDto,
  ) {
    return this.importer.import(org, dto);
  }

  // Bulk routes are declared before `:id` routes with the same verb so their literal segment wins.
  @Post('bulk-delete')
  @RequirePermission('catalog:delete')
  @ApiEndpoint({
    summary: 'Remove several products',
    description:
      'Delete many products at once, up to 100 per request. Ids that belong to another organization are ignored. Afterwards, the image files of the deleted products are also removed, unless something else is still using them.',
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
    description:
      'Change the status of many products at once, up to 100 per request. Set the status to `active` to publish them or `draft` to hide them. Products from other organizations are not touched.',
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
    summary: 'Copy a product',
    description:
      'Make a copy of a product, saved as a draft so it is not visible in your storefront yet. The copy gets its own name and web address, and keeps the options and variants of the original. SKUs (product codes) are cleared so they stay unique, and images are not copied.',
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
    summary: 'Edit a product',
    description:
      'Change a product. Send only the fields you want to change and the rest stay as they are. If you send `options`, `variants`, `images` or `collectionIds`, the list you send replaces the whole existing list. The final result is checked with the same rules as when adding a product. Image files that you remove are deleted afterwards, unless something else is still using them.',
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
    summary: 'Remove a product',
    description:
      'Delete one product. Its image files are deleted too, unless something else is still using them.',
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
