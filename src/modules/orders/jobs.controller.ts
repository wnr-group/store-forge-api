import { timingSafeEqual } from 'node:crypto';
import { Controller, Get, Headers } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ApiExcludeController } from '@nestjs/swagger';
import { AppException } from '../../common/app.exception.js';
import { Public } from '../../common/decorators/decorators.js';
import type { AppConfig } from '../../config/configuration.js';
import { ReservationExpiryService } from './reservation-expiry.service.js';

/**
 * Scheduler entry points. Vercel Cron calls these with `Authorization: Bearer <CRON_SECRET>`. They are hidden from the public
 * API docs and refuse every call when no secret is configured, so a missing variable can never leave them open.
 */
@Controller('internal/jobs')
@Public()
@ApiExcludeController()
export class JobsController {
  constructor(
    private readonly expiry: ReservationExpiryService,
    private readonly config: ConfigService<AppConfig, true>,
  ) {}

  @Get('expire-reservations')
  async expireReservations(@Headers('authorization') authorization?: string) {
    this.authorize(authorization);
    return this.expiry.expireDue();
  }

  private authorize(header: string | undefined) {
    const secret = this.config.get('cron', { infer: true }).secret;
    if (!secret)
      throw new AppException(
        'UNAVAILABLE',
        'Scheduled jobs are not configured.',
        {
          code: 'JOBS_DISABLED',
        },
      );
    const supplied = Buffer.from(header?.replace(/^Bearer\s+/i, '') ?? '');
    const expected = Buffer.from(secret);
    if (
      supplied.length !== expected.length ||
      !timingSafeEqual(supplied, expected)
    )
      throw new AppException('UNAUTHENTICATED', 'Not authorised.', {
        code: 'UNAUTHORIZED',
      });
  }
}
