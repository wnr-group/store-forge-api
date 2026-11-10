import { Injectable } from '@nestjs/common';
import { eq } from 'drizzle-orm';
import { notFound } from '../../common/app.exception.js';
import type { AuthUser } from '../../common/interfaces/request-context.js';
import { DatabaseService } from '../../database/database.service.js';
import { profiles } from '../../database/schema/index.js';
import { SupabaseAdminService } from '../auth/supabase-admin.service.js';
import type { ProfileDto } from './users.dto.js';

@Injectable()
export class UsersService {
  constructor(
    private readonly db: DatabaseService,
    private readonly authAdmin: SupabaseAdminService,
  ) {}

  /** The signed-in user's own profile. RLS allows only the own row. */
  async getOwn(user: AuthUser): Promise<ProfileDto> {
    const fullName = await this.db.withUser(user.id, async (tx) => {
      const [p] = await tx
        .select({ fullName: profiles.fullName })
        .from(profiles)
        .where(eq(profiles.id, user.id));
      return p ? p.fullName : undefined;
    });
    if (fullName === undefined)
      throw notFound('Your profile could not be found.', 'PROFILE_NOT_FOUND');
    return { id: user.id, email: user.email, fullName };
  }

  /** Updates the user's own display name (profiles RLS allows only the own row) and keeps Auth metadata in step. */
  async updateOwnName(user: AuthUser, fullName: string): Promise<ProfileDto> {
    await this.db.withUser(user.id, async (tx) => {
      const rows = await tx
        .update(profiles)
        .set({ fullName })
        .where(eq(profiles.id, user.id))
        .returning({ id: profiles.id });
      if (!rows.length)
        throw notFound('Your profile could not be found.', 'PROFILE_NOT_FOUND');
    });
    // The identity is the verified caller, so the Auth Admin API only ever touches their own user.
    await this.authAdmin.setUserFullName(user.id, fullName);
    return { id: user.id, email: user.email, fullName };
  }
}
