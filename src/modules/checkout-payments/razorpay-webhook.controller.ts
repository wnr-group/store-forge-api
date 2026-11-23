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
import {
  ApiExcludeController,
  ApiHeader,
  ApiParam,
  ApiTags,
} from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import type { Request } from 'express';
import { ApiEndpoint } from '../../common/decorators/api-endpoint.decorator.js';
import { Public } from '../../common/decorators/decorators.js';
import { authorizeJob } from '../../common/job-auth.js';
import type { AppConfig } from '../../config/configuration.js';
import { PaymentReconciliationService } from './payment-reconciliation.service.js';
import { RazorpayWebhookService } from './razorpay-webhook.service.js';

@ApiTags('webhooks')
@Controller('webhooks/razorpay')
@Public()
export class RazorpayWebhookController {
  constructor(private readonly webhooks: RazorpayWebhookService) {}

  @Post(':tenantPublicId')
  @HttpCode(200)
  // Razorpay may send bursts and redeliver; a signature check is cheap and a bad one is rejected before any work.
  @Throttle({ default: { limit: 600, ttl: 60_000 } })
  @ApiParam({ name: 'tenantPublicId', example: 'k3x9a2' })
  @ApiHeader({ name: 'X-Razorpay-Signature', required: true })
  @ApiHeader({ name: 'X-Razorpay-Event-Id', required: false })
  @ApiEndpoint({
    summary: 'Receive Razorpay webhooks',
    description:
      "The address each organization gives Razorpay under Settings > Webhooks (the organization's public id is part of the path). The signature in `X-Razorpay-Signature` is checked against the exact body with that organization's own webhook secret; anything unsigned or wrongly signed gets 401. Each event is stored once and processed once: a redelivery answers 200 and does nothing. Handled events: payment.authorized, payment.captured, payment.failed, order.paid, refund.created, refund.processed, refund.failed. An error while processing answers 500 so Razorpay delivers the event again.",
    auth: 'public',
    response: null,
    message: 'Webhook received',
    errors: [401, 429, 503],
  })
  receive(
    @Param('tenantPublicId') tenantPublicId: string,
    @Req() req: Request,
    @Headers('x-razorpay-signature') signature?: string,
    @Headers('x-razorpay-event-id') eventId?: string,
  ) {
    return this.webhooks.handle(
      tenantPublicId,
      req.body as Buffer,
      signature,
      eventId,
    );
  }
}

@Controller('internal/jobs')
@Public()
@ApiExcludeController()
export class PaymentJobsController {
  constructor(
    private readonly reconciliation: PaymentReconciliationService,
    private readonly config: ConfigService<AppConfig, true>,
  ) {}

  @Get('reconcile-payments')
  reconcile(@Headers('authorization') authorization?: string) {
    authorizeJob(
      this.config.get('cron', { infer: true }).secret,
      authorization,
    );
    return this.reconciliation.reconcile();
  }
}
