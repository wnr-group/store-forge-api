import { CanActivate, ExecutionContext, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { AppException } from '../app.exception.js';
import { IS_PUBLIC } from '../decorators/decorators.js';
import type { AuthenticatedRequest } from '../interfaces/request-context.js';
import { SupabaseJwtService } from '../../modules/auth/supabase-jwt.service.js';

/** Global guard: every route needs a valid Supabase access token unless it is marked `@Public()`. */
@Injectable()
export class JwtAuthGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly jwt: SupabaseJwtService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    if (
      this.reflector.getAllAndOverride<boolean>(IS_PUBLIC, [
        context.getHandler(),
        context.getClass(),
      ])
    )
      return true;

    const request = context.switchToHttp().getRequest<AuthenticatedRequest>();
    const header = request.headers.authorization;
    const [scheme, token] = typeof header === 'string' ? header.split(' ') : [];
    if (scheme?.toLowerCase() !== 'bearer' || !token) {
      throw new AppException('UNAUTHENTICATED', 'Authentication required.', {
        code: 'AUTH_REQUIRED',
      });
    }

    const identity = await this.jwt.verify(token);
    request.user = { id: identity.id, email: identity.email, token };
    return true;
  }
}
