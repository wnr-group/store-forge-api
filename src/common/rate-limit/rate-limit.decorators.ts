import { UseGuards } from '@nestjs/common';
import { PublicRateLimitGuard } from './public-rate-limit.guard.js';
import { ReadyRateLimitGuard } from './ready-rate-limit.guard.js';

export const PublicRateLimit = () => UseGuards(PublicRateLimitGuard);
export const ReadyRateLimit = () => UseGuards(ReadyRateLimitGuard);
