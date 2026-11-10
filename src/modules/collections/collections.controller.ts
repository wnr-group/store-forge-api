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
      'All collections of the organization by name, with product counts. Not paginated.',
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
    summary: 'Products to choose from when building a collection',
    description: 'Ids and names of up to 500 products, by name.',
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
    summary: 'Get a collection with its product ids',
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
    summary: 'Create a collection',
    description:
      'The optional image must already be uploaded (see POST /uploads/signed-urls) under `{organizationId}/collections/{id}/`. Every product must belong to the organization.',
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
    summary: 'Update a collection',
    description:
      'Partial update. `productIds`, when sent, replaces the whole product list; a replaced image file is removed afterwards if nothing else references it.',
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
    summary: 'Delete a collection',
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
