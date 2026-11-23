import { Controller, Get, Headers } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ApiExcludeController } from '@nestjs/swagger';
import { authorizeJob } from '../../common/job-auth.js';
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
    authorizeJob(
      this.config.get('cron', { infer: true }).secret,
      authorization,
    );
    return this.expiry.expireDue();
  }
}
