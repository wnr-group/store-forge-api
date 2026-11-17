import { Controller, Get, Param, Query } from '@nestjs/common';
import { ApiParam, ApiQuery, ApiTags } from '@nestjs/swagger';
import { ApiEndpoint } from '../../common/decorators/api-endpoint.decorator.js';
import { Public } from '../../common/decorators/decorators.js';
import { invalid } from '../../common/app.exception.js';
import {
  PublicBrandingDto,
  PublicCollectionDto,
  PublicLayoutDto,
  PublicPageDto,
  PublicPageLinkDto,
  PublicResourceDto,
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

  @Get('storefronts/:slug/products/:productSlug')
  @ApiParam({ name: 'slug', example: 'acme-store' })
  @ApiParam({ name: 'productSlug', example: 'linen-shirt' })
  @ApiEndpoint({
    summary: 'View one product of a public store',
    description:
      'Get an active product with its images, options, active variants and related products. Anyone can call it without signing in. Unknown stores, products that are not active and inactive or suspended stores all give a 404.',
    auth: 'public',
    response: PublicResourceDto,
    message: 'Product retrieved successfully',
    errors: [404],
  })
  product(
    @Param('slug') slug: string,
    @Param('productSlug') productSlug: string,
  ) {
    return this.publicService.product(
      slug.toLowerCase(),
      productSlug.toLowerCase().slice(0, 200),
    );
  }

  @Get('storefronts/:slug/collections/:collectionSlug')
  @ApiParam({ name: 'slug', example: 'acme-store' })
  @ApiParam({ name: 'collectionSlug', example: 'new-arrivals' })
  @ApiEndpoint({
    summary: 'View one collection of a public store',
    description:
      'Get an active collection with its active products in the collection order. Anyone can call it without signing in. Unknown stores, collections that are not active and inactive or suspended stores all give a 404.',
    auth: 'public',
    response: PublicResourceDto,
    message: 'Collection retrieved successfully',
    errors: [404],
  })
  collection(
    @Param('slug') slug: string,
    @Param('collectionSlug') collectionSlug: string,
  ) {
    return this.publicService.collection(
      slug.toLowerCase(),
      collectionSlug.toLowerCase().slice(0, 200),
    );
  }

  @Get('storefronts/:slug/pages')
  @ApiParam({ name: 'slug', example: 'acme-store' })
  @ApiEndpoint({
    summary: 'List the content pages of a public store',
    description:
      'Get the title and address of every published content page (About, Contact...). Anyone can call it without signing in. Unknown, inactive or suspended stores give a 404.',
    auth: 'public',
    response: [PublicPageLinkDto],
    message: 'Pages retrieved successfully',
    errors: [404],
  })
  pages(@Param('slug') slug: string) {
    return this.publicService.pages(slug.toLowerCase());
  }

  @Get('storefronts/:slug/pages/:pageSlug')
  @ApiParam({ name: 'slug', example: 'acme-store' })
  @ApiParam({ name: 'pageSlug', example: 'about' })
  @ApiEndpoint({
    summary: 'View one content page of a public store',
    description:
      'Get a published content page. Drafts are never returned. Anyone can call it without signing in. Unknown stores, unknown or unpublished pages and inactive or suspended stores all give a 404.',
    auth: 'public',
    response: PublicPageDto,
    message: 'Page retrieved successfully',
    errors: [404],
  })
  page(@Param('slug') slug: string, @Param('pageSlug') pageSlug: string) {
    return this.publicService.page(
      slug.toLowerCase(),
      pageSlug.toLowerCase().slice(0, 100),
    );
  }
}
