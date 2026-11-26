import { Module } from '@nestjs/common';
import { BillingModule } from '../billing/billing.module.js';
import { ProvisioningModule } from '../provisioning/provisioning.module.js';
import { SignupController } from './signup.controller.js';
import { SignupService } from './signup.service.js';

/** Buying a plan and creating the first store without a Platform Admin. Payments are taken on StoreForge's own Razorpay account. */
@Module({
  imports: [BillingModule, ProvisioningModule],
  controllers: [SignupController],
  providers: [SignupService],
})
export class SignupModule {}
