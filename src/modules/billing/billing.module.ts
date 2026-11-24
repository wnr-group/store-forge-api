import { Module } from '@nestjs/common';
import { PaymentsModule } from '../payments/payments.module.js';
import { BillingPaymentsService } from './billing-payments.service.js';
import {
  BillingJobsController,
  BillingWebhookController,
} from './billing-webhook.controller.js';
import { BillingWebhookService } from './billing-webhook.service.js';
import { BillingService } from './billing.service.js';
import { PlatformBillingController } from './platform-billing.controller.js';
import { PlatformRazorpayService } from './platform-razorpay.service.js';
import { TenantBillingController } from './tenant-billing.controller.js';

/**
 * What organizations pay StoreForge for their plan. It reuses the payments module's Razorpay client and signature checks; the money
 * is collected on StoreForge's own Razorpay account, never on a tenant's.
 */
@Module({
  imports: [PaymentsModule],
  controllers: [
    PlatformBillingController,
    TenantBillingController,
    BillingWebhookController,
    BillingJobsController,
  ],
  providers: [
    PlatformRazorpayService,
    BillingService,
    BillingPaymentsService,
    BillingWebhookService,
  ],
  exports: [BillingService],
})
export class BillingModule {}
