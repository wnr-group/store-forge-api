import { Controller, Get, Param, ParseUUIDPipe, Query } from '@nestjs/common';
import { ApiParam, ApiTags } from '@nestjs/swagger';
import { ApiEndpoint } from '../../../common/decorators/api-endpoint.decorator.js';
import {
  CurrentOrg,
  CurrentUser,
  OrgScoped,
  RequirePermission,
} from '../../../common/decorators/decorators.js';
import type {
  AuthUser,
  OrgContext,
} from '../../../common/interfaces/request-context.js';
import { StorageService } from '../../storage/storage.service.js';
import { TemplateImageItemDto, TemplateImagesQueryDto } from '../dto/index.js';

@ApiTags('template-images')
@Controller()
@OrgScoped()
export class TemplateImagesController {
  constructor(private readonly storage: StorageService) {}

  @Get('template-images')
  @RequirePermission('store:manage')
  @ApiEndpoint({
    summary: 'List images for the tenant from products storage bucket',
    auth: 'org',
    permission: 'store:manage',
    response: [TemplateImageItemDto],
    message: 'Images retrieved successfully',
  })
  async listImages(
    @CurrentOrg() org: OrgContext,
    @CurrentUser() user: AuthUser,
    @Query() query: TemplateImagesQueryDto,
  ) {
    const page = query.page ?? 1;
    const pageSize = query.pageSize ?? 20;
    // Strictly isolate by tenant prefix
    const prefix = `${org.tenantId}`;
    return this.storage.listImages(user.token, prefix, page, pageSize);
  }

  @Get('stores/:storeId/template-images')
  @RequirePermission('store:manage')
  @ApiParam({ name: 'storeId', format: 'uuid' })
  @ApiEndpoint({
    summary: 'List images for a store from products storage bucket',
    auth: 'org',
    permission: 'store:manage',
    response: [TemplateImageItemDto],
    message: 'Images retrieved successfully',
  })
  async listStoreImages(
    @CurrentOrg() org: OrgContext,
    @CurrentUser() user: AuthUser,
    @Param('storeId', ParseUUIDPipe) storeId: string,
    @Query() query: TemplateImagesQueryDto,
  ) {
    const page = query.page ?? 1;
    const pageSize = query.pageSize ?? 20;
    // Isolate by tenant and store prefix
    const prefix = `${org.tenantId}/${storeId}`;
    return this.storage.listImages(user.token, prefix, page, pageSize);
  }
}
