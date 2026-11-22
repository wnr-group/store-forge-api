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
  OrgScoped,
  RequirePermission,
} from '../../common/decorators/decorators.js';
import type { OrgContext } from '../../common/interfaces/request-context.js';
import {
  CreateReviewDto,
  ReviewDto,
  ReviewFilterQueryDto,
  ReviewImportRequestDto,
  ReviewImportResponseDto,
  UpdateReviewDto,
} from './reviews.dto.js';
import { ReviewsService } from './reviews.service.js';

@ApiTags('reviews')
@Controller('reviews')
@OrgScoped()
export class ReviewsController {
  constructor(private readonly reviewsService: ReviewsService) {}

  @Get()
  @RequirePermission('catalog:view')
  @ApiEndpoint({
    summary: 'List reviews for the store',
    description:
      'Returns paginated reviews matching filter options. Requires products read.',
    auth: 'org',
    response: [ReviewDto],
    message: 'Reviews retrieved successfully',
  })
  list(@CurrentOrg() org: OrgContext, @Query() query: ReviewFilterQueryDto) {
    return this.reviewsService.list(org, query);
  }

  @Get('import-template')
  @RequirePermission('catalog:view')
  @ApiEndpoint({
    summary: 'Get review CSV import template',
    description: 'Returns the CSV header row for merchant review bulk import.',
    auth: 'org',
    message: 'Template generated successfully',
  })
  getTemplate() {
    return { template: this.reviewsService.getImportTemplate() };
  }

  @Post('import')
  @RequirePermission('catalog:manage')
  @ApiEndpoint({
    summary: 'Import reviews from CSV',
    description:
      'Imports or validates reviews. In validate-only mode, checks all rows without inserting. In real mode, requires an attestation ID and executes all-or-nothing.',
    auth: 'org',
    response: ReviewImportResponseDto,
    message: 'Reviews import processed successfully',
  })
  importReviews(
    @CurrentOrg() org: OrgContext,
    @Body() dto: ReviewImportRequestDto,
  ) {
    return this.reviewsService.importReviews(org, dto);
  }

  @Post()
  @RequirePermission('catalog:manage')
  @ApiEndpoint({
    summary: 'Create a new review',
    description:
      'Creates a merchant-entered review for a product in this store. Requires products write.',
    auth: 'org',
    response: ReviewDto,
    message: 'Review created successfully',
  })
  create(@CurrentOrg() org: OrgContext, @Body() dto: CreateReviewDto) {
    return this.reviewsService.create(org, dto);
  }

  @Patch(':id')
  @RequirePermission('catalog:manage')
  @ApiParam({ name: 'id' })
  @ApiEndpoint({
    summary: 'Update a review',
    description:
      'Updates review text, rating, or status. Requires products write.',
    auth: 'org',
    response: ReviewDto,
    message: 'Review updated successfully',
  })
  update(
    @CurrentOrg() org: OrgContext,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateReviewDto,
  ) {
    return this.reviewsService.update(org, id, dto);
  }

  @Post(':id/publish')
  @RequirePermission('catalog:manage')
  @ApiParam({ name: 'id' })
  @ApiEndpoint({
    summary: 'Publish a review',
    description:
      'Sets review status to published so it appears on storefronts.',
    auth: 'org',
    response: ReviewDto,
    message: 'Review published successfully',
  })
  publish(
    @CurrentOrg() org: OrgContext,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return this.reviewsService.setStatus(org, id, 'published');
  }

  @Post(':id/unpublish')
  @RequirePermission('catalog:manage')
  @ApiParam({ name: 'id' })
  @ApiEndpoint({
    summary: 'Unpublish a review',
    description:
      'Sets review status to unpublished so it is hidden from storefronts.',
    auth: 'org',
    response: ReviewDto,
    message: 'Review unpublished successfully',
  })
  unpublish(
    @CurrentOrg() org: OrgContext,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return this.reviewsService.setStatus(org, id, 'unpublished');
  }

  @Delete(':id')
  @RequirePermission('catalog:delete')
  @ApiParam({ name: 'id' })
  @ApiEndpoint({
    summary: 'Delete a review',
    description: 'Permanently deletes a review. Requires products delete.',
    auth: 'org',
    message: 'Review deleted successfully',
  })
  delete(
    @CurrentOrg() org: OrgContext,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return this.reviewsService.delete(org, id);
  }
}
