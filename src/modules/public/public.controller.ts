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
    summary: 'Platform name and support contact',
    description:
      'For pages anyone can open (sign-in, "no workspace"). Falls back to defaults if the database is unreachable.',
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
    summary: 'Public storefront data',
    description:
      'Public fields of an active store in an active organization. Unknown, inactive and suspended stores all return 404.',
    auth: 'public',
    response: StorefrontDto,
    message: 'Storefront retrieved successfully',
    errors: [404],
  })
  storefront(@Param('slug') slug: string) {
    return this.publicService.storefront(slug.toLowerCase());
  }
}
