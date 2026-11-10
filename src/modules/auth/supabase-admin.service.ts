import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { AppException } from '../../common/app.exception.js';
import type { AppConfig } from '../../config/configuration.js';

export type ProvisionedUser = { id: string; email: string };

type AdminError = { code?: string; status?: number; message?: string };

/**
 * Supabase Auth Admin API wrappers for provisioned accounts (port of lib/auth/provisioning.ts).
 *
 * Callers MUST have authorised the acting user (Platform Admin, or the tenant Owner for their own tenant) first.
 * The service-role key is read here and nowhere else, and is used ONLY for `auth.admin.*`: never for queries,
 * Storage or anything else that would bypass row level security.
 *
 * Accounts are created already confirmed (`email_confirm: true`): StoreForge has no email-verification step.
 */
@Injectable()
export class SupabaseAdminService {
  private readonly logger = new Logger(SupabaseAdminService.name);
  private readonly client: SupabaseClient;

  constructor(config: ConfigService<AppConfig, true>) {
    const { url, serviceRoleKey } = config.get('supabase', { infer: true });
    this.client = createClient(url, serviceRoleKey, {
      auth: {
        autoRefreshToken: false,
        persistSession: false,
        detectSessionInUrl: false,
      },
    });
  }

  private mapError(error: AdminError): AppException {
    if (
      error.code === 'email_exists' ||
      error.code === 'user_already_exists' ||
      (error.status === 422 &&
        /already|registered|exists/i.test(error.message ?? ''))
    ) {
      return new AppException(
        'CONFLICT',
        'An account with this email already exists.',
        { code: 'EMAIL_TAKEN', details: { email: 'Already in use' } },
      );
    }
    if (error.code === 'weak_password')
      return new AppException(
        'VALIDATION',
        'That password is too weak. Try a longer one.',
        { code: 'WEAK_PASSWORD', details: { password: 'Too weak' } },
      );
    if (error.status === 429)
      return new AppException(
        'RATE_LIMITED',
        'Too many attempts. Please wait a moment and try again.',
      );
    this.logger.error(
      `auth admin error ${error.code ?? error.status}: ${error.message}`,
    );
    return new AppException(
      'UNKNOWN',
      'Could not create the account. Please try again.',
    );
  }

  /** Creates a confirmed e-mail/password account. The profile row is created by the on_auth_user_created trigger. */
  async createConfirmedUser(input: {
    email: string;
    password: string;
    fullName: string;
  }): Promise<ProvisionedUser> {
    const { data, error } = await this.client.auth.admin.createUser({
      email: input.email,
      password: input.password,
      email_confirm: true,
      user_metadata: { full_name: input.fullName },
      app_metadata: { provisioned: true },
    });
    if (error || !data.user)
      throw this.mapError(error ?? { message: 'no user returned' });
    return { id: data.user.id, email: data.user.email ?? input.email };
  }

  /** Admin-assisted password reset. The old password is never read or returned. */
  async setUserPassword(userId: string, password: string): Promise<void> {
    const { error } = await this.client.auth.admin.updateUserById(userId, {
      password,
    });
    if (error) throw this.mapError(error);
  }

  /** Keeps the Auth display name in step with the profile row. Best effort. */
  async setUserFullName(userId: string, fullName: string): Promise<void> {
    const { error } = await this.client.auth.admin.updateUserById(userId, {
      user_metadata: { full_name: fullName },
    });
    if (error)
      this.logger.warn(`updateUserById(full_name) failed: ${error.message}`);
  }

  /**
   * Deletes an Auth user (cascades to profile and membership): compensation after a failed provisioning step and
   * cleanup of orphaned accounts. Failures are logged, never thrown, so a cleanup problem cannot mask the real error.
   */
  async deleteUserQuietly(userId: string): Promise<boolean> {
    try {
      const { error } = await this.client.auth.admin.deleteUser(userId);
      if (error) {
        this.logger.error(
          `deleteUser failed - orphaned auth user ${userId}: ${error.message}`,
        );
        return false;
      }
      return true;
    } catch (e) {
      this.logger.error(
        `deleteUser threw - orphaned auth user ${userId}: ${e instanceof Error ? e.message : 'unknown'}`,
      );
      return false;
    }
  }
}
