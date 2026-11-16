import { Injectable } from '@nestjs/common';
import { and, eq } from 'drizzle-orm';
import { forbidden } from '../../common/errors/app-exception.js';
import { DatabaseService } from '../database/database.service.js';
import { memberships } from '../database/schema/memberships.js';
import { tenants } from '../database/schema/tenants.js';
import type { TenantContext } from './auth.types.js';
import type { Role } from './generated/permissions.js';
import type { MemberPermissions } from '../database/schema/enums.js';

@Injectable()
export class TenantAccessService {
  constructor(private readonly databaseService: DatabaseService) {}

  /**
   * Resolves the caller's active membership in an active tenant (AC-B-26 to AC-B-31).
   * Runs inside withUser context so RLS and tenant access policies apply.
   */
  async resolve(userId: string, tenantId: string): Promise<TenantContext> {
    return this.databaseService.withUser(userId, async (tx) => {
      const rows = await tx
        .select({
          role: memberships.role,
          permissions: memberships.permissions,
        })
        .from(memberships)
        .innerJoin(tenants, eq(tenants.id, memberships.tenantId))
        .where(
          and(
            eq(memberships.userId, userId),
            eq(memberships.tenantId, tenantId),
            eq(memberships.status, 'active'),
            eq(tenants.status, 'active'),
          ),
        );

      if (!rows || rows.length === 0) {
        throw forbidden('Access to tenant denied.');
      }

      return {
        tenantId,
        userId,
        role: rows[0].role as Role,
        permissions: rows[0].permissions as MemberPermissions,
      };
    });
  }
}
