import { applyDecorators, type Type } from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiExtension,
  ApiExtraModels,
  ApiHeader,
  ApiOkResponse,
  ApiQuery,
  ApiResponse,
  getSchemaPath,
} from '@nestjs/swagger';
import { PagedResponseDto } from '../dto/paged-response.dto.js';
import type { Permission } from '../../infrastructure/auth/generated/permissions.js';
import { ErrorResponseDto } from './error-response.dto.js';

/**
 * Marks an endpoint as public in Swagger documentation:
 * Removes bearer authentication requirements and sets `x-public: true`.
 */
export function ApiPublic() {
  return applyDecorators(ApiExtension('x-public', true));
}

/**
 * Documents an endpoint as requiring Supabase bearer authentication.
 */
export function ApiAuth() {
  return applyDecorators(
    ApiBearerAuth('bearer'),
    ApiResponse({
      status: 401,
      description: 'Unauthorized: Invalid or expired session.',
      type: ErrorResponseDto,
    }),
  );
}

/**
 * Documents an endpoint as requiring both Supabase bearer authentication
 * and an active tenant context via the `X-Tenant-Id` header.
 */
export function ApiTenantAuth(permission?: Permission) {
  const decorators: Array<
    ClassDecorator | MethodDecorator | PropertyDecorator
  > = [
    ApiBearerAuth('bearer'),
    ApiHeader({
      name: 'X-Tenant-Id',
      description: 'Active tenant UUID context for the request',
      required: true,
      schema: { type: 'string', format: 'uuid' },
    }),
    ApiResponse({
      status: 400,
      description:
        'Validation failed: Missing or malformed X-Tenant-Id UUID header.',
      type: ErrorResponseDto,
    }),
    ApiResponse({
      status: 401,
      description: 'Unauthorized: Invalid or expired session.',
      type: ErrorResponseDto,
    }),
    ApiResponse({
      status: 403,
      description:
        'Forbidden: Caller is not an active member of this tenant or lacks permission.',
      type: ErrorResponseDto,
    }),
  ];

  if (permission) {
    decorators.push(ApiExtension('x-permission', permission));
  }

  return applyDecorators(...decorators);
}

/**
 * Documents standard error responses using the uniform ErrorResponseDto.
 */
export function ApiStandardErrors() {
  return applyDecorators(
    ApiResponse({
      status: 400,
      description: 'Validation error',
      type: ErrorResponseDto,
    }),
    ApiResponse({
      status: 401,
      description: 'Unauthenticated',
      type: ErrorResponseDto,
    }),
    ApiResponse({
      status: 403,
      description: 'Forbidden',
      type: ErrorResponseDto,
    }),
    ApiResponse({
      status: 404,
      description: 'Not found',
      type: ErrorResponseDto,
    }),
    ApiResponse({
      status: 409,
      description: 'Conflict',
      type: ErrorResponseDto,
    }),
    ApiResponse({
      status: 429,
      description: 'Rate limited',
      type: ErrorResponseDto,
    }),
    ApiResponse({
      status: 500,
      description: 'Internal server error',
      type: ErrorResponseDto,
    }),
  );
}

/**
 * Documents a paginated response returning items of type `itemType` along with
 * standard query parameters `page` and `pageSize` (AC-B-48 to AC-B-53, AC-B-94).
 */
export function ApiPagedResponse<TModel extends Type<unknown>>(
  itemType: TModel,
) {
  return applyDecorators(
    ApiExtraModels(PagedResponseDto, itemType),
    ApiQuery({
      name: 'page',
      required: false,
      type: Number,
      description: 'Page number (positive integer, default 1)',
      example: 1,
    }),
    ApiQuery({
      name: 'pageSize',
      required: false,
      enum: [10, 20, 50, 100],
      description: 'Items per page (must be 10, 20, 50, or 100; default 20)',
      example: 20,
    }),
    ApiOkResponse({
      description: 'Paginated list of results',
      schema: {
        allOf: [
          { $ref: getSchemaPath(PagedResponseDto) },
          {
            properties: {
              items: {
                type: 'array',
                items: { $ref: getSchemaPath(itemType) },
              },
            },
          },
        ],
      },
    }),
  );
}
