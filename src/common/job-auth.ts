import { timingSafeEqual } from 'node:crypto';
import { AppException } from './app.exception.js';

/**
 * Shared check for the scheduler routes (`/internal/jobs/*`). Vercel Cron sends `Authorization: Bearer <CRON_SECRET>`.
 * With no secret configured every call is refused, so a missing variable can never leave a job open.
 */
export function authorizeJob(
  secret: string | undefined,
  header: string | undefined,
): void {
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
