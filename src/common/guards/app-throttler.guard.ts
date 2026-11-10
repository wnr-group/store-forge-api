import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Reflector } from '@nestjs/core';
import {
  InjectThrottlerOptions,
  InjectThrottlerStorage,
  ThrottlerGuard,
  type ThrottlerModuleOptions,
  type ThrottlerStorage,
} from '@nestjs/throttler';
import type { Request } from 'express';
import type { AppConfig } from '../../config/configuration.js';
import {
  clientAddress,
  isTrustedServer,
} from '../../modules/auth/request-trust.js';

/**
 * Rate limits per visitor. When the Next.js server calls this API on a visitor's behalf, every request would otherwise
 * share the frontend server's address and one user could exhaust everyone's budget; a call carrying the shared secret
 * is therefore keyed on the visitor address it forwards. Anyone else is keyed on their own address.
 */
@Injectable()
export class AppThrottlerGuard extends ThrottlerGuard {
  constructor(
    @InjectThrottlerOptions() options: ThrottlerModuleOptions,
    @InjectThrottlerStorage() storage: ThrottlerStorage,
    reflector: Reflector,
    private readonly config: ConfigService<AppConfig, true>,
  ) {
    super(options, storage, reflector);
  }

  protected override async getTracker(
    req: Record<string, unknown>,
  ): Promise<string> {
    const request = req as unknown as Request;
    const secret = this.config.get('auth', { infer: true }).bffSecret;
    return clientAddress(request, isTrustedServer(request, secret));
  }
}
