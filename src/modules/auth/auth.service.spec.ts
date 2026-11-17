import type { ConfigService } from '@nestjs/config';
import type { SupabaseClient } from '@supabase/supabase-js';
import { AuthService } from './auth.service.js';
import type { DatabaseService } from '../../database/database.service.js';

type Result = { error: { code?: string; status?: number } | null };

/** Records what the service asks Supabase to do; no network. */
class TestAuthService extends AuthService {
  readonly calls: string[] = [];
  signIn: Result = { error: null };
  update: Result = { error: null };

  constructor() {
    super({} as DatabaseService, {} as ConfigService<never, true>);
  }

  protected override createAuthClient(): SupabaseClient {
    return {
      auth: {
        signInWithPassword: async (c: { email: string; password: string }) => {
          this.calls.push(`signIn:${c.email}:${c.password}`);
          return this.signIn;
        },
        updateUser: async (a: { password: string }) => {
          this.calls.push(`update:${a.password}`);
          return this.update;
        },
        signOut: async () => {
          this.calls.push('signOut');
          return { error: null };
        },
      },
    } as unknown as SupabaseClient;
  }
}

const user = {
  id: '11111111-1111-4111-8111-111111111111',
  email: 'me@example.test',
  token: 't',
};
const dto = {
  currentPassword: 'Old-pass-1',
  password: 'New-pass-12',
  confirmPassword: 'New-pass-12',
};

describe('AuthService.changePassword', () => {
  it('re-verifies the current password, then sets the new one, then drops the temporary session', async () => {
    const svc = new TestAuthService();
    await svc.changePassword(user, dto);
    expect(svc.calls).toEqual([
      'signIn:me@example.test:Old-pass-1',
      'update:New-pass-12',
      'signOut',
    ]);
  });

  it('does not touch Supabase when the confirmation differs or the password is unchanged', async () => {
    const svc = new TestAuthService();
    await expect(
      svc.changePassword(user, { ...dto, confirmPassword: 'other' }),
    ).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
    await expect(
      svc.changePassword(user, {
        ...dto,
        password: 'Old-pass-1',
        confirmPassword: 'Old-pass-1',
      }),
    ).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
    expect(svc.calls).toEqual([]);
  });

  it('reports a wrong current password without changing anything', async () => {
    const svc = new TestAuthService();
    svc.signIn = { error: { code: 'invalid_credentials' } };
    await expect(svc.changePassword(user, dto)).rejects.toMatchObject({
      code: 'CURRENT_PASSWORD_INCORRECT',
      details: { currentPassword: 'Incorrect password' },
    });
    expect(svc.calls.some((c) => c.startsWith('update:'))).toBe(false);
    expect(svc.calls).toContain('signOut');
  });

  it('maps Supabase rate limits and weak passwords to safe errors', async () => {
    const limited = new TestAuthService();
    limited.signIn = { error: { status: 429 } };
    await expect(limited.changePassword(user, dto)).rejects.toMatchObject({
      status: 429,
    });
    const weak = new TestAuthService();
    weak.update = { error: { code: 'weak_password' } };
    await expect(weak.changePassword(user, dto)).rejects.toMatchObject({
      code: 'VALIDATION_ERROR',
      details: { password: 'Too weak' },
    });
  });

  it('needs an e-mail on the token to verify the current password', async () => {
    const svc = new TestAuthService();
    await expect(
      svc.changePassword({ ...user, email: null }, dto),
    ).rejects.toMatchObject({ code: 'TOKEN_EXPIRED' });
  });
});
