import { Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { AuthGuard } from './auth.guard.js';
import { JwksService } from './jwks.service.js';
import { LiveAuthGuard } from './live-auth.guard.js';
import { LiveAuthService } from './live-auth.service.js';

@Module({
  providers: [
    JwksService,
    LiveAuthService,
    LiveAuthGuard,
    {
      provide: APP_GUARD,
      useClass: AuthGuard,
    },
    {
      provide: APP_GUARD,
      useClass: LiveAuthGuard,
    },
  ],
  exports: [JwksService, LiveAuthService, LiveAuthGuard],
})
export class AuthModule {}
