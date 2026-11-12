import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
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
  CollectionDetailDto,
  CollectionDto,
  CreateCollectionDto,
  ProductOptionChoiceDto,
  UpdateCollectionDto,
} from './collections.dto.js';
import { CollectionsService } from './collections.service.js';

@ApiTags('collections')
@Controller('collections')
@OrgScoped()
export class CollectionsController {
  constructor(private readonly collections: CollectionsService) {}

  @Get()
  @RequirePermission('catalog:view')
  @ApiEndpoint({
    summary: 'List collections',
    description:
      'See all the collections in your store, sorted by name. Each one shows how many products it contains. The full list is returned at once, with no pages.',
    auth: 'org',
    permission: 'catalog:view',
    response: [CollectionDto],
    message: 'Collections retrieved successfully',
  })
  list(@CurrentOrg() org: OrgContext) {
    return this.collections.list(org);
  }

  // Declared before `:id` so "product-options" is never read as an id.
  @Get('product-options')
  @RequirePermission('catalog:view')
  @ApiEndpoint({
    summary: 'List products to pick from',
    description:
      'Get a simple list of products (just the id and name) to show in the picker when you build or edit a collection. The list is sorted by name and holds at most 500 products.',
    auth: 'org',
    permission: 'catalog:view',
    response: [ProductOptionChoiceDto],
    message: 'Product choices retrieved successfully',
  })
  productOptions(@CurrentOrg() org: OrgContext) {
    return this.collections.productOptions(org);
  }

  @Get(':id')
  @RequirePermission('catalog:view')
  @ApiParam({ name: 'id', format: 'uuid' })
  @ApiEndpoint({
    summary: 'View one collection',
    description:
      'Get the details of a single collection, along with the ids of the products inside it, in the order they were arranged.',
    auth: 'org',
    permission: 'catalog:view',
    response: CollectionDetailDto,
    message: 'Collection retrieved successfully',
    errors: [404],
  })
  get(@CurrentOrg() org: OrgContext, @Param('id', ParseUUIDPipe) id: string) {
    return this.collections.get(org, id);
  }

  @Post()
  @RequirePermission('catalog:manage')
  @ApiEndpoint({
    summary: 'Add a collection',
    description:
      'Create a new collection, which is a hand-picked group of products. A cover image is optional, but it has to be uploaded first (see POST /uploads/signed-urls) into the folder `{organizationId}/collections/{id}/`. Every product you add must belong to your store.',
    auth: 'org',
    permission: 'catalog:manage',
    body: CreateCollectionDto,
    response: CollectionDetailDto,
    status: 201,
    message: 'Collection created successfully',
    errors: [409],
  })
  create(
    @CurrentOrg() org: OrgContext,
    @CurrentUser() user: AuthUser,
    @Body() dto: CreateCollectionDto,
  ) {
    return this.collections.create(org, user, dto);
  }

  @Patch(':id')
  @RequirePermission('catalog:manage')
  @ApiParam({ name: 'id', format: 'uuid' })
  @ApiEndpoint({
    summary: 'Edit a collection',
    description:
      'Change a collection. Send only the fields you want to change and the rest stay as they are. If you send `productIds`, that list replaces all the products currently in the collection. If you swap the cover image, the old file is deleted afterwards, unless something else is still using it.',
    auth: 'org',
    permission: 'catalog:manage',
    body: UpdateCollectionDto,
    response: CollectionDetailDto,
    message: 'Collection updated successfully',
    errors: [404, 409],
  })
  update(
    @CurrentOrg() org: OrgContext,
    @CurrentUser() user: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateCollectionDto,
  ) {
    return this.collections.update(org, user, id, dto);
  }

  @Delete(':id')
  @RequirePermission('catalog:delete')
  @ApiParam({ name: 'id', format: 'uuid' })
  @ApiEndpoint({
    summary: 'Remove a collection',
    description:
      'Delete a collection. The products in it are not deleted. Its cover image file is also deleted, unless something else is still using it.',
    auth: 'org',
    permission: 'catalog:delete',
    response: null,
    message: 'Collection deleted successfully',
    errors: [404],
  })
  async remove(
    @CurrentOrg() org: OrgContext,
    @CurrentUser() user: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    await this.collections.remove(org, user, id);
  }
}
