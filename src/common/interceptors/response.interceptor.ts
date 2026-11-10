import {
  CallHandler,
  ExecutionContext,
  Injectable,
  NestInterceptor,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { map, Observable } from 'rxjs';
import { RESPONSE_MESSAGE } from '../decorators/response-message.decorator.js';
import { Paginated, toMeta } from '../dto/api-response.dto.js';

/** Wraps every successful result in `{ success, message, data, meta? }`. `meta` only exists for `Paginated` results. */
@Injectable()
export class ResponseInterceptor implements NestInterceptor {
  constructor(private readonly reflector: Reflector) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const message =
      this.reflector.getAllAndOverride<string>(RESPONSE_MESSAGE, [
        context.getHandler(),
        context.getClass(),
      ]) ?? 'Request completed successfully';
    return next.handle().pipe(
      map((result) => {
        if (result instanceof Paginated)
          return {
            success: true,
            message,
            data: result.items,
            meta: toMeta(result.meta),
          };
        return {
          success: true,
          message,
          data: result === undefined ? null : result,
        };
      }),
    );
  }
}
