import {
  Injectable,
  type CanActivate,
  type ExecutionContext,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Request } from 'express';
import { unauthenticated } from '../../common/errors/app-exception.js';
import { IS_PUBLIC_KEY, REQUIRE_LIVE_AUTH_KEY } from './decorators.js';
import { LiveAuthService } from './live-auth.service.js';

@Injectable()
export class LiveAuthGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly liveAuthService: LiveAuthService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);

    if (isPublic) {
      return true;
    }

    const requireLiveAuth = this.reflector.getAllAndOverride<boolean>(
      REQUIRE_LIVE_AUTH_KEY,
      [context.getHandler(), context.getClass()],
    );

    if (!requireLiveAuth) {
      return true;
    }

    const request = context.switchToHttp().getRequest<Request>();
    const auth = request.auth;

    if (!auth || !auth.userId) {
      throw unauthenticated('Invalid or expired session.');
    }

    const authHeader = request.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      throw unauthenticated('Invalid or expired session.');
    }

    const token = authHeader.slice(7).trim();
    if (!token) {
      throw unauthenticated('Invalid or expired session.');
    }

    await this.liveAuthService.verifyUser(token, auth.userId);

    return true;
  }
}
