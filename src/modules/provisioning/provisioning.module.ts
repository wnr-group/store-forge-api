import { Module } from '@nestjs/common';
import { TenantProvisioningService } from './tenant-provisioning.service.js';

/** The retry rules shared by every way of creating a tenant (Platform Admin, self-service sign-up). */
@Module({
  providers: [TenantProvisioningService],
  exports: [TenantProvisioningService],
})
export class ProvisioningModule {}
