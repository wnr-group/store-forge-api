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
import { CreatePageDto, StorePageDto, UpdatePageDto } from './pages.dto.js';
import { PagesService } from './pages.service.js';

@ApiTags('store-design')
@Controller('store/pages')
@OrgScoped()
export class PagesController {
  constructor(private readonly pages: PagesService) {}

  @Get()
  @RequirePermission('dashboard:view')
  @ApiEndpoint({
    summary: 'List content pages',
    description:
      'See the content pages of your store (About, Contact, policies...), drafts included, sorted by title.',
    auth: 'org',
    permission: 'dashboard:view',
    response: [StorePageDto],
    message: 'Pages retrieved successfully',
  })
  list(@CurrentOrg() org: OrgContext) {
    return this.pages.list(org);
  }

  @Get(':id')
  @RequirePermission('dashboard:view')
  @ApiParam({ name: 'id', format: 'uuid' })
  @ApiEndpoint({
    summary: 'View one content page',
    description: 'Get one content page of your store, draft or published.',
    auth: 'org',
    permission: 'dashboard:view',
    response: StorePageDto,
    message: 'Page retrieved successfully',
    errors: [404],
  })
  get(@CurrentOrg() org: OrgContext, @Param('id', ParseUUIDPipe) id: string) {
    return this.pages.get(org, id);
  }

  @Post()
  @RequirePermission('store:manage')
  @ApiEndpoint({
    summary: 'Add a content page',
    description:
      'Create a page such as About or Contact. It stays a draft until you publish it; only published pages are visible to shoppers, at `/<address>` on your store.',
    auth: 'org',
    permission: 'store:manage',
    body: CreatePageDto,
    response: StorePageDto,
    status: 201,
    message: 'Page created successfully',
    errors: [409],
  })
  create(@CurrentOrg() org: OrgContext, @Body() dto: CreatePageDto) {
    return this.pages.create(org, dto);
  }

  @Patch(':id')
  @RequirePermission('store:manage')
  @ApiParam({ name: 'id', format: 'uuid' })
  @ApiEndpoint({
    summary: 'Change a content page',
    description:
      'Change the title, address, content or status of a page. Set the status to `published` to show it to shoppers, or back to `draft` to hide it.',
    auth: 'org',
    permission: 'store:manage',
    body: UpdatePageDto,
    response: StorePageDto,
    message: 'Page updated successfully',
    errors: [404, 409],
  })
  update(
    @CurrentOrg() org: OrgContext,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdatePageDto,
  ) {
    return this.pages.update(org, id, dto);
  }

  @Delete(':id')
  @RequirePermission('store:manage')
  @ApiParam({ name: 'id', format: 'uuid' })
  @ApiEndpoint({
    summary: 'Remove a content page',
    description:
      'Delete a content page. Products, collections and the theme design are not affected.',
    auth: 'org',
    permission: 'store:manage',
    response: null,
    message: 'Page deleted successfully',
    errors: [404],
  })
  async remove(
    @CurrentOrg() org: OrgContext,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    await this.pages.remove(org, id);
  }
}
