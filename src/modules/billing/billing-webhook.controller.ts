import { Controller, Get, Headers, HttpCode, Post, Req } from '@nestjs/common';
import { MonitoringRecorder } from '../monitoring/monitoring.recorder.js';
import { ConfigService } from '@nestjs/config';
import { ApiExcludeController, ApiHeader, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import type { Request } from 'express';
import { ApiEndpoint } from '../../common/decorators/api-endpoint.decorator.js';
import { Public } from '../../common/decorators/decorators.js';
import { authorizeJob } from '../../common/job-auth.js';
import type { AppConfig } from '../../config/configuration.js';
import { BillingWebhookService } from './billing-webhook.service.js';
import { BillingService } from './billing.service.js';

@ApiTags('webhooks')
@Controller('webhooks/billing/razorpay')
@Public()
export class BillingWebhookController {
  constructor(private readonly webhooks: BillingWebhookService) {}

  @Post()
  @HttpCode(200)
  @Throttle({ default: { limit: 600, ttl: 60_000 } })
  @ApiHeader({ name: 'X-Razorpay-Signature', required: true })
  @ApiHeader({ name: 'X-Razorpay-Event-Id', required: false })
  @ApiEndpoint({
    summary: "Receive Razorpay webhooks for StoreForge's own account",
    description:
      "The address given to Razorpay for StoreForge's subscription billing account. The signature in `X-Razorpay-Signature` is checked against the exact body with the platform webhook secret; anything unsigned or wrongly signed gets 401 before the body is read. Each event is stored once by its id and processed once: a redelivery answers 200 and does nothing. Handled events: payment.authorized, payment.captured, payment.failed, order.paid, refund.created, refund.processed, refund.failed. An error while processing answers 500 so Razorpay delivers the event again. Answers 503 when no webhook secret is configured.",
    auth: 'public',
    response: null,
    message: 'Webhook received',
    errors: [401, 429, 503],
  })
  receive(
    @Req() req: Request,
    @Headers('x-razorpay-signature') signature?: string,
    @Headers('x-razorpay-event-id') eventId?: string,
  ) {
    return this.webhooks.handle(req.body as Buffer, signature, eventId);
  }
}

/** Scheduler entry point for renewals, like the other `/internal/jobs/*` routes: hidden from the docs and refused without the secret. */
@Controller('internal/jobs')
@Public()
@ApiExcludeController()
export class BillingJobsController {
  constructor(
    private readonly billing: BillingService,
    private readonly monitoring: MonitoringRecorder,
    private readonly config: ConfigService<AppConfig, true>,
  ) {}

  @Get('billing')
  async run(@Headers('authorization') authorization?: string) {
    authorizeJob(
      this.config.get('cron', { infer: true }).secret,
      authorization,
    );
    return this.monitoring.runJob('billing', () => this.billing.scheduledRun());
  }
}
