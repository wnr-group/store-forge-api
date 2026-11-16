import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { unauthenticated } from '../../common/errors/app-exception.js';
import type { AppConfig } from '../../config/configuration.js';

@Injectable()
export class LiveAuthService {
  private readonly logger = new Logger(LiveAuthService.name);
  private readonly supabaseUrl: string;
  private readonly supabaseAnonKey: string;
  private timeoutMs = 3000;

  constructor(private readonly config: ConfigService<AppConfig, true>) {
    this.supabaseUrl = this.config.get('auth.supabaseUrl', { infer: true });
    this.supabaseAnonKey = this.config.get('auth.supabaseAnonKey', {
      infer: true,
    });
  }

  /** Test helper to adjust live-auth timeout for fast timeout test execution. */
  setTimeoutMs(ms: number): void {
    this.timeoutMs = ms;
  }

  /**
   * Verifies an active session against Supabase /auth/v1/user (AC-B-16 to AC-B-21).
   * Any failure fails closed with 401 UNAUTHENTICATED; internal failure reasons are logged server-side only.
   */
  async verifyUser(token: string, expectedUserId: string): Promise<void> {
    const userUrl = `${this.supabaseUrl}/auth/v1/user`;
    let response: Response;

    try {
      response = await fetch(userUrl, {
        headers: {
          apikey: this.supabaseAnonKey,
          Authorization: `Bearer ${token}`,
        },
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (err) {
      this.logger.error(
        `Live auth fetch failure (timeout or network): ${String(err)}`,
      );
      throw unauthenticated('Invalid or expired session.');
    }

    if (!response.ok) {
      this.logger.warn(
        `Live auth rejected by Supabase with HTTP status ${response.status}`,
      );
      throw unauthenticated('Invalid or expired session.');
    }

    let body: { id?: string };
    try {
      body = (await response.json()) as { id?: string };
    } catch (err) {
      this.logger.error(
        `Failed to parse Supabase /auth/v1/user response: ${String(err)}`,
      );
      throw unauthenticated('Invalid or expired session.');
    }

    if (!body || body.id !== expectedUserId) {
      this.logger.warn(
        `Live auth user ID mismatch: expected ${expectedUserId}, got ${body?.id ?? 'none'}`,
      );
      throw unauthenticated('Invalid or expired session.');
    }
  }
}
