import { and, asc, eq } from 'drizzle-orm';
import type { DbTx } from '../../database/database.service.js';
import { memberships, tenants } from '../../database/schema/index.js';
import type {
  MemberCapability,
  MemberPermissions,
} from '../../database/schema/enums.js';
import { isRole, type Role } from '../constants/permissions.js';
import { AppException } from '../app.exception.js';
import { ORGANIZATION_HEADER } from '../constants/error-codes.js';
import type { OrgContext } from '../interfaces/request-context.js';

export { ORGANIZATION_HEADER };

export type TenantSummary = {
  id: string;
  name: string;
  slug: string;
  publicId: string;
};
export type OrgMembership = {
  tenant: TenantSummary;
  role: Role;
  permissions: MemberPermissions;
  capabilities: MemberCapability[];
  joinedAt: Date;
};

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * The caller's organizations, from Postgres, in ONE query (membership joined to tenant). RLS limits the rows to the
 * caller; the explicit status filters make the intent independent of policy details: a disabled membership or a
 * suspended organization grants nothing.
 */
export async function listActiveMemberships(
  tx: DbTx,
  userId: string,
): Promise<OrgMembership[]> {
  const rows = await tx
    .select({
      role: memberships.role,
      permissions: memberships.permissions,
      capabilities: memberships.capabilities,
      joinedAt: memberships.createdAt,
      tenant: {
        id: tenants.id,
        name: tenants.name,
        slug: tenants.slug,
        publicId: tenants.publicId,
      },
    })
    .from(memberships)
    .innerJoin(tenants, eq(tenants.id, memberships.tenantId))
    .where(
      and(
        eq(memberships.userId, userId),
        eq(memberships.status, 'active'),
        eq(tenants.status, 'active'),
      ),
    )
    .orderBy(asc(memberships.createdAt), asc(tenants.id));
  return rows.filter((r) => isRole(r.role));
}

/**
 * Picks the organization to act on. The header value is a HINT that must match a verified membership: an id the
 * caller does not belong to is refused (never silently replaced), so a request can never land in a different
 * organization than the one it named. Without a hint the caller's first organization is used.
 */
export function resolveOrganization(
  userId: string,
  all: readonly OrgMembership[],
  hint: string | undefined,
): OrgContext {
  if (all.length === 0)
    throw new AppException(
      'NOT_FOUND',
      'No active workspace. Please contact your administrator.',
      { code: 'NO_WORKSPACE' },
    );
  let chosen: OrgMembership | undefined;
  if (hint) {
    chosen = UUID.test(hint)
      ? all.find((m) => m.tenant.id.toLowerCase() === hint.toLowerCase())
      : undefined;
    if (!chosen)
      throw new AppException(
        'FORBIDDEN',
        'You do not have access to this workspace.',
        { code: 'ORGANIZATION_ACCESS_DENIED' },
      );
  } else {
    chosen = all[0];
  }
  return {
    userId,
    tenantId: chosen.tenant.id,
    tenantName: chosen.tenant.name,
    tenantSlug: chosen.tenant.slug,
    tenantPublicId: chosen.tenant.publicId,
    role: chosen.role,
    permissions: chosen.permissions,
    capabilities: chosen.capabilities,
  };
}
