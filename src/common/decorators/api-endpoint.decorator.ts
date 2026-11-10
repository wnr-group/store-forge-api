import { applyDecorators, HttpCode, Type } from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiBody,
  ApiExtraModels,
  ApiHeader,
  ApiOperation,
  ApiResponse,
  getSchemaPath,
} from '@nestjs/swagger';
import {
  ErrorResponseDto,
  PaginationMetaDto,
  SuccessResponseDto,
} from '../dto/api-response.dto.js';
import { ResponseMessage } from './response-message.decorator.js';

type AuthKind = 'public' | 'jwt' | 'org' | 'platform' | 'super_admin';

export interface ApiEndpointOptions {
  summary: string;
  description?: string;
  /** How the route is protected; drives bearer auth, the organization header and the standard error responses. */
  auth: AuthKind;
  /** Human-readable permission requirement, shown in the description (e.g. `catalog:manage`). */
  permission?: string;
  /** Request body DTO. */
  body?: Type<unknown>;
  /** Response data DTO; `[Dto]` for a collection, `null` when the route returns no data. */
  response?: Type<unknown> | [Type<unknown>] | null;
  /** Adds the `meta` pagination object to the success envelope. */
  paginated?: boolean;
  /** Success message in the envelope. */
  message: string;
  /** HTTP status of the success response. Default 200. */
  status?: number;
  /** Extra error statuses this route can return (404, 409, ...). */
  errors?: number[];
}

const ERROR_TEXT: Record<number, string> = {
  400: 'Validation failed',
  401: 'Missing, invalid or expired access token',
  403: 'Not allowed (role, permission or organization)',
  404: 'Resource not found',
  409: 'Conflict with existing data',
  429: 'Rate limit exceeded',
  500: 'Unexpected server error',
};

/**
 * One decorator that documents a route completely (tag-level `@ApiTags` stays on the controller): operation,
 * bearer auth, organization header, request body, success envelope with typed `data` and `meta`, and the possible
 * error responses. Keeping this in one place means no endpoint can be left half documented.
 */
export function ApiEndpoint(options: ApiEndpointOptions) {
  const { auth, response, paginated, status = 200 } = options;
  const secured = auth !== 'public';
  const authText: Record<AuthKind, string> = {
    public: 'Public (no authentication).',
    jwt: 'Requires a valid Supabase access token.',
    org: 'Requires a Supabase access token and active membership of the selected organization.',
    platform: 'Requires a Supabase access token of a Platform Admin.',
    super_admin:
      'Requires a Supabase access token of a Platform **super admin**.',
  };
  const description = [
    options.description,
    authText[auth],
    options.permission ? `Permission: \`${options.permission}\`.` : null,
  ]
    .filter(Boolean)
    .join('\n\n');

  const dataType = Array.isArray(response) ? response[0] : response;
  const extraModels: Type<unknown>[] = [
    SuccessResponseDto,
    ErrorResponseDto,
    PaginationMetaDto,
    ...(dataType ? [dataType] : []),
  ];

  const dataSchema = !dataType
    ? { type: 'object', nullable: true, example: null }
    : Array.isArray(response)
      ? { type: 'array', items: { $ref: getSchemaPath(dataType) } }
      : { $ref: getSchemaPath(dataType) };

  const errors = new Set<number>([500, ...(options.errors ?? [])]);
  if (secured) errors.add(401);
  if (auth === 'org' || auth === 'platform' || auth === 'super_admin')
    errors.add(403);
  if (options.body || paginated) errors.add(400);
  if (auth === 'platform' || auth === 'super_admin') errors.add(429);

  const decorators = [
    ApiOperation({ summary: options.summary, description }),
    ApiExtraModels(...extraModels),
    HttpCode(status),
    ResponseMessage(options.message),
    ApiResponse({
      status,
      description: options.message,
      schema: {
        allOf: [
          { $ref: getSchemaPath(SuccessResponseDto) },
          {
            type: 'object',
            properties: {
              data: dataSchema,
              ...(paginated
                ? { meta: { $ref: getSchemaPath(PaginationMetaDto) } }
                : {}),
            },
          },
        ],
      },
    }),
    ...[...errors]
      .sort((a, b) => a - b)
      .map((code) =>
        ApiResponse({
          status: code,
          description: ERROR_TEXT[code] ?? 'Error',
          type: ErrorResponseDto,
        }),
      ),
  ];

  if (secured) decorators.push(ApiBearerAuth());
  if (auth === 'org') {
    decorators.push(
      ApiHeader({
        name: 'X-Organization-Id',
        required: false,
        description:
          'Organization to act on. Verified against your memberships; defaults to your first organization.',
      }),
    );
  }
  if (options.body) decorators.push(ApiBody({ type: options.body }));

  return applyDecorators(...decorators);
}
