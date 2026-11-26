import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsBoolean, IsIn, IsObject, IsOptional } from 'class-validator';
import { PaginationQueryDto } from '../../common/dto/pagination-query.dto.js';
import {
  CARRIER_EVENT_ACTIONS,
  CARRIER_SELECTION_MODES,
  CARRIER_STRATEGIES,
} from '../../database/schema/shipping.js';

export class SaveCarrierDto {
  @ApiProperty({
    type: 'object',
    additionalProperties: { type: 'string' },
    example: {
      email: 'api@myshop.in',
      password: '********',
      pickupLocation: 'Primary',
    },
    description:
      'The carrier settings, by the keys listed in `credentialFields` of that carrier. A secret you leave out keeps its saved value (secrets are never shown again); to change one, send the new value. An empty value clears an optional setting.',
  })
  @IsObject({ message: 'Send the settings as an object.' })
  values!: Record<string, string>;
}

export class SetCarrierEnabledDto {
  @ApiProperty({
    description:
      'Turn the carrier on or off for new shipments. Turning it on needs a successful connection check.',
  })
  @IsBoolean({ message: 'Choose on or off.' })
  enabled!: boolean;

  @ApiPropertyOptional({
    description:
      'Required (true) to turn on a carrier whose integration is marked `unverified`: it has not been checked against the carrier’s real service yet, and you accept that.',
  })
  @IsOptional()
  @IsBoolean()
  acknowledgeUnverifiedIntegration?: boolean;
}

export class SetCarrierDefaultDto {
  @ApiProperty({
    description:
      'Make this the default carrier (it must be turned on). Only one carrier is the default.',
  })
  @IsBoolean({ message: 'Choose yes or no.' })
  isDefault!: boolean;
}

export class SavePreferencesDto {
  @ApiProperty({
    enum: CARRIER_SELECTION_MODES,
    description:
      '`manual`: you pick the carrier for each shipment. `automatic`: the strategy picks it.',
  })
  @IsIn(CARRIER_SELECTION_MODES, { message: 'Choose manual or automatic.' })
  selectionMode!: (typeof CARRIER_SELECTION_MODES)[number];

  @ApiProperty({
    enum: CARRIER_STRATEGIES,
    description:
      '`lowest_cost`, `fastest`, or `preferred` (your default carrier first).',
  })
  @IsIn(CARRIER_STRATEGIES, { message: 'Choose a selection strategy.' })
  strategy!: (typeof CARRIER_STRATEGIES)[number];
}

export class ShippingPreferencesDto {
  @ApiProperty({ enum: CARRIER_SELECTION_MODES }) selectionMode!: string;
  @ApiProperty({ enum: CARRIER_STRATEGIES }) strategy!: string;
  @ApiProperty({ description: 'How many carriers are turned on right now.' })
  activeCarrierCount!: number;
  @ApiPropertyOptional({
    nullable: true,
    description: 'The code of the default carrier, if one is set.',
  })
  defaultCarrier!: string | null;
  @ApiPropertyOptional({ nullable: true }) updatedAt!: Date | null;
}

export class CredentialFieldDto {
  @ApiProperty() key!: string;
  @ApiProperty() label!: string;
  @ApiProperty() required!: boolean;
  @ApiProperty({
    description: 'Secret values are encrypted and never shown again.',
  })
  secret!: boolean;
  @ApiPropertyOptional() help?: string;
  @ApiPropertyOptional({ type: [String] }) options?: string[];
}

export class CarrierCapabilitiesDto {
  @ApiProperty() serviceability!: boolean;
  @ApiProperty() rateQuotes!: boolean;
  @ApiProperty() ratesAreEstimates!: boolean;
  @ApiProperty() createShipment!: boolean;
  @ApiProperty() cancelShipment!: boolean;
  @ApiProperty() labels!: boolean;
  @ApiProperty() tracking!: boolean;
  @ApiProperty() trackingWebhooks!: boolean;
  @ApiProperty() cashOnDelivery!: boolean;
}

export class CarrierConnectionDto {
  @ApiProperty({
    description:
      'Whether this carrier has been connected (settings saved) for the organization.',
  })
  connected!: boolean;
  @ApiProperty({ description: 'Whether new shipments can use this carrier.' })
  enabled!: boolean;
  @ApiProperty() isDefault!: boolean;
  @ApiProperty({ enum: ['unverified', 'verified', 'failed'] })
  verificationStatus!: string;
  @ApiPropertyOptional({ nullable: true }) verifiedAt!: Date | null;
  @ApiPropertyOptional({
    nullable: true,
    description: 'A short, safe reason when the last check failed.',
  })
  verificationError!: string | null;
  @ApiProperty({
    type: 'object',
    additionalProperties: { type: 'string' },
    description: 'The saved settings that are not secret.',
  })
  settings!: Record<string, string>;
  @ApiProperty({
    type: [String],
    description:
      'The names of the secrets that are saved. Their values are never returned.',
  })
  secretFieldsSaved!: string[];
  @ApiPropertyOptional({ nullable: true }) updatedAt!: Date | null;
  @ApiPropertyOptional({ nullable: true }) updatedByName!: string | null;
}

export class CarrierDto {
  @ApiProperty({ example: 'shiprocket' }) code!: string;
  @ApiProperty() name!: string;
  @ApiProperty({ type: CarrierCapabilitiesDto })
  capabilities!: CarrierCapabilitiesDto;
  @ApiProperty({
    enum: ['documented', 'partially_documented', 'unverified'],
    description:
      'How far this integration has been checked against the carrier’s real service.',
  })
  integrationStatus!: string;
  @ApiProperty() integrationNotes!: string;
  @ApiProperty({ type: [CredentialFieldDto] })
  credentialFields!: CredentialFieldDto[];
  @ApiProperty({ type: CarrierConnectionDto })
  connection!: CarrierConnectionDto;
}

export class CarrierCheckDto {
  @ApiProperty({ description: 'Whether the carrier accepted the settings.' })
  valid!: boolean;
  @ApiProperty() message!: string;
}

export class CarrierEventsQueryDto extends PaginationQueryDto {
  @ApiPropertyOptional({ enum: CARRIER_EVENT_ACTIONS })
  @IsOptional()
  @IsIn(CARRIER_EVENT_ACTIONS)
  action?: string;
}

export class CarrierEventDto {
  @ApiProperty() id!: string;
  @ApiProperty() providerCode!: string;
  @ApiProperty({ enum: CARRIER_EVENT_ACTIONS }) action!: string;
  @ApiPropertyOptional({
    nullable: true,
    description: 'Who did it, or null if that person has left the team.',
  })
  actorName!: string | null;
  @ApiPropertyOptional({
    nullable: true,
    description: 'What changed (names of settings only, never values).',
  })
  note!: string | null;
  @ApiProperty() createdAt!: Date;
}
