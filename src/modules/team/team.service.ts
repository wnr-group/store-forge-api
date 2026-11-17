import { Injectable } from '@nestjs/common';
import { and, eq, ne, sql } from 'drizzle-orm';
import {
  AppException,
  forbidden,
  invalid,
  notFound,
} from '../../common/app.exception.js';
import { MEMBER_ROLE, roleLabel } from '../../common/constants/permissions.js';
import { errorChain, mapErrors } from '../../common/db-errors.js';
import type { OrgContext } from '../../common/interfaces/request-context.js';
import {
  DatabaseService,
  rowsOf,
  type DbTx,
} from '../../database/database.service.js';
import { memberships } from '../../database/schema/index.js';
import type { MemberPermissions } from '../../database/schema/enums.js';
import { SupabaseAdminService } from '../auth/supabase-admin.service.js';
import type {
  CreatedMemberDto,
  CreateMemberDto,
  TeamMemberDto,
  UpdateMemberDto,
} from './team.dto.js';

type TeamRaw = {
  user_id: string;
  full_name: string | null;
  email: string;
  role: string;
  status: string;
  joined_at: string | Date;
  permissions: MemberPermissions | null;
};

export type TeamMemberRow = Omit<TeamMemberDto, 'roleLabel'> & {
  permissions: MemberPermissions;
};

/** Shared by the platform organization page and the Owner's Team page (the SQL function authorises both). */
export async function listTeamRows(
  tx: DbTx,
  tenantId: string,
): Promise<TeamMemberRow[]> {
  const rows = rowsOf<TeamRaw>(
    await tx.execute(
      sql`select * from public.list_tenant_team(${tenantId}::uuid)`,
    ),
  );
  return rows.map((r) => ({
    userId: r.user_id,
    fullName: r.full_name,
    email: r.email,
    role: r.role,
    status: r.status === 'disabled' ? 'disabled' : 'active',
    joinedAt: new Date(r.joined_at),
    permissions: r.permissions ?? {},
  }));
}

export const toTeamMemberDto = (m: TeamMemberRow): TeamMemberDto => ({
  ...m,
  roleLabel: roleLabel(m.role as 'owner' | 'admin' | 'staff', m.permissions),
  permissions: m.permissions as Record<string, string>,
});

const memberNotFound = () =>
  notFound('That team member was not found.', 'MEMBER_NOT_FOUND');

/** Maps the SQL functions' RAISE codes to client-safe errors. Anything unrecognised is rethrown (logged, hidden). */
function mapTeamError(error: unknown): never {
  if (error instanceof AppException) throw error;
  const msg = errorChain(error);
  if (msg.includes('not_found')) throw memberNotFound();
  if (msg.includes('cannot_remove_self'))
    throw invalid(
      'You cannot remove yourself.',
      undefined,
      'CANNOT_REMOVE_SELF',
    );
  if (msg.includes('invalid_input'))
    throw invalid('Please check the details you entered.');
  if (msg.includes('forbidden')) throw forbidden();
  throw error;
}

/**
 * Owner-only team management for the caller's organization.
 *
 * The organization is never taken from input: it is the membership the guards resolved from the database, and the
 * `members:manage` permission (Owner only) was already required. The Auth Admin API (service-role key) is only reached
 * after that, and the membership row is written in a transaction acting as the Owner, so RLS
 * (memberships_insert_managers) independently refuses another organization's id, the 'owner' role, or self-assignment.
 */
@Injectable()
export class TeamService {
  constructor(
    private readonly db: DatabaseService,
    private readonly authAdmin: SupabaseAdminService,
  ) {}

  async list(ctx: OrgContext): Promise<TeamMemberDto[]> {
    const rows = await this.db.withUser(ctx.userId, (tx) =>
      listTeamRows(tx, ctx.tenantId),
    );
    return rows.map(toTeamMemberDto);
  }

  /**
   * Creates a team member account and links it to the Owner's organization. If the membership insert fails the
   * freshly created Auth user is deleted again, so no orphaned account (and no reserved e-mail) remains.
   */
  async create(
    ctx: OrgContext,
    dto: CreateMemberDto,
  ): Promise<CreatedMemberDto> {
    const user = await this.authAdmin.createConfirmedUser({
      email: dto.email,
      password: dto.password,
      fullName: dto.fullName,
    });
    try {
      await mapErrors(() =>
        this.db.withUser(ctx.userId, (tx) =>
          tx.insert(memberships).values({
            tenantId: ctx.tenantId,
            userId: user.id,
            role: MEMBER_ROLE,
            permissions: dto.permissions,
          }),
        ),
      );
    } catch (e) {
      await this.authAdmin.deleteUserQuietly(user.id);
      throw e;
    }
    return { userId: user.id, email: user.email };
  }

  /** Edit name and permissions of a team member (never the Owner, never yourself: enforced by RLS and the SQL function). */
  async update(
    ctx: OrgContext,
    userId: string,
    dto: UpdateMemberDto,
  ): Promise<TeamMemberDto> {
    let renamed: string | undefined;
    try {
      await mapErrors(() =>
        this.db.withUser(ctx.userId, async (tx) => {
          const guard = and(
            eq(memberships.tenantId, ctx.tenantId),
            eq(memberships.userId, userId),
            ne(memberships.role, 'owner'),
            ne(memberships.userId, ctx.userId),
          );
          if (dto.permissions) {
            const updated = await tx
              .update(memberships)
              .set({ permissions: dto.permissions })
              .where(guard)
              .returning({ id: memberships.id });
            if (updated.length !== 1) throw memberNotFound();
          } else {
            const exists = await tx
              .select({ id: memberships.id })
              .from(memberships)
              .where(guard);
            if (exists.length !== 1) throw memberNotFound();
          }
          if (dto.fullName !== undefined) {
            await tx.execute(
              sql`select public.update_team_member_name(${ctx.tenantId}::uuid, ${userId}::uuid, ${dto.fullName})`,
            );
            renamed = dto.fullName;
          }
        }),
      );
    } catch (e) {
      mapTeamError(e);
    }
    if (renamed !== undefined)
      await this.authAdmin.setUserFullName(userId, renamed); // best effort
    return this.getOne(ctx, userId);
  }

  private async getOne(
    ctx: OrgContext,
    userId: string,
  ): Promise<TeamMemberDto> {
    const found = (await this.list(ctx)).find((m) => m.userId === userId);
    if (!found) throw memberNotFound();
    return found;
  }

  /** Deactivate (status 'disabled': no access at all, reversible) or re-activate a member. */
  async setStatus(
    ctx: OrgContext,
    userId: string,
    status: 'active' | 'disabled',
  ): Promise<TeamMemberDto> {
    await mapErrors(() =>
      this.db.withUser(ctx.userId, async (tx) => {
        const updated = await tx
          .update(memberships)
          .set({ status })
          .where(
            and(
              eq(memberships.tenantId, ctx.tenantId),
              eq(memberships.userId, userId),
              ne(memberships.role, 'owner'),
              ne(memberships.userId, ctx.userId),
            ),
          )
          .returning({ id: memberships.id });
        if (updated.length !== 1) throw memberNotFound();
      }),
    );
    return this.getOne(ctx, userId);
  }

  /** Removes the membership; the Auth account is deleted too when it has no other membership. */
  async remove(ctx: OrgContext, userId: string): Promise<void> {
    let orphaned = false;
    try {
      orphaned = await this.db.withUser(ctx.userId, async (tx) => {
        const rows = rowsOf<{ orphaned: boolean }>(
          await tx.execute(
            sql`select public.remove_team_member(${ctx.tenantId}::uuid, ${userId}::uuid) as orphaned`,
          ),
        );
        return rows[0]?.orphaned === true;
      });
    } catch (e) {
      mapTeamError(e);
    }
    if (orphaned) await this.authAdmin.deleteUserQuietly(userId);
  }

  /** Admin-assisted password reset by the Owner for one of their own non-owner members. */
  async resetPassword(
    ctx: OrgContext,
    userId: string,
    password: string,
  ): Promise<void> {
    const team = await this.db.withUser(ctx.userId, (tx) =>
      listTeamRows(tx, ctx.tenantId),
    );
    const target = team.find((m) => m.userId === userId);
    if (!target || target.role === 'owner') throw memberNotFound();
    await this.authAdmin.setUserPassword(userId, password);
  }
}
