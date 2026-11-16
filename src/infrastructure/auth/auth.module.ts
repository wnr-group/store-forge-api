import { Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { AuthGuard } from './auth.guard.js';
import { JwksService } from './jwks.service.js';

@Module({
  providers: [
    JwksService,
    {
      provide: APP_GUARD,
      useClass: AuthGuard,
    },
  ],
  exports: [JwksService],
})
export class AuthModule {}
