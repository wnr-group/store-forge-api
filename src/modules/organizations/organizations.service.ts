import { Injectable } from '@nestjs/common';
import {
  accessEntries,
  effectiveCapabilities,
  roleLabel,
} from '../../common/constants/permissions.js';
import type { OrgContext } from '../../common/interfaces/request-context.js';
import { listActiveMemberships } from '../../common/tenancy/memberships.js';
import { DatabaseService } from '../../database/database.service.js';
import {
  getPrimaryStoreInTx,
  hasMoneyData,
  toStoreDto,
} from '../store/store.service.js';
import type {
  CurrentOrganizationDto,
  OrganizationSummaryDto,
} from './organizations.dto.js';

@Injectable()
export class OrganizationsService {
  constructor(private readonly db: DatabaseService) {}

  /** The organizations the verified user actively belongs to. */
  async listMine(userId: string): Promise<OrganizationSummaryDto[]> {
    const all = await this.db.withUser(userId, (tx) =>
      listActiveMemberships(tx, userId),
    );
    return all.map((m) => ({
      id: m.tenant.id,
      name: m.tenant.name,
      slug: m.tenant.slug,
      publicId: m.tenant.publicId,
      role: m.role,
      permissions: m.permissions as Record<string, string>,
      capabilities: effectiveCapabilities(m.role, m.capabilities),
      joinedAt: m.joinedAt,
    }));
  }

  /** The resolved organization with the caller's effective access and the organization's primary store. */
  async current(ctx: OrgContext): Promise<CurrentOrganizationDto> {
    const store = await this.db.withUser(ctx.userId, async (tx) => {
      const s = await getPrimaryStoreInTx(tx, ctx.tenantId);
      return s ? toStoreDto(s, await hasMoneyData(tx, ctx.tenantId)) : null;
    });
    return {
      organization: {
        id: ctx.tenantId,
        name: ctx.tenantName,
        slug: ctx.tenantSlug,
        publicId: ctx.tenantPublicId,
      },
      role: ctx.role,
      roleLabel: roleLabel(ctx.role, ctx.permissions),
      permissions: ctx.permissions as Record<string, string>,
      capabilities: effectiveCapabilities(ctx.role, ctx.capabilities),
      access: accessEntries(ctx.role, ctx.permissions),
      store,
    };
  }
}
