import { CanActivate, ExecutionContext, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { DatabaseService } from '../../database/database.service.js';
import { AppException } from '../app.exception.js';
import {
  ORG_SCOPED,
  REQUIRE_EXPLICIT_ORG,
  REQUIRED_PERMISSION,
} from '../decorators/decorators.js';
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

    // Opt-in (see RequireExplicitOrganization): checked before any lookup, and only after authentication, which
    // runs in an earlier guard, so an unauthenticated request is still answered 401.
    const explicit = this.reflector.getAllAndOverride<boolean>(
      REQUIRE_EXPLICIT_ORG,
      targets,
    );
    if (explicit && !hint?.trim())
      throw new AppException('VALIDATION', 'Select an organization first.', {
        code: 'ORGANIZATION_REQUIRED',
      });

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
