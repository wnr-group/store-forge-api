import {
  Body,
  Controller,
  Get,
  Param,
  ParseUUIDPipe,
  Put,
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
import { SetRecommendationsDto } from './recommendations.dto.js';
import { RecommendationsService } from './recommendations.service.js';

@ApiTags('products')
@Controller('store/products/:productId/recommendations')
@OrgScoped()
export class RecommendationsController {
  constructor(
    private readonly recommendationsService: RecommendationsService,
  ) {}

  @Get()
  @RequirePermission('catalog:view')
  @ApiParam({ name: 'productId', format: 'uuid' })
  @ApiEndpoint({
    summary: 'Get merchant-picked product recommendations',
    description:
      'List the merchant-picked product recommendations configured for a product.',
    auth: 'org',
    permission: 'catalog:view',
    message: 'Product recommendations retrieved successfully',
    errors: [403, 404],
  })
  getRecommendations(
    @CurrentOrg() org: OrgContext,
    @Param('productId', ParseUUIDPipe) productId: string,
  ) {
    return this.recommendationsService.getRecommendations(org, productId);
  }

  @Put()
  @RequirePermission('catalog:manage')
  @ApiParam({ name: 'productId', format: 'uuid' })
  @ApiEndpoint({
    summary: 'Configure merchant-picked product recommendations',
    description:
      'Set or update the merchant-picked recommendations for a product. Self-recommendation is forbidden.',
    auth: 'org',
    permission: 'catalog:manage',
    body: SetRecommendationsDto,
    message: 'Product recommendations saved successfully',
    errors: [400, 403, 404],
  })
  setRecommendations(
    @CurrentOrg() org: OrgContext,
    @CurrentUser() user: AuthUser,
    @Param('productId', ParseUUIDPipe) productId: string,
    @Body() dto: SetRecommendationsDto,
  ) {
    return this.recommendationsService.setRecommendations(
      org,
      user,
      productId,
      dto,
    );
  }
}
