import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  ParseUUIDPipe,
  Post,
  Put,
  Query,
} from '@nestjs/common';
import { ApiParam, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { ApiEndpoint } from '../../common/decorators/api-endpoint.decorator.js';
import {
  CurrentOrg,
  OrgScoped,
  RequirePermission,
} from '../../common/decorators/decorators.js';
import type { OrgContext } from '../../common/interfaces/request-context.js';
import {
  ProductPresentationDto,
  ProductPresentationListQueryDto,
  ProductPresentationSummaryDto,
  PublishProductPresentationDto,
  PublishProductPresentationResultDto,
  SaveProductPresentationDto,
} from './product-presentations.dto.js';
import { ProductPresentationsService } from './product-presentations.service.js';

@ApiTags('store-design')
@Controller('store/product-presentations')
@OrgScoped()
export class ProductPresentationsController {
  constructor(private readonly presentations: ProductPresentationsService) {}

  @Get()
  @RequirePermission('design:view')
  @ApiEndpoint({
    summary: 'List customized products',
    description:
      'List the products that have their own design settings, with their revision and whether the settings are a draft, live, or live with newer unpublished changes. Only product ids are returned; products without an entry use the default store design.',
    auth: 'org',
    permission: 'dashboard:view',
    response: [ProductPresentationSummaryDto],
    paginated: true,
    message: 'Customized products retrieved successfully',
  })
  list(
    @CurrentOrg() org: OrgContext,
    @Query() query: ProductPresentationListQueryDto,
  ) {
    return this.presentations.list(org, query);
  }

  @Get(':productId')
  @RequirePermission('design:view')
  @ApiParam({ name: 'productId', format: 'uuid' })
  @ApiEndpoint({
    summary: "Open one product's design settings",
    description:
      'Get the draft and the live settings of a product together with the revision. A product that was never customized returns the default settings with revision 0 and state `default`. Send the revision back when you save.',
    auth: 'org',
    permission: 'dashboard:view',
    response: ProductPresentationDto,
    message: 'Product design retrieved successfully',
    errors: [404],
  })
  get(
    @CurrentOrg() org: OrgContext,
    @Param('productId', ParseUUIDPipe) productId: string,
  ) {
    return this.presentations.get(org, productId);
  }

  @Put(':productId/draft')
  @RequirePermission('design:edit')
  @Throttle({ default: { limit: 120, ttl: 60_000 } })
  @ApiParam({ name: 'productId', format: 'uuid' })
  @ApiEndpoint({
    summary: "Save a product's design draft",
    description:
      'Save the settings for one product without publishing. Send the whole document and the revision you started from (0 for a product without settings yet). If someone else saved first you get a 409 and nothing is overwritten. Unsupported settings are rejected, listed by field. Shoppers keep seeing the published settings.',
    auth: 'org',
    permission: 'store:manage',
    body: SaveProductPresentationDto,
    response: ProductPresentationDto,
    message: 'Draft saved successfully',
    errors: [400, 404, 409],
  })
  saveDraft(
    @CurrentOrg() org: OrgContext,
    @Param('productId', ParseUUIDPipe) productId: string,
    @Body() dto: SaveProductPresentationDto,
  ) {
    return this.presentations.saveDraft(org, productId, dto);
  }

  @Post(':productId/publish')
  @RequirePermission('design:publish')
  @Throttle({ default: { limit: 20, ttl: 60_000 } })
  @ApiParam({ name: 'productId', format: 'uuid' })
  @ApiEndpoint({
    summary: "Publish a product's design",
    description:
      'Make the draft settings of this product live. If the draft already matches what shoppers see, nothing changes and `published` is false. A product with no settings returns 404.',
    auth: 'org',
    permission: 'store:manage',
    body: PublishProductPresentationDto,
    response: PublishProductPresentationResultDto,
    message: 'Product design published successfully',
    errors: [400, 404, 409],
  })
  publish(
    @CurrentOrg() org: OrgContext,
    @Param('productId', ParseUUIDPipe) productId: string,
    @Body() dto: PublishProductPresentationDto,
  ) {
    return this.presentations.publish(org, productId, dto);
  }

  @Delete(':productId')
  @RequirePermission('design:edit')
  @Throttle({ default: { limit: 20, ttl: 60_000 } })
  @ApiParam({ name: 'productId', format: 'uuid' })
  @ApiEndpoint({
    summary: 'Reset a product to the default design',
    description:
      'Remove the settings of this product, draft and live. The change is immediate: the storefront goes back to the store design for this product without a publish step. Removing settings that do not exist is not an error. Product details are not touched.',
    auth: 'org',
    permission: 'store:manage',
    response: ProductPresentationDto,
    message: 'Product design reset successfully',
    errors: [404],
  })
  reset(
    @CurrentOrg() org: OrgContext,
    @Param('productId', ParseUUIDPipe) productId: string,
  ) {
    return this.presentations.reset(org, productId);
  }
}
