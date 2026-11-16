import { Injectable } from '@nestjs/common';
import { BaseRateLimitGuard } from './base-rate-limit.guard.js';

@Injectable()
export class ReadyRateLimitGuard extends BaseRateLimitGuard {
  protected override readonly throttlerName = 'ready';
}
