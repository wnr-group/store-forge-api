import {
  Controller,
  Get,
  Headers,
  HttpCode,
  Param,
  Post,
  Req,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ApiExcludeController, ApiParam, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import type { Request } from 'express';
import { ApiEndpoint } from '../../common/decorators/api-endpoint.decorator.js';
import { Public } from '../../common/decorators/decorators.js';
import { notFound } from '../../common/app.exception.js';
import { authorizeJob } from '../../common/job-auth.js';
import type { AppConfig } from '../../config/configuration.js';
import { ShippingProviderRegistry } from '../shipping/providers/provider-registry.js';
import { ShipmentTrackingService } from './shipment-tracking.service.js';

/**
 * Webhook routes receive their body raw (a Buffer), because Razorpay signs exact bytes. A carrier's message is read here as JSON,
 * or as form fields; anything else is simply "no usable content", which the caller answers with 200 and does nothing.
 */
function readBody(body: unknown): unknown {
  if (!Buffer.isBuffer(body)) return body;
  const text = body.toString('utf8').trim();
  if (!text) return null;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return Object.fromEntries(new URLSearchParams(text));
  }
}

@ApiTags('webhooks')
@Controller('webhooks/carriers')
@Public()
export class CarrierWebhookController {
  constructor(
    private readonly tracking: ShipmentTrackingService,
    private readonly registry: ShippingProviderRegistry,
  ) {}

  @Post(':providerCode')
  @HttpCode(200)
  @Throttle({ default: { limit: 300, ttl: 60_000 } })
  @ApiParam({ name: 'providerCode', example: 'delhivery' })
  @ApiEndpoint({
    summary: 'Receive carrier tracking webhooks',
    description:
      "The address to give a carrier that can push tracking updates. The body is only used to find which parcels it mentions (by waybill number): it is never believed. For each parcel found, the carrier's tracking service is asked directly, with the shop's own saved credentials, and that answer is what gets recorded. A forged message can therefore do nothing but cause an extra lookup. Always answers 200 `received`, whether or not a parcel matched, so nothing about other shops is revealed. A parcel the carrier does not push updates for is still kept up to date by the scheduled check.",
    auth: 'public',
    response: null,
    message: 'Webhook received',
    errors: [404, 429],
  })
  async receive(
    @Param('providerCode') providerCode: string,
    @Req() req: Request,
  ) {
    if (!this.registry.has(providerCode))
      throw notFound('Unknown carrier.', 'CARRIER_UNKNOWN');
    await this.tracking.handleWebhook(providerCode, readBody(req.body));
    return null;
  }
}

/** The scheduled tracking check. Hidden from the public docs; refuses every call unless the cron secret matches. */
@Controller('internal/jobs')
@Public()
@ApiExcludeController()
export class ShipmentJobsController {
  constructor(
    private readonly tracking: ShipmentTrackingService,
    private readonly config: ConfigService<AppConfig, true>,
  ) {}

  @Get('sync-shipments')
  async syncShipments(@Headers('authorization') authorization?: string) {
    authorizeJob(
      this.config.get('cron', { infer: true }).secret,
      authorization,
    );
    return this.tracking.syncDue();
  }
}
