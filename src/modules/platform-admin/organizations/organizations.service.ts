import { Injectable, Logger } from '@nestjs/common';
import { sql } from 'drizzle-orm';
import {
  AppException,
  conflict,
  invalid,
  notFound,
} from '../../../common/app.exception.js';
import { errorChain } from '../../../common/db-errors.js';
import { Paginated } from '../../../common/dto/api-response.dto.js';
import {
  DatabaseService,
  rowsOf,
  type DbTx,
} from '../../../database/database.service.js';
import { SupabaseAdminService } from '../../auth/supabase-admin.service.js';
import { TenantProvisioningService } from '../../provisioning/tenant-provisioning.service.js';
import { StorageService } from '../../storage/storage.service.js';
import type { CreateMemberDto } from '../../team/team.dto.js';
import {
  listTeamRows,
  toTeamMemberDto,
  type TeamMemberRow,
} from '../../team/team.service.js';
import { SubscriptionsService } from '../subscriptions/subscriptions.service.js';
import { recordAudit } from '../audit/audit.service.js';
import { mapProvisioningError } from '../platform-errors.js';
import type {
  CompanyDetailDto,
  CompanyDto,
  CreatedCompanyDto,
  CreateOrganizationDto,
  OrgListQueryDto,
  PlatformOverviewDto,
  PlatformStoreDto,
  RecoveredOwnerDto,
  RecoverOwnerDto,
  TransferOwnershipDto,
  UpdateOrganizationDto,
  UpdateOrganizationStoreDto,
} from './organizations.dto.js';

type CompanyRaw = {
  id: string;
  name: string;
  slug: string;
  public_id?: string;
  status: string;
  contact_phone: string | null;
  address: string | null;
  created_at: string | Date;
  store_id: string | null;
  store_name: string | null;
  store_slug: string | null;
  owner_id: string | null;
  owner_name: string | null;
  owner_email: string | null;
  member_count: string | number | bigint;
};
type CompanyPageRaw = CompanyRaw & { total_count: string | number | bigint };
type StoreRaw = {
  id: string;
  name: string;
  slug: string;
  description: string | null;
  currency: string;
  timezone: string;
  status: string;
  contact_email: string | null;
  contact_phone: string | null;
  has_money_data: boolean;
};

/** Adds tenants.public_id to organization rows (the list functions return fixed columns). Read-only lookup. */
async function withPublicIds<T extends { id: string }>(
  tx: DbTx,
  rows: T[],
): Promise<(T & { public_id?: string })[]> {
  if (rows.length === 0) return rows;
  const ids = rows.map((r) => r.id);
  const found = rowsOf<{ tenant_id: string; public_id: string }>(
    await tx.execute(
      sql`select * from public.platform_tenant_public_ids(ARRAY[${sql.join(
        ids.map((i) => sql`${i}::uuid`),
        sql`, `,
      )}]::uuid[])`,
    ),
  );
  const byId = new Map(found.map((f) => [f.tenant_id, f.public_id]));
  return rows.map((r) => ({ ...r, public_id: byId.get(r.id) }));
}

const toCompany = (r: CompanyRaw): CompanyDto => ({
  id: r.id,
  name: r.name,
  slug: r.slug,
  publicId: r.public_id ?? '',
  status: r.status === 'suspended' ? 'suspended' : 'active',
  contactPhone: r.contact_phone,
  address: r.address,
  createdAt: new Date(r.created_at),
  storeId: r.store_id,
  storeName: r.store_name,
  storeSlug: r.store_slug,
  ownerId: r.owner_id,
  ownerName: r.owner_name,
  ownerEmail: r.owner_email,
  memberCount: Number(r.member_count),
});

const toStore = (r: StoreRaw): PlatformStoreDto => ({
  id: r.id,
  name: r.name,
  slug: r.slug,
  description: r.description,
  currency: r.currency,
  timezone: r.timezone,
  status:
    r.status === 'suspended'
      ? 'suspended'
      : r.status === 'inactive'
        ? 'inactive'
        : 'active',
  contactEmail: r.contact_email,
  contactPhone: r.contact_phone,
  hasMoneyData: r.has_money_data === true,
});

/** The fields that differ, with their before and after values, for the audit entry. */
function diff<T extends Record<string, string | null>>(before: T, after: T) {
  const keys = (Object.keys(after) as (keyof T & string)[]).filter(
    (k) => (before[k] ?? null) !== (after[k] ?? null),
  );
  const pick = (o: T) => Object.fromEntries(keys.map((k) => [k, o[k] ?? null]));
  return { keys, previous: pick(before), next: pick(after) };
}

const orgNotFound = () =>
  notFound('Organization not found.', 'ORGANIZATION_NOT_FOUND');
const memberNotFound = () =>
  notFound('That team member was not found.', 'MEMBER_NOT_FOUND');
const OWNER_PROTECTED =
  'The owner cannot be disabled or removed. Transfer ownership first.';

/**
 * Platform Admin operations on organizations. The caller was already authorised (and rate limited) by the
 * PlatformAdminGuard from the database; every SQL function re-checks. Database work runs as the admin's own request
 * context through `storeforge_app` -> `authenticated`; the service-role client is only used for Auth Admin calls,
 * and the admin functions expose organization metadata only (no catalog, customer or order data).
 */
@Injectable()
export class PlatformOrganizationsService {
  private readonly logger = new Logger(PlatformOrganizationsService.name);

  constructor(
    private readonly db: DatabaseService,
    private readonly authAdmin: SupabaseAdminService,
    private readonly storage: StorageService,
    private readonly subscriptions: SubscriptionsService,
    private readonly provisioning: TenantProvisioningService,
  ) {}

  // --- reads -------------------------------------------------------------------------------------------------------

  private fetchPage(
    tx: DbTx,
    q: {
      search: string;
      status: string;
      sortBy: string;
      sortOrder: string;
      limit: number;
    },
    page: number,
  ) {
    return tx
      .execute(
        sql`select * from public.platform_list_tenants_page(
          ${q.search || null}, ${q.status === 'all' ? null : q.status}, ${`${q.sortBy}_${q.sortOrder}`}, ${q.limit}, ${(page - 1) * q.limit})`,
      )
      .then((r) => withPublicIds(tx, rowsOf<CompanyPageRaw>(r)));
  }

  /** One page of organizations. Search, filter, sorting and paging all run in PostgreSQL. */
  async list(
    adminId: string,
    q: OrgListQueryDto,
  ): Promise<Paginated<CompanyDto>> {
    return this.db.withUser(adminId, async (tx) => {
      let page = q.page;
      let raw = await this.fetchPage(tx, q, page);
      if (raw.length === 0 && page > 1) {
        // A page past the end (an old link, or rows were removed): show the last real page instead of an empty one.
        const first = await this.fetchPage(tx, q, 1);
        page = Math.max(
          1,
          Math.ceil(Number(first[0]?.total_count ?? 0) / q.limit),
        );
        raw = page === 1 ? first : await this.fetchPage(tx, q, page);
      }
      return new Paginated(raw.map(toCompany), {
        page,
        limit: q.limit,
        total: Number(raw[0]?.total_count ?? 0),
      });
    });
  }

  /** The overview numbers, counted in SQL, plus the five newest organizations. */
  async overview(adminId: string): Promise<PlatformOverviewDto> {
    return this.db.withUser(adminId, async (tx) => {
      const [stats] = rowsOf<{
        total_tenants: string | number;
        active_tenants: string | number;
        suspended_tenants: string | number;
        total_users: string | number;
      }>(await tx.execute(sql`select * from public.platform_overview_stats()`));
      const recent = await this.fetchPage(
        tx,
        {
          search: '',
          status: 'all',
          sortBy: 'created',
          sortOrder: 'desc',
          limit: 5,
        },
        1,
      );
      return {
        totalOrganizations: Number(stats?.total_tenants ?? 0),
        active: Number(stats?.active_tenants ?? 0),
        suspended: Number(stats?.suspended_tenants ?? 0),
        totalUsers: Number(stats?.total_users ?? 0),
        recent: recent.map(toCompany),
      };
    });
  }

  private async fetchStore(
    tx: DbTx,
    tenantId: string,
  ): Promise<PlatformStoreDto | null> {
    const [row] = rowsOf<StoreRaw>(
      await tx.execute(
        sql`select * from public.platform_get_tenant_store(${tenantId}::uuid)`,
      ),
    );
    return row ? toStore(row) : null;
  }

  private async fetchCompanyRow(
    tx: DbTx,
    tenantId: string,
  ): Promise<CompanyRaw | undefined> {
    const rows = rowsOf<CompanyRaw>(
      await tx.execute(
        sql`select * from public.platform_list_tenants(${tenantId}::uuid)`,
      ),
    );
    return (await withPublicIds(tx, rows))[0];
  }

  /** Organization, its primary store and its team, in one transaction. */
  async get(adminId: string, tenantId: string): Promise<CompanyDetailDto> {
    const found = await this.db.withUser(adminId, async (tx) => {
      const row = await this.fetchCompanyRow(tx, tenantId);
      if (!row) return null;
      const store = await this.fetchStore(tx, tenantId);
      const team = await listTeamRows(tx, tenantId);
      return {
        company: toCompany(row),
        store,
        team: team.map(toTeamMemberDto),
      };
    });
    if (!found) throw orgNotFound();
    return found;
  }

  // --- create / update ---------------------------------------------------------------------------------------------

  /**
   * Database half of company creation: tenant + owner membership + store in ONE transaction via
   * platform_provision_tenant(). Idempotent for the same owner and store slug, so it is safe to retry.
   */
  private async createTenantRecords(
    adminId: string,
    ownerId: string,
    v: CreateOrganizationDto,
    ownerEmail: string,
  ) {
    // The public id is generated and retried by the shared provisioning service (a collision rolls the transaction back
    // with 'public_id_taken' and a fresh id is tried; each attempt is a new transaction, so nothing is half-written).
    return this.provisioning.withPublicId((publicId) =>
      this.provisionTenant(adminId, ownerId, v, ownerEmail, publicId),
    );
  }

  private provisionTenant(
    adminId: string,
    ownerId: string,
    v: CreateOrganizationDto,
    ownerEmail: string,
    publicId: string,
  ) {
    return this.db.withUser(adminId, async (tx) => {
      const rows = rowsOf<{
        result: {
          tenant_id: string;
          store_id: string;
          store_slug: string;
          created: boolean;
        };
      }>(
        await tx.execute(sql`select public.platform_provision_tenant(
          ${ownerId}::uuid, ${v.companyName}, ${v.storeName}, ${v.storeSlug},
          ${v.storeDescription ?? null}, ${v.contactPhone ?? null}, ${v.address ?? null}, ${publicId}) as result`),
      );
      const provisioned = rows[0]?.result;
      if (!provisioned?.tenant_id)
        throw new Error('platform_provision_tenant returned no result');
      const [{ public_id: createdPublicId }] = await withPublicIds(tx, [
        { id: provisioned.tenant_id },
      ]);
      const result = { ...provisioned, public_id: createdPublicId ?? '' };
      // Logged in the same transaction. A retry of an already created company (created = false) adds no second entry.
      if (result.created) {
        await recordAudit(tx, {
          action: 'organization.created',
          entityType: 'organization',
          entityId: result.tenant_id,
          organizationId: result.tenant_id,
          description: `Created organization "${v.companyName}" with store "${v.storeName}"`,
          next: {
            name: v.companyName,
            storeName: v.storeName,
            storeSlug: result.store_slug,
            ownerEmail,
          },
        });
        // Every tenant already has the default plan (database trigger); an admin's choice replaces it, in this transaction.
        if (v.planId)
          await this.subscriptions.assignInTx(
            tx,
            result.tenant_id,
            { planId: v.planId, billingInterval: v.billingInterval },
            { created: true },
          );
        else await this.subscriptions.auditInitial(tx, result.tenant_id);
      }
      return result;
    });
  }

  /**
   * Creates an organization and its Owner. Auth and PostgreSQL cannot share a transaction, so the order makes
   * failures cheap: pre-check the address, create the confirmed Auth user, create tenant + store + owner membership
   * atomically, and delete the Auth user again if that fails. An ambiguous failure (e.g. a dropped connection after
   * commit) is retried once - the SQL function is idempotent - before the user is removed, so a committed tenant is
   * never left without its Owner.
   */
  async create(
    adminId: string,
    v: CreateOrganizationDto,
  ): Promise<CreatedCompanyDto> {
    const free = await this.db.withUser(
      adminId,
      async (tx) =>
        rowsOf<{ ok: boolean }>(
          await tx.execute(
            sql`select public.is_store_slug_available(${v.storeSlug}) as ok`,
          ),
        )[0]?.ok === true,
    );
    if (!free)
      throw conflict(
        'That store address is not available.',
        { storeSlug: 'That address is not available' },
        'STORE_SLUG_TAKEN',
      );

    const owner = await this.authAdmin.createConfirmedUser({
      email: v.ownerEmail,
      password: v.ownerPassword,
      fullName: v.ownerName,
    });

    let records: Awaited<
      ReturnType<PlatformOrganizationsService['createTenantRecords']>
    >;
    try {
      records = await this.createTenantRecords(
        adminId,
        owner.id,
        v,
        owner.email,
      );
    } catch (first) {
      if (first instanceof AppException) {
        await this.authAdmin.deleteUserQuietly(owner.id);
        throw first;
      }
      try {
        records = await this.createTenantRecords(
          adminId,
          owner.id,
          v,
          owner.email,
        );
      } catch {
        const removed = await this.authAdmin.deleteUserQuietly(owner.id);
        this.logger.error(
          `provisioning failed (owner ${owner.id}, auth user removed: ${removed}): ${errorChain(first)}`,
        );
        throw first;
      }
    }
    return {
      tenantId: records.tenant_id,
      publicId: records.public_id,
      storeId: records.store_id,
      ownerId: owner.id,
      ownerEmail: owner.email,
    };
  }

  /** Edits name, contact phone and address. Nothing is written (or logged) when nothing changed. */
  async update(
    adminId: string,
    tenantId: string,
    v: UpdateOrganizationDto,
  ): Promise<CompanyDto> {
    try {
      await this.db.withUser(adminId, async (tx) => {
        const before = await this.fetchCompanyRow(tx, tenantId);
        if (!before) throw orgNotFound();
        const after = {
          name: v.companyName ?? before.name,
          contactPhone:
            v.contactPhone !== undefined
              ? v.contactPhone
              : before.contact_phone,
          address: v.address !== undefined ? v.address : before.address,
        };
        const d = diff(
          {
            name: before.name,
            contactPhone: before.contact_phone,
            address: before.address,
          },
          after,
        );
        if (d.keys.length === 0) return;
        const rows = rowsOf<{ ok: boolean }>(
          await tx.execute(
            sql`select public.platform_update_tenant(${tenantId}::uuid, ${after.name}, ${after.contactPhone}, ${after.address}) as ok`,
          ),
        );
        if (rows[0]?.ok !== true) throw orgNotFound();
        await recordAudit(tx, {
          action: 'organization.updated',
          entityType: 'organization',
          entityId: tenantId,
          organizationId: tenantId,
          description: `Updated organization "${before.name}": ${d.keys.join(', ')}`,
          previous: d.previous,
          next: d.next,
        });
      });
    } catch (error) {
      return mapProvisioningError(error);
    }
    return (await this.get(adminId, tenantId)).company;
  }

  async setStatus(
    adminId: string,
    tenantId: string,
    status: 'active' | 'suspended',
  ): Promise<CompanyDto> {
    const found = await this.db.withUser(adminId, async (tx) => {
      const before = await this.fetchCompanyRow(tx, tenantId);
      if (!before) return false;
      const rows = rowsOf<{ ok: boolean }>(
        await tx.execute(
          sql`select public.platform_set_tenant_status(${tenantId}::uuid, ${status}) as ok`,
        ),
      );
      if (rows[0]?.ok !== true) return false;
      if (before.status !== status) {
        await recordAudit(tx, {
          action:
            status === 'suspended'
              ? 'organization.suspended'
              : 'organization.reactivated',
          entityType: 'organization',
          entityId: tenantId,
          organizationId: tenantId,
          description: `${status === 'suspended' ? 'Suspended' : 'Reactivated'} organization "${before.name}"`,
          previous: { status: before.status },
          next: { status },
        });
      }
      return true;
    });
    if (!found) throw orgNotFound();
    return (await this.get(adminId, tenantId)).company;
  }

  /**
   * Deletes an organization for good (the action is audited first, in the same transaction): the tenant and everything under it in ONE database transaction, then - after
   * that has committed - the Auth accounts of people who belonged to no other organization, then its stored files.
   * Auth and file cleanup are best effort and logged: the database is authoritative, so a failure there leaves an
   * unused sign-in or file, never a half-deleted organization.
   */
  async remove(
    adminId: string,
    token: string,
    tenantId: string,
  ): Promise<void> {
    let orphaned: string[];
    try {
      orphaned = await this.db.withUser(adminId, async (tx) => {
        const company = await this.fetchCompanyRow(tx, tenantId);
        if (!company) throw orgNotFound();
        // Recorded first, in the same transaction: the log copies the organization's name now, and if the deletion is
        // refused the entry rolls back with it. Only plain facts are kept (never member credentials).
        await recordAudit(tx, {
          action: 'organization.deleted',
          entityType: 'organization',
          entityId: tenantId,
          organizationId: tenantId,
          description: `Deleted organization ${company.name}`,
          previous: {
            name: company.name,
            slug: company.slug,
            status: company.status,
            ownerEmail: company.owner_email,
            memberCount: Number(company.member_count),
          },
        });
        const rows = rowsOf<{ orphans: unknown }>(
          await tx.execute(
            sql`select public.platform_delete_tenant(${tenantId}::uuid) as orphans`,
          ),
        );
        const value = rows[0]?.orphans ?? [];
        return (
          typeof value === 'string' ? JSON.parse(value) : value
        ) as string[];
      });
    } catch (error) {
      return mapProvisioningError(error);
    }
    await Promise.all(
      orphaned.map((id) => this.authAdmin.deleteUserQuietly(id)),
    );
    await this.storage.removeTenantObjects(token, tenantId);
  }

  /** Edits the primary store: name, description, contact details, currency and timezone (never the address or logo). */
  async updateStore(
    adminId: string,
    tenantId: string,
    v: UpdateOrganizationStoreDto,
  ): Promise<PlatformStoreDto> {
    try {
      await this.db.withUser(adminId, async (tx) => {
        const store = await this.fetchStore(tx, tenantId);
        if (!store)
          throw notFound(
            'This organization does not have a store.',
            'STORE_NOT_FOUND',
          );
        const after = {
          name: v.name ?? store.name,
          description:
            v.description !== undefined ? v.description : store.description,
          contactEmail:
            v.contactEmail !== undefined ? v.contactEmail : store.contactEmail,
          contactPhone:
            v.contactPhone !== undefined ? v.contactPhone : store.contactPhone,
          currency: v.currency ?? store.currency,
          timezone: v.timezone ?? store.timezone,
        };
        const d = diff(
          {
            name: store.name,
            description: store.description,
            contactEmail: store.contactEmail,
            contactPhone: store.contactPhone,
            currency: store.currency,
            timezone: store.timezone,
          },
          after,
        );
        if (d.keys.length === 0) return;
        const rows = rowsOf<{ ok: boolean }>(
          await tx.execute(
            sql`select public.platform_update_store(${tenantId}::uuid, ${store.id}::uuid, ${after.name}, ${after.description}, ${after.contactEmail}, ${after.contactPhone}, ${after.currency}, ${after.timezone}) as ok`,
          ),
        );
        if (rows[0]?.ok !== true)
          throw notFound(
            'This organization does not have a store.',
            'STORE_NOT_FOUND',
          );
        await recordAudit(tx, {
          action: 'store.updated',
          entityType: 'store',
          entityId: store.id,
          organizationId: tenantId,
          description: `Updated store "${store.name}": ${d.keys.join(', ')}`,
          previous: d.previous,
          next: d.next,
        });
      });
    } catch (error) {
      return mapProvisioningError(error);
    }
    const store = await this.db.withUser(adminId, (tx) =>
      this.fetchStore(tx, tenantId),
    );
    if (!store)
      throw notFound(
        'This organization does not have a store.',
        'STORE_NOT_FOUND',
      );
    return store;
  }

  // --- team --------------------------------------------------------------------------------------------------------

  /**
   * Adds a team member account to any organization, the same account the Owner can create. The Auth user is created
   * first; the membership is then written by platform_add_member(), which re-checks the Platform Admin and refuses the
   * Owner role. If that fails the Auth user is deleted again.
   */
  async addMember(adminId: string, tenantId: string, v: CreateMemberDto) {
    const user = await this.authAdmin.createConfirmedUser({
      email: v.email,
      password: v.password,
      fullName: v.fullName,
    });
    try {
      await this.db.withUser(adminId, async (tx) => {
        await tx.execute(
          sql`select public.platform_add_member(${tenantId}::uuid, ${user.id}::uuid, ${JSON.stringify(v.permissions)}::jsonb)`,
        );
        // Same transaction as the membership, so a member never exists without its log entry. No password is logged.
        await recordAudit(tx, {
          action: 'team_member.added',
          entityType: 'team_member',
          entityId: user.id,
          organizationId: tenantId,
          description: `Added team member ${user.email}`,
          next: {
            email: user.email,
            fullName: v.fullName,
            permissions: v.permissions,
          },
        });
      });
    } catch (error) {
      await this.authAdmin.deleteUserQuietly(user.id);
      return mapProvisioningError(error);
    }
    return { userId: user.id, email: user.email };
  }

  private findMember(team: TeamMemberRow[], userId: string) {
    const m = team.find((t) => t.userId === userId);
    if (!m) throw memberNotFound();
    return m;
  }

  /** Disables (no access, reversible) or reactivates a team member. The Owner cannot be disabled. */
  async setMemberStatus(
    adminId: string,
    tenantId: string,
    userId: string,
    status: 'active' | 'disabled',
  ) {
    try {
      await this.db.withUser(adminId, async (tx) => {
        const target = this.findMember(
          await listTeamRows(tx, tenantId),
          userId,
        );
        if (target.role === 'owner')
          throw invalid(OWNER_PROTECTED, undefined, 'OWNER_PROTECTED');
        if (target.status === status) return;
        const rows = rowsOf<{ ok: boolean }>(
          await tx.execute(
            sql`select public.platform_set_member_status(${tenantId}::uuid, ${userId}::uuid, ${status}) as ok`,
          ),
        );
        if (rows[0]?.ok !== true) throw memberNotFound();
        await recordAudit(tx, {
          action:
            status === 'disabled'
              ? 'team_member.disabled'
              : 'team_member.reactivated',
          entityType: 'team_member',
          entityId: userId,
          organizationId: tenantId,
          description: `${status === 'disabled' ? 'Disabled' : 'Reactivated'} team member ${target.email}`,
          previous: { email: target.email, status: target.status },
          next: { email: target.email, status },
        });
      });
    } catch (error) {
      return mapProvisioningError(error, 'That team member was not found.');
    }
    const team = await this.db.withUser(adminId, (tx) =>
      listTeamRows(tx, tenantId),
    );
    return toTeamMemberDto(this.findMember(team, userId));
  }

  /** Removes a team member. Their sign-in is deleted too when they belong to no other organization. The Owner cannot be removed. */
  async removeMember(
    adminId: string,
    tenantId: string,
    userId: string,
  ): Promise<void> {
    let orphaned = false;
    try {
      orphaned = await this.db.withUser(adminId, async (tx) => {
        const target = this.findMember(
          await listTeamRows(tx, tenantId),
          userId,
        );
        if (target.role === 'owner')
          throw invalid(OWNER_PROTECTED, undefined, 'OWNER_PROTECTED');
        const rows = rowsOf<{ orphaned: boolean }>(
          await tx.execute(
            sql`select public.platform_remove_member(${tenantId}::uuid, ${userId}::uuid) as orphaned`,
          ),
        );
        await recordAudit(tx, {
          action: 'team_member.removed',
          entityType: 'team_member',
          entityId: userId,
          organizationId: tenantId,
          description: `Removed team member ${target.email}`,
          previous: {
            email: target.email,
            fullName: target.fullName,
            status: target.status,
            permissions: target.permissions,
          },
        });
        return rows[0]?.orphaned === true;
      });
    } catch (error) {
      return mapProvisioningError(error, 'That team member was not found.');
    }
    if (orphaned) await this.authAdmin.deleteUserQuietly(userId); // after the commit; a failure is logged, never half-applied
  }

  // --- ownership ---------------------------------------------------------------------------------------------------

  /** The shared tail of a transfer and a recovery: one SQL call, then one audit entry, inside the caller's transaction. */
  private async assignOwner(
    tx: DbTx,
    tenantId: string,
    newOwnerId: string,
    previousOwner: 'keep' | 'disable',
    mode: 'transfer' | 'recovery',
    team: TeamMemberRow[],
    companyName: string,
    newOwnerEmail: string,
  ) {
    const rows = rowsOf<{
      r: {
        previous_owner_id: string | null;
        new_owner_id: string;
        created_membership: boolean;
      };
    }>(
      await tx.execute(
        sql`select public.platform_assign_owner(${tenantId}::uuid, ${newOwnerId}::uuid, ${previousOwner === 'disable' ? 'disabled' : 'active'}) as r`,
      ),
    );
    const change = rows[0]?.r;
    if (!change?.new_owner_id)
      throw new Error('platform_assign_owner returned no result');
    const old = change.previous_owner_id
      ? team.find((t) => t.userId === change.previous_owner_id)
      : undefined;
    await recordAudit(tx, {
      action: 'ownership.transferred',
      entityType: 'team_member',
      entityId: newOwnerId,
      organizationId: tenantId,
      description: old
        ? `${mode === 'recovery' ? 'Recovered ownership of' : 'Transferred ownership of'} "${companyName}" from ${old.email} to ${newOwnerEmail}`
        : `Appointed ${newOwnerEmail} as owner of "${companyName}" (no previous owner)`,
      previous: {
        ownerId: change.previous_owner_id,
        ownerEmail: old?.email ?? null,
      },
      next: {
        ownerId: newOwnerId,
        ownerEmail: newOwnerEmail,
        mode,
        previousOwnerStatus: old
          ? previousOwner === 'disable'
            ? 'disabled'
            : 'active'
          : null,
        newAccount: change.created_membership,
      },
    });
  }

  /** Hands ownership to an existing, active team member. Atomic: the old owner becomes a team member, never zero or two owners. */
  async transferOwnership(
    adminId: string,
    tenantId: string,
    v: TransferOwnershipDto,
  ): Promise<CompanyDetailDto> {
    try {
      await this.db.withUser(adminId, async (tx) => {
        const company = await this.fetchCompanyRow(tx, tenantId);
        if (!company) throw orgNotFound();
        const team = await listTeamRows(tx, tenantId);
        const target = this.findMember(team, v.userId);
        if (target.role === 'owner')
          throw invalid(
            'That person is already the owner.',
            undefined,
            'ALREADY_OWNER',
          );
        if (target.status !== 'active')
          throw invalid(
            'Only an active team member can become the owner. Reactivate them first.',
            undefined,
            'OWNER_NOT_ELIGIBLE',
          );
        await this.assignOwner(
          tx,
          tenantId,
          v.userId,
          v.previousOwner ?? 'keep',
          'transfer',
          team,
          company.name,
          target.email,
        );
      });
    } catch (error) {
      return mapProvisioningError(error);
    }
    return this.get(adminId, tenantId);
  }

  /**
   * Owner recovery: creates a brand-new owner account and makes it the owner, for an organization whose owner is lost
   * or missing. The Auth account is created first and deleted again if the database step fails. The password is set
   * once here, never stored by us, and never written to the audit log.
   */
  async recoverOwner(
    adminId: string,
    tenantId: string,
    v: RecoverOwnerDto,
  ): Promise<RecoveredOwnerDto> {
    const exists = await this.db.withUser(adminId, async (tx) =>
      Boolean(await this.fetchCompanyRow(tx, tenantId)),
    );
    if (!exists) throw orgNotFound();
    const owner = await this.authAdmin.createConfirmedUser({
      email: v.ownerEmail,
      password: v.ownerPassword,
      fullName: v.ownerName,
    });
    try {
      await this.db.withUser(adminId, async (tx) => {
        const company = await this.fetchCompanyRow(tx, tenantId);
        if (!company) throw orgNotFound();
        await this.assignOwner(
          tx,
          tenantId,
          owner.id,
          v.previousOwner ?? 'keep',
          'recovery',
          await listTeamRows(tx, tenantId),
          company.name,
          owner.email,
        );
      });
    } catch (error) {
      await this.authAdmin.deleteUserQuietly(owner.id);
      return mapProvisioningError(error);
    }
    return { email: owner.email };
  }
}
