import { Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { AuthGuard } from './auth.guard.js';
import { JwksService } from './jwks.service.js';
import { LiveAuthGuard } from './live-auth.guard.js';
import { LiveAuthService } from './live-auth.service.js';
import { PermissionGuard } from './permission.guard.js';
import { TenantAccessService } from './tenant-access.service.js';
import { TenantGuard } from './tenant.guard.js';

@Module({
  providers: [
    JwksService,
    LiveAuthService,
    LiveAuthGuard,
    TenantAccessService,
    TenantGuard,
    PermissionGuard,
    {
      provide: APP_GUARD,
      useClass: AuthGuard,
    },
    {
      provide: APP_GUARD,
      useClass: TenantGuard,
    },
    {
      provide: APP_GUARD,
      useClass: PermissionGuard,
    },
    {
      provide: APP_GUARD,
      useClass: LiveAuthGuard,
    },
  ],
  exports: [
    JwksService,
    LiveAuthService,
    LiveAuthGuard,
    TenantAccessService,
    TenantGuard,
    PermissionGuard,
  ],
})
export class AuthModule {}
