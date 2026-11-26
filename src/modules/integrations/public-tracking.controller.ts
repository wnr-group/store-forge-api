import { Controller, Get, Header, Param } from '@nestjs/common';
import { ApiParam, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { ApiEndpoint } from '../../common/decorators/api-endpoint.decorator.js';
import { Public } from '../../common/decorators/decorators.js';
import { CheckoutService } from '../orders/checkout.service.js';
import { TrackingConfigDto } from './integrations.dto.js';
import { IntegrationsService } from './integrations.service.js';

const TRACKING_LIMIT = { default: { limit: 120, ttl: 60_000 } };

@ApiTags('integrations')
@Controller('public/stores/:slug/tracking')
@Public()
export class PublicTrackingController {
  constructor(
    private readonly checkout: CheckoutService,
    private readonly integrations: IntegrationsService,
  ) {}

  @Get()
  @Throttle(TRACKING_LIMIT)
  @Header('Cache-Control', 'public, max-age=60')
  @ApiParam({ name: 'slug', example: 'acme-store' })
  @ApiEndpoint({
    summary: 'Which tracking a storefront may load',
    description:
      'The analytics integrations this store has validated and switched on, with their PUBLIC identifiers (a Measurement ID, a Pixel ID), so the storefront can load them. Each store only ever gets its own. A storefront must not load any of them until the shopper has agreed to analytics (`consentRequired` is always true). Private credentials are never part of this response. Safe to cache for a minute.',
    auth: 'public',
    response: TrackingConfigDto,
    message: 'Tracking configuration retrieved successfully',
    errors: [404, 429],
  })
  async get(@Param('slug') slug: string) {
    const store = await this.checkout.resolveStore(slug.toLowerCase());
    return this.integrations.trackingFor(store.tenantId);
  }
}
