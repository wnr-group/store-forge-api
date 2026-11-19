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
  400: 'The request is not valid. Check the data you sent',
  401: 'You are not signed in, or your access token is missing, invalid or expired',
  403: 'You are not allowed to do this (because of your role, permission or organization)',
  404: 'The item could not be found',
  409: 'This conflicts with data that already exists',
  429: 'Too many requests. Please wait a little and try again',
  500: 'Something went wrong on the server',
  503: 'This part of the service is temporarily unavailable',
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
    public: 'Anyone can call this. No sign-in is needed.',
    jwt: 'You must be signed in (a valid Supabase access token is required).',
    org: 'You must be signed in and be an active member of the organization you are working in.',
    platform: 'You must be signed in as a Platform Admin.',
    super_admin: 'You must be signed in as a Platform **super admin**.',
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
          'The organization you want to work in. It is checked against the organizations you belong to. If you leave it out, your first organization is used.',
      }),
    );
  }
  if (options.body) decorators.push(ApiBody({ type: options.body }));

  return applyDecorators(...decorators);
}
