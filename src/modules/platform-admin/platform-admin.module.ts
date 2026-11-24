import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module.js';
import { StorageModule } from '../storage/storage.module.js';
import { PlatformAdminsController } from './admins/admins.controller.js';
import { PlatformAdminsService } from './admins/admins.service.js';
import { AuditController } from './audit/audit.controller.js';
import { AuditService } from './audit/audit.service.js';
import { PlansController } from './plans/plans.controller.js';
import { PlansService } from './plans/plans.service.js';
import { SubscriptionsController } from './subscriptions/subscriptions.controller.js';
import { SubscriptionsService } from './subscriptions/subscriptions.service.js';
import { PlatformOrganizationsController } from './organizations/organizations.controller.js';
import { PlatformOrganizationsService } from './organizations/organizations.service.js';
import { PlatformSettingsController } from './settings/settings.controller.js';
import { PlatformSettingsService } from './settings/settings.service.js';
import { PlatformUsageController } from './usage/usage.controller.js';
import { PlatformUsageService } from './usage/usage.service.js';

@Module({
  imports: [AuthModule, StorageModule],
  controllers: [
    PlatformOrganizationsController,
    PlatformAdminsController,
    PlatformSettingsController,
    AuditController,
    PlatformUsageController,
    PlansController,
    SubscriptionsController,
  ],
  providers: [
    PlatformOrganizationsService,
    PlatformAdminsService,
    PlatformSettingsService,
    AuditService,
    PlatformUsageService,
    PlansService,
    SubscriptionsService,
  ],
})
export class PlatformAdminModule {}
