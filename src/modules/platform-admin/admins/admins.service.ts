import { Injectable } from '@nestjs/common';
import { sql } from 'drizzle-orm';
import { notFound } from '../../../common/app.exception.js';
import {
  DatabaseService,
  rowsOf,
  type DbTx,
} from '../../../database/database.service.js';
import { SupabaseAdminService } from '../../auth/supabase-admin.service.js';
import { recordAudit } from '../audit/audit.service.js';
import { mapProvisioningError } from '../platform-errors.js';
import type {
  AddedPlatformAdminDto,
  AddPlatformAdminDto,
  PlatformAdminDto,
} from './admins.dto.js';

type Level = 'super_admin' | 'admin';
const LEVEL_LABEL: Record<Level, string> = {
  super_admin: 'super admin',
  admin: 'admin',
};

type AdminRaw = {
  user_id: string;
  email: string;
  full_name: string | null;
  role: Level;
  created_at: string | Date;
  created_by: string | null;
  created_by_email: string | null;
};

const adminNotFound = () =>
  notFound('That admin was not found.', 'ADMIN_NOT_FOUND');

/**
 * Platform Admin management. Adding, changing and removing admins is for super admins only (PlatformAdminGuard refuses
 * early and every SQL function checks again). The last super admin can never be removed or demoted (enforced in SQL
 * under a lock, so two simultaneous requests cannot both succeed). Platform authority is separate from tenant roles:
 * an account that belongs to an organization cannot become an admin.
 */
@Injectable()
export class PlatformAdminsService {
  constructor(
    private readonly db: DatabaseService,
    private readonly authAdmin: SupabaseAdminService,
  ) {}

  private async fetchAdmins(tx: DbTx): Promise<PlatformAdminDto[]> {
    return rowsOf<AdminRaw>(
      await tx.execute(sql`select * from public.platform_list_admins()`),
    ).map((r) => ({
      userId: r.user_id,
      email: r.email,
      fullName: r.full_name,
      role: r.role,
      createdAt: new Date(r.created_at),
      createdBy: r.created_by,
      createdByEmail: r.created_by_email,
    }));
  }

  /** Every Platform Admin can see the list; only super admins can change it. */
  list(adminId: string): Promise<PlatformAdminDto[]> {
    return this.db.withUser(adminId, (tx) => this.fetchAdmins(tx));
  }

  /**
   * Creates the account (confirmed, no e-mail sent) and makes it a Platform Admin. If the database step fails the
   * account is deleted again, so no orphaned sign-in remains. The initial password is never stored or logged.
   */
  async add(
    adminId: string,
    v: AddPlatformAdminDto,
  ): Promise<AddedPlatformAdminDto> {
    const user = await this.authAdmin.createConfirmedUser({
      email: v.email,
      password: v.password,
      fullName: v.fullName,
    });
    try {
      await this.db.withUser(adminId, async (tx) => {
        await tx.execute(
          sql`select public.platform_add_admin(${user.id}::uuid, ${v.role})`,
        );
        await recordAudit(tx, {
          action: 'platform_admin.added',
          entityType: 'platform_admin',
          entityId: user.id,
          description: `Added platform admin ${user.email} as ${LEVEL_LABEL[v.role]}`,
          next: { email: user.email, fullName: v.fullName, role: v.role },
        });
      });
    } catch (error) {
      await this.authAdmin.deleteUserQuietly(user.id);
      return mapProvisioningError(error, 'That admin was not found.');
    }
    return { email: user.email };
  }

  /** Changes an admin's level. Nothing is written or logged when it is already that level. */
  async setRole(
    adminId: string,
    userId: string,
    role: Level,
  ): Promise<PlatformAdminDto> {
    try {
      await this.db.withUser(adminId, async (tx) => {
        const target = (await this.fetchAdmins(tx)).find(
          (a) => a.userId === userId,
        );
        if (!target) throw adminNotFound();
        if (target.role === role) return;
        await tx.execute(
          sql`select public.platform_set_admin_role(${userId}::uuid, ${role})`,
        );
        await recordAudit(tx, {
          action: 'platform_admin.role_changed',
          entityType: 'platform_admin',
          entityId: userId,
          description: `Changed ${target.email} from ${LEVEL_LABEL[target.role as Level]} to ${LEVEL_LABEL[role]}`,
          previous: { email: target.email, role: target.role },
          next: { email: target.email, role },
        });
      });
    } catch (error) {
      return mapProvisioningError(error, 'That admin was not found.');
    }
    const updated = (await this.list(adminId)).find((a) => a.userId === userId);
    if (!updated) throw adminNotFound();
    return updated;
  }

  /**
   * Removes Platform Admin access, also your own when another super admin remains. The sign-in is deleted afterwards
   * (these accounts exist only for platform work); a failure there is logged and leaves an unused account, never a
   * half-removed admin.
   */
  async remove(adminId: string, userId: string): Promise<void> {
    try {
      await this.db.withUser(adminId, async (tx) => {
        const target = (await this.fetchAdmins(tx)).find(
          (a) => a.userId === userId,
        );
        if (!target) throw adminNotFound();
        // The entry goes in FIRST: removing your own access ends your admin status, and recording needs it. If the
        // removal is then refused (the last super admin), the whole transaction rolls back and no entry remains.
        await recordAudit(tx, {
          action: 'platform_admin.removed',
          entityType: 'platform_admin',
          entityId: userId,
          description: `Removed platform admin ${target.email} (${LEVEL_LABEL[target.role as Level]})`,
          previous: {
            email: target.email,
            fullName: target.fullName,
            role: target.role,
          },
        });
        await tx.execute(
          sql`select public.platform_remove_admin(${userId}::uuid)`,
        );
      });
    } catch (error) {
      return mapProvisioningError(error, 'That admin was not found.');
    }
    await this.authAdmin.deleteUserQuietly(userId);
  }
}
