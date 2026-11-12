import { Controller, Get, Param } from '@nestjs/common';
import { ApiParam, ApiTags } from '@nestjs/swagger';
import { ApiEndpoint } from '../../common/decorators/api-endpoint.decorator.js';
import { Public } from '../../common/decorators/decorators.js';
import { PublicBrandingDto, StorefrontDto } from './public.dto.js';
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
}
