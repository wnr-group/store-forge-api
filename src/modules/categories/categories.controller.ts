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
      'All categories of the organization by name, with product counts. Not paginated.',
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
    summary: 'Get a category',
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
    summary: 'Create a category',
    description:
      'A category cannot be its own ancestor. The slug defaults to a slug of the name.',
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
    summary: 'Update a category',
    description:
      'Partial update. Moving a category under itself or one of its descendants is refused.',
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
    summary: 'Delete a category',
    description:
      'Products in the category become uncategorised; child categories become top-level.',
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
