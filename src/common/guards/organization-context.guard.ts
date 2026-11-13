import { CanActivate, ExecutionContext, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { DatabaseService } from '../../database/database.service.js';
import { ORG_SCOPED, REQUIRED_PERMISSION } from '../decorators/decorators.js';
import type { AuthenticatedRequest } from '../interfaces/request-context.js';
import {
  listActiveMemberships,
  ORGANIZATION_HEADER,
  resolveOrganization,
} from '../tenancy/memberships.js';

/**
 * Resolves the organization for `@OrgScoped()` routes. Identity comes from the verified token (JwtAuthGuard);
 * membership, role and permissions come from Postgres. The organization id the client names is only checked against
 * those memberships, never trusted.
 */
@Injectable()
export class OrganizationContextGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly db: DatabaseService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const targets = [context.getHandler(), context.getClass()];
    const scoped =
      this.reflector.getAllAndOverride<boolean>(ORG_SCOPED, targets) ||
      this.reflector.getAllAndOverride<string>(REQUIRED_PERMISSION, targets);
    if (!scoped) return true;

    const request = context.switchToHttp().getRequest<AuthenticatedRequest>();
    const header = request.headers[ORGANIZATION_HEADER];
    const hint = Array.isArray(header) ? header[0] : header;

    const all = await this.db.withUser(request.user.id, (tx) =>
      listActiveMemberships(tx, request.user.id),
    );
    request.org = resolveOrganization(
      request.user.id,
      all,
      hint?.trim() || undefined,
    );
    return true;
  }
}
