import { Controller, Get, Param, Query } from '@nestjs/common';
import { ApiParam, ApiQuery, ApiTags } from '@nestjs/swagger';
import { ApiEndpoint } from '../../common/decorators/api-endpoint.decorator.js';
import { Public } from '../../common/decorators/decorators.js';
import { invalid } from '../../common/app.exception.js';
import {
  PublicBrandingDto,
  PublicCollectionDto,
  PublicLayoutDto,
  StorefrontDto,
} from './public.dto.js';
import { PublicService } from './public.service.js';

@ApiTags('public')
@Controller('public')
@Public()
export class PublicController {
  constructor(private readonly publicService: PublicService) {}

  @Get('branding')
  @ApiEndpoint({
    summary: 'Get the platform name and support email',
    description:
      'Get the platform name and the support email address to show on pages anyone can open, such as the sign-in page and the "no workspace" page. No sign-in is needed. If the database cannot be reached, standard default values are returned instead of an error.',
    auth: 'public',
    response: PublicBrandingDto,
    message: 'Branding retrieved successfully',
  })
  branding() {
    return this.publicService.branding();
  }

  @Get('storefronts/:slug')
  @ApiParam({ name: 'slug', example: 'acme-store' })
  @ApiEndpoint({
    summary: 'View a public storefront',
    description:
      "Get the information a shopper sees on a store's public page: the store details, its latest products and its look. Anyone can call it without signing in. If the store does not exist, is inactive, or its organization is suspended, you get a 404 error in every case, so nobody can tell those situations apart.",
    auth: 'public',
    response: StorefrontDto,
    message: 'Storefront retrieved successfully',
    errors: [404],
  })
  storefront(@Param('slug') slug: string) {
    return this.publicService.storefront(slug.toLowerCase());
  }

  @Get('storefronts/:slug/layout')
  @ApiParam({ name: 'slug', example: 'acme-store' })
  @ApiQuery({
    name: 'kind',
    enum: ['index', 'product', 'collection'],
    required: false,
  })
  @ApiQuery({
    name: 'resource',
    required: false,
    description: 'Product or collection slug, for the page assigned to it',
  })
  @ApiEndpoint({
    summary: 'View the published design of a store page',
    description:
      'Get the design shoppers should see for a page: the published page, theme settings, header, footer and announcement. Only published work is returned, never drafts. Anything not published is null. Anyone can call it without signing in. Unknown, inactive or suspended stores give a 404.',
    auth: 'public',
    response: PublicLayoutDto,
    message: 'Storefront design retrieved successfully',
    errors: [400, 404],
  })
  layout(
    @Param('slug') slug: string,
    @Query('kind') kind = 'index',
    @Query('resource') resource?: string,
  ) {
    if (!['index', 'product', 'collection'].includes(kind))
      throw invalid('Choose a page: index, product or collection.');
    return this.publicService.layout(
      slug.toLowerCase(),
      kind,
      resource?.toLowerCase().slice(0, 100),
    );
  }

  @Get('storefronts/:slug/collections')
  @ApiParam({ name: 'slug', example: 'acme-store' })
  @ApiEndpoint({
    summary: 'List the collections of a public store',
    description:
      'Get the active collections a shopper can browse: name, address, description, picture and how many products each holds. Anyone can call it without signing in. Unknown, inactive or suspended stores give a 404.',
    auth: 'public',
    response: [PublicCollectionDto],
    message: 'Collections retrieved successfully',
    errors: [404],
  })
  collections(@Param('slug') slug: string) {
    return this.publicService.collections(slug.toLowerCase());
  }
}
