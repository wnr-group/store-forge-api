import { Module } from '@nestjs/common';
import { PlatformAdminGuard } from '../auth/platform-admin.guard.js';
import { SuperAdminGuard } from '../auth/super-admin.guard.js';
import { AdminRateLimitService } from './admin-rate-limit.service.js';
import { AuditService } from './audit.service.js';

@Module({
  providers: [
    PlatformAdminGuard,
    SuperAdminGuard,
    AdminRateLimitService,
    AuditService,
  ],
  exports: [
    PlatformAdminGuard,
    SuperAdminGuard,
    AdminRateLimitService,
    AuditService,
  ],
})
export class SecurityModule {}
