import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { ErrorCode, type ErrorCodeType } from '../errors/error-codes.js';

export class ErrorResponseDto {
  @ApiProperty({
    description: 'HTTP status code',
    example: 400,
  })
  statusCode!: number;

  @ApiProperty({
    description: 'HTTP status text or error description',
    example: 'Bad Request',
  })
  error!: string;

  @ApiProperty({
    description: 'Error message or list of validation messages',
    example: 'Validation failed',
    oneOf: [{ type: 'string' }, { type: 'array', items: { type: 'string' } }],
  })
  message!: string | string[];

  @ApiProperty({
    description: 'Request path without query string',
    example: '/api/v1/probe/default',
  })
  path!: string;

  @ApiProperty({
    description: 'ISO 8601 UTC timestamp of when the error occurred',
    example: '2026-11-16T12:00:00.000Z',
  })
  timestamp!: string;

  @ApiProperty({
    description: 'Standard application error code (D-021)',
    enum: Object.values(ErrorCode),
    example: ErrorCode.VALIDATION_FAILED,
  })
  code!: ErrorCodeType;

  @ApiPropertyOptional({
    description:
      'Field-level validation error map (present only for validation errors)',
    type: 'object',
    additionalProperties: { type: 'string' },
    example: {
      email: 'email must be a valid email address',
      'profile.bio': 'bio should not be empty',
    },
  })
  fieldErrors?: Record<string, string>;
}
