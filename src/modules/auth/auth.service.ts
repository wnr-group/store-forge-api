import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { eq, sql } from 'drizzle-orm';
import { AppException, invalid } from '../../common/app.exception.js';
import type { AuthUser } from '../../common/interfaces/request-context.js';
import { listActiveMemberships } from '../../common/tenancy/memberships.js';
import type { AppConfig } from '../../config/configuration.js';
import { DatabaseService, rowsOf } from '../../database/database.service.js';
import { profiles } from '../../database/schema/index.js';
import type { ChangePasswordDto, MeDto } from './auth.dto.js';

type AuthError = { code?: string; status?: number; message?: string };

/**
 * Identity helpers. Sign-in, sign-out and token refresh stay in the Supabase SDK on the client (see
 * docs/AUTHENTICATION_MIGRATION_PLAN.md); this service never issues tokens or stores passwords.
 */
@Injectable()
export class AuthService {
  constructor(
    private readonly db: DatabaseService,
    private readonly config: ConfigService<AppConfig, true>,
  ) {}

  /** Who the verified token belongs to, plus everything the database says about them. */
  async me(user: AuthUser): Promise<MeDto> {
    const { memberships, level, fullName } = await this.db.withUser(
      user.id,
      async (tx) => {
        const [memberships, roleRows, profile] = await Promise.all([
          listActiveMemberships(tx, user.id),
          tx.execute(sql`select public.platform_admin_role() as r`),
          tx
            .select({ fullName: profiles.fullName })
            .from(profiles)
            .where(eq(profiles.id, user.id)),
        ]);
        const role = rowsOf<{ r: string | null }>(roleRows)[0]?.r;
        return {
          memberships,
          fullName: profile[0]?.fullName ?? null,
          level: (role === 'super_admin' || role === 'admin'
            ? role
            : null) as MeDto['platformAdminLevel'],
        };
      },
    );
    return {
      id: user.id,
      email: user.email,
      fullName,
      platformAdminLevel: level,
      memberships: memberships.map((m) => ({
        organizationId: m.tenant.id,
        organizationName: m.tenant.name,
        organizationSlug: m.tenant.slug,
        role: m.role,
        permissions: m.permissions as Record<string, string>,
        joinedAt: m.joinedAt,
      })),
    };
  }

  /** A client without a stored session: used only to talk to Supabase Auth on the caller's behalf. */
  protected createAuthClient(): SupabaseClient {
    const { url, anonKey } = this.config.get('supabase', { infer: true });
    return createClient(url, anonKey, {
      auth: {
        persistSession: false,
        autoRefreshToken: false,
        detectSessionInUrl: false,
      },
    });
  }

  private mapAuthError(error: AuthError): AppException {
    if (error.status === 429 || error.code === 'over_request_rate_limit')
      return new AppException(
        'RATE_LIMITED',
        'Too many attempts. Please wait a moment and try again.',
      );
    if (error.code === 'weak_password')
      return invalid('That password is too weak. Try a longer one.', {
        password: 'Too weak',
      });
    if (error.code === 'same_password')
      return invalid('Choose a password different from your current one.', {
        password: 'Choose a different password',
      });
    return new AppException(
      'UNKNOWN',
      'Could not change the password. Please try again.',
    );
  }

  /**
   * Changes the signed-in user's own password. The current password is re-verified first, so a hijacked
   * session alone cannot lock the real user out (same rule as the Next.js app).
   */
  async changePassword(user: AuthUser, dto: ChangePasswordDto): Promise<void> {
    if (dto.password !== dto.confirmPassword)
      throw invalid('Passwords do not match.', {
        confirmPassword: 'Passwords do not match',
      });
    if (dto.password === dto.currentPassword)
      throw invalid('Choose a password different from your current one.', {
        password: 'Choose a different password',
      });
    if (!user.email)
      throw new AppException(
        'UNAUTHENTICATED',
        'Your session has expired. Please sign in again.',
        { code: 'TOKEN_EXPIRED' },
      );

    const client = this.createAuthClient();
    try {
      const verify = await client.auth.signInWithPassword({
        email: user.email,
        password: dto.currentPassword,
      });
      if (verify.error) {
        if (verify.error.code === 'invalid_credentials')
          throw invalid(
            'Your current password is incorrect.',
            { currentPassword: 'Incorrect password' },
            'CURRENT_PASSWORD_INCORRECT',
          );
        throw this.mapAuthError(verify.error);
      }
      const { error } = await client.auth.updateUser({
        password: dto.password,
      });
      if (error) throw this.mapAuthError(error);
    } finally {
      await client.auth.signOut({ scope: 'local' }).catch(() => undefined);
    }
  }
}
