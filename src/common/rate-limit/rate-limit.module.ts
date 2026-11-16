import { Global, Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { ThrottlerModule } from '@nestjs/throttler';
import type { AppConfig } from '../../config/configuration.js';
import { PublicRateLimitGuard } from './public-rate-limit.guard.js';
import { ReadyRateLimitGuard } from './ready-rate-limit.guard.js';

@Global()
@Module({
  imports: [
    ThrottlerModule.forRootAsync({
      imports: [ConfigModule],
      inject: [ConfigService],
      useFactory: (config: ConfigService<AppConfig, true>) => [
        {
          name: 'public',
          ttl:
            (config.get('rateLimit.publicWindowSeconds', { infer: true }) ??
              60) * 1000,
          limit: config.get('rateLimit.publicLimit', { infer: true }) ?? 60,
        },
        {
          name: 'ready',
          ttl:
            (config.get('rateLimit.readyWindowSeconds', { infer: true }) ??
              60) * 1000,
          limit: config.get('rateLimit.readyLimit', { infer: true }) ?? 30,
        },
      ],
    }),
  ],
  providers: [PublicRateLimitGuard, ReadyRateLimitGuard],
  exports: [ThrottlerModule, PublicRateLimitGuard, ReadyRateLimitGuard],
})
export class RateLimitModule {}
