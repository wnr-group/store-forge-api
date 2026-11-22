import { Body, Controller, Get, Param, Post, Query } from '@nestjs/common';
import { ApiParam, ApiQuery, ApiTags } from '@nestjs/swagger';
import { ApiEndpoint } from '../../common/decorators/api-endpoint.decorator.js';
import { Public } from '../../common/decorators/decorators.js';
import { invalid } from '../../common/app.exception.js';
import { PublicRecommendationsQueryDto } from '../recommendations/recommendations.dto.js';
import { RecordWebVitalsDto } from '../studio/studio.dto.js';
import {
  PublicBrandingDto,
  PublicCollectionDto,
  PublicHostDto,
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

  @Get('hosts/:subdomain')
  @ApiParam({ name: 'subdomain', example: 'urban-nest-zqkod2' })
  @ApiEndpoint({
    summary: 'Find the store a storefront address names',
    description:
      "Turn the host label of a storefront address (for example `urban-nest-zqkod2` in `urban-nest-zqkod2.store-forge.com`) into the store's slug and its organization's public id. Anyone can call it without signing in. If no active store has that address, or its organization is suspended, you get a 404 error in every case, so nobody can tell those situations apart.",
    auth: 'public',
    response: PublicHostDto,
    message: 'Store address resolved successfully',
    errors: [404],
  })
  host(@Param('subdomain') subdomain: string) {
    return this.publicService.host(subdomain.toLowerCase());
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

  @Get('storefronts/:slug/products/:productSlug/reviews')
  @ApiParam({ name: 'slug', example: 'acme-store' })
  @ApiParam({ name: 'productSlug', example: 'classic-t-shirt' })
  @ApiQuery({ name: 'limit', required: false, example: 20 })
  @ApiQuery({ name: 'offset', required: false, example: 0 })
  @ApiEndpoint({
    summary: 'Get published reviews for a product',
    description: 'Get published reviews and disclosure wording for a product. Unpublished reviews are never returned.',
    auth: 'public',
    message: 'Product reviews retrieved successfully',
    errors: [404],
  })
  reviews(
    @Param('slug') slug: string,
    @Param('productSlug') productSlug: string,
    @Query('limit') limit = 20,
    @Query('offset') offset = 0,
  ) {
    return this.publicService.reviews(
      slug.toLowerCase(),
      productSlug.toLowerCase().slice(0, 100),
      Number(limit) || 20,
      Number(offset) || 0,
    );
  }

  @Get('storefronts/:slug/recommendations')
  @ApiParam({ name: 'slug', example: 'acme-store' })
  @ApiEndpoint({
    summary: 'Get product recommendations',
    description: 'Get product recommendations by source (related, merchant_picked, collection, newest, recently_viewed).',
    auth: 'public',
    message: 'Recommendations retrieved successfully',
    errors: [404],
  })
  recommendations(
    @Param('slug') slug: string,
    @Query() query: PublicRecommendationsQueryDto,
  ) {
    return this.publicService.recommendations(slug.toLowerCase(), query);
  }

  @Post('vitals')
  @ApiEndpoint({
    summary: 'Record client-side Web Vitals',
    description: 'Record a performance measurement sample (LCP, CLS, INP, TTFB, FCP) into the daily histogram.',
    auth: 'public',
    body: RecordWebVitalsDto,
    message: 'Web vitals recorded successfully',
  })
  recordVitals(@Body() dto: RecordWebVitalsDto) {
    return this.publicService.recordWebVitals(dto);
  }

  @Get('storefronts/:slug/landing-pages/:pageSlug')
  @ApiParam({ name: 'slug', example: 'acme-store' })
  @ApiParam({ name: 'pageSlug', example: 'summer-sale' })
  @ApiEndpoint({
    summary: 'View a published landing page',
    description: 'Get the published section-based landing page document. Unpublished pages give 404.',
    auth: 'public',
    message: 'Landing page retrieved successfully',
    errors: [404],
  })
  landingPage(
    @Param('slug') slug: string,
    @Param('pageSlug') pageSlug: string,
  ) {
    return this.publicService.landingPage(
      slug.toLowerCase(),
      pageSlug.toLowerCase().slice(0, 100),
    );
  }
}
