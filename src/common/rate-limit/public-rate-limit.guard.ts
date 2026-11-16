import { Injectable } from '@nestjs/common';
import { BaseRateLimitGuard } from './base-rate-limit.guard.js';

@Injectable()
export class PublicRateLimitGuard extends BaseRateLimitGuard {
  protected override readonly throttlerName = 'public';
}
