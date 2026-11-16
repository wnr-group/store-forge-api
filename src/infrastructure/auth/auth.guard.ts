import {
  Injectable,
  type CanActivate,
  type ExecutionContext,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Request } from 'express';
import { unauthenticated } from '../../common/errors/app-exception.js';
import { IS_PUBLIC_KEY } from './decorators.js';
import { JwksService } from './jwks.service.js';

@Injectable()
export class AuthGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly jwksService: JwksService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);

    if (isPublic) {
      return true;
    }

    const request = context.switchToHttp().getRequest<Request>();
    const authHeader = request.headers.authorization;

    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      throw unauthenticated('Missing or malformed Authorization header.');
    }

    const token = authHeader.slice(7).trim();
    if (!token) {
      throw unauthenticated('Missing or malformed Authorization header.');
    }

    const user = await this.jwksService.verifyToken(token);
    request.auth = user;

    return true;
  }
}
