import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsObject } from 'class-validator';
import { INTEGRATION_EVENT_ACTIONS } from '../../database/schema/marketing.js';

export const INTEGRATION_STATUSES = [
  'not_configured',
  'disabled',
  'enabled',
] as const;

export class IntegrationFieldDto {
  @ApiProperty({ example: 'measurementId' }) key!: string;
  @ApiProperty({ example: 'Measurement ID' }) label!: string;
  @ApiProperty({ example: 'G-XXXXXXXXXX' }) placeholder!: string;
  @ApiProperty() help!: string;
}

export class IntegrationEventDto {
  @ApiProperty({ enum: INTEGRATION_EVENT_ACTIONS }) action!: string;
  @ApiProperty({
    nullable: true,
    description:
      'A short note. It never contains an identifier value or a secret.',
  })
  note!: string | null;
  @ApiProperty({
    description: 'The change was made by the person looking at it.',
  })
  byYou!: boolean;
  @ApiProperty() createdAt!: Date;
}

export class IntegrationDto {
  @ApiProperty({
    example: 'ga4',
    description: 'The provider code used in the URLs.',
  })
  provider!: string;
  @ApiProperty({ example: 'Google Analytics 4' }) name!: string;
  @ApiProperty() description!: string;
  @ApiProperty({
    type: [IntegrationFieldDto],
    description: 'What the configuration form asks for.',
  })
  fields!: IntegrationFieldDto[];
  @ApiProperty({ description: 'A configuration has been saved.' })
  configured!: boolean;
  @ApiProperty({
    description:
      'Tracking is switched on: storefronts load it (after the shopper agrees).',
  })
  enabled!: boolean;
  @ApiProperty({ enum: INTEGRATION_STATUSES }) status!: string;
  @ApiProperty({
    nullable: true,
    enum: ['unverified', 'valid', 'invalid'],
    description:
      'Whether the saved configuration passed validation. Only a valid one can be switched on. Null when nothing is saved.',
  })
  validationStatus!: string | null;
  @ApiProperty({ nullable: true }) validationError!: string | null;
  @ApiProperty({ nullable: true }) validatedAt!: Date | null;
  @ApiProperty({
    type: 'object',
    additionalProperties: { type: 'string' },
    description:
      'The public identifiers that were saved (never a secret: private credentials are not returned by any route).',
  })
  config!: Record<string, string>;
  @ApiProperty({ nullable: true }) updatedAt!: Date | null;
  @ApiProperty({
    description: 'The last change was made by the person looking at it.',
  })
  updatedByYou!: boolean;
}

export class IntegrationDetailDto extends IntegrationDto {
  @ApiProperty({
    type: [IntegrationEventDto],
    description: 'The 20 latest changes, newest first.',
  })
  history!: IntegrationEventDto[];
}

export class SaveIntegrationDto {
  @ApiProperty({
    type: 'object',
    additionalProperties: { type: 'string' },
    example: { measurementId: 'G-ABCDE12345' },
    description:
      'The settings of this provider (see `fields` of the integration). Unknown settings are refused. Saving a changed value switches the integration off until it is validated and enabled again.',
  })
  @IsObject({ message: 'Send the settings as an object.' })
  config!: Record<string, unknown>;
}

export class IntegrationTestCheckDto {
  @ApiProperty() name!: string;
  @ApiProperty() ok!: boolean;
  @ApiProperty() message!: string;
}

export class IntegrationTestResultDto {
  @ApiProperty({ description: 'Every check passed.' }) ok!: boolean;
  @ApiProperty({ type: [IntegrationTestCheckDto] })
  checks!: IntegrationTestCheckDto[];
  @ApiPropertyOptional({
    description:
      'What this test can and cannot prove. No provider offers a public way to confirm an ID belongs to you; check its own live report.',
  })
  note!: string;
}

export class TrackingProviderDto {
  @ApiProperty({ example: 'ga4' }) provider!: string;
  @ApiProperty({
    type: 'object',
    additionalProperties: { type: 'string' },
    example: { measurementId: 'G-ABCDE12345' },
    description: 'Public identifiers only.',
  })
  config!: Record<string, string>;
}

export class TrackingConfigDto {
  @ApiProperty({
    type: [TrackingProviderDto],
    description:
      'The integrations this store has validated and switched on. Load none of them until the shopper has agreed to analytics.',
  })
  providers!: TrackingProviderDto[];
  @ApiProperty({
    description:
      'Always true: a storefront must ask the shopper first and load tracking only after they agree.',
  })
  consentRequired!: boolean;
}
