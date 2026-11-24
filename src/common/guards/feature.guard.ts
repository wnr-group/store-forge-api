import { CanActivate, ExecutionContext, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { FeatureKey } from '../constants/plan-catalog.js';
import { EntitlementsService } from '../../modules/entitlements/entitlements.service.js';
import { REQUIRED_FEATURE } from '../decorators/decorators.js';
import type { AuthenticatedRequest } from '../interfaces/request-context.js';

/**
 * Enforces `@RequireFeature()`: the organization's plan must include the feature, or the request ends with 403 before the handler runs.
 * It runs after the organization is resolved and the member's own permission is checked, so an unauthenticated or unauthorised caller is
 * still answered 401 or 403 first. The answer comes from the database through EntitlementsService, never from the request.
 */
@Injectable()
export class FeatureGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly entitlements: EntitlementsService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const feature = this.reflector.getAllAndOverride<FeatureKey | undefined>(
      REQUIRED_FEATURE,
      [context.getHandler(), context.getClass()],
    );
    if (!feature) return true;
    const request = context.switchToHttp().getRequest<AuthenticatedRequest>();
    // A route that names a feature but is not organization-scoped is a coding mistake: refuse rather than skip the check.
    if (!request.org)
      throw new Error('RequireFeature used on a route without @OrgScoped()');
    await this.entitlements.assertFeatureAs(
      request.org.userId,
      request.org.tenantId,
      feature,
    );
    return true;
  }
}
