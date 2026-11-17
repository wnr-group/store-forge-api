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
  OrgScoped,
  RequirePermission,
} from '../../common/decorators/decorators.js';
import type { OrgContext } from '../../common/interfaces/request-context.js';
import {
  CategoryDto,
  CreateCategoryDto,
  UpdateCategoryDto,
} from './categories.dto.js';
import { CategoriesService } from './categories.service.js';

@ApiTags('categories')
@Controller('categories')
@OrgScoped()
export class CategoriesController {
  constructor(private readonly categories: CategoriesService) {}

  @Get()
  @RequirePermission('catalog:view')
  @ApiEndpoint({
    summary: 'List categories',
    description:
      'See all the categories in your store, sorted by name. Each one shows how many products it holds. The full list is returned at once, with no pages.',
    auth: 'org',
    permission: 'catalog:view',
    response: [CategoryDto],
    message: 'Categories retrieved successfully',
  })
  list(@CurrentOrg() org: OrgContext) {
    return this.categories.list(org);
  }

  @Get(':id')
  @RequirePermission('catalog:view')
  @ApiParam({ name: 'id', format: 'uuid' })
  @ApiEndpoint({
    summary: 'View one category',
    description:
      'Get the details of a single category, including how many products are in it and the name of its parent category (if it has one).',
    auth: 'org',
    permission: 'catalog:view',
    response: CategoryDto,
    message: 'Category retrieved successfully',
    errors: [404],
  })
  get(@CurrentOrg() org: OrgContext, @Param('id', ParseUUIDPipe) id: string) {
    return this.categories.get(org, id);
  }

  @Post()
  @RequirePermission('catalog:manage')
  @ApiEndpoint({
    summary: 'Add a category',
    description:
      'Add a new category to your store. If you do not give a slug (the short, web-address-friendly name), one is made from the category name. A category can be placed inside another one, but it can never end up inside itself.',
    auth: 'org',
    permission: 'catalog:manage',
    body: CreateCategoryDto,
    response: CategoryDto,
    status: 201,
    message: 'Category created successfully',
    errors: [409],
  })
  create(@CurrentOrg() org: OrgContext, @Body() dto: CreateCategoryDto) {
    return this.categories.create(org, dto);
  }

  @Patch(':id')
  @RequirePermission('catalog:manage')
  @ApiParam({ name: 'id', format: 'uuid' })
  @ApiEndpoint({
    summary: 'Edit a category',
    description:
      'Change a category. Send only the fields you want to change and the rest stay as they are. You cannot move a category inside itself or inside one of its own sub-categories, and such a request is refused.',
    auth: 'org',
    permission: 'catalog:manage',
    body: UpdateCategoryDto,
    response: CategoryDto,
    message: 'Category updated successfully',
    errors: [404, 409],
  })
  update(
    @CurrentOrg() org: OrgContext,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateCategoryDto,
  ) {
    return this.categories.update(org, id, dto);
  }

  @Delete(':id')
  @RequirePermission('catalog:delete')
  @ApiParam({ name: 'id', format: 'uuid' })
  @ApiEndpoint({
    summary: 'Remove a category',
    description:
      'Delete a category. The products in it are not deleted, they simply end up with no category. Any sub-categories move up and become top-level categories.',
    auth: 'org',
    permission: 'catalog:delete',
    response: null,
    message: 'Category deleted successfully',
    errors: [404],
  })
  async remove(
    @CurrentOrg() org: OrgContext,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    await this.categories.remove(org, id);
  }
}
