import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform, Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsIn,
  IsDateString,
  IsInt,
  IsOptional,
  IsString,
  IsUUID,
  Matches,
  Max,
  MaxLength,
  Min,
  MinLength,
  ValidateNested,
} from 'class-validator';
import { PaginationQueryDto } from '../../common/dto/pagination-query.dto.js';
import { SHIPMENT_STATUSES } from '../../database/schema/shipping.js';

const trim = ({ value }: { value: unknown }) =>
  typeof value === 'string' ? value.trim() : value;

export class ShipmentItemInputDto {
  @ApiProperty({ format: 'uuid', description: 'An item of the order.' })
  @IsUUID()
  orderItemId!: string;

  @ApiProperty({ minimum: 1, maximum: 100000 })
  @Type(() => Number)
  @IsInt({ message: 'Enter a whole number.' })
  @Min(1, { message: 'Enter at least 1.' })
  @Max(100_000)
  quantity!: number;
}

/** The statuses an owner can move a hand-recorded parcel through (each one only forward). */
export const MANUAL_SHIPMENT_STATUSES = [
  'picked_up',
  'in_transit',
  'out_for_delivery',
  'delivered',
  'returned',
] as const;

const HTTPS_LINK = /^$|^https:\/\/[^\s]{3,500}$/;

/** A parcel the store sent with a courier of its own (no carrier integration): who carries it and the tracking number. */
export class ManualShipmentDto {
  @ApiProperty({
    example: 'India Post',
    description: 'The shipping provider / courier.',
  })
  @Transform(trim)
  @IsString()
  @MinLength(1, { message: 'Enter the shipping provider.' })
  @MaxLength(60)
  courierName!: string;

  @ApiProperty({
    example: 'EE123456789IN',
    description: 'The tracking number (waybill).',
  })
  @Transform(trim)
  @IsString()
  @MinLength(1, { message: 'Enter the tracking number.' })
  @MaxLength(60)
  trackingNumber!: string;

  @ApiPropertyOptional({
    description: 'A link where the customer can follow the parcel (https).',
  })
  @IsOptional()
  @Transform(trim)
  @Matches(HTTPS_LINK, { message: 'Enter a link that starts with https://' })
  trackingUrl?: string;

  @ApiPropertyOptional({ format: 'date', example: '2026-12-05' })
  @IsOptional()
  @IsDateString({}, { message: 'Enter a valid date.' })
  estimatedDelivery?: string;

  @ApiPropertyOptional({
    type: [ShipmentItemInputDto],
    description:
      'Which items (and how many) are in this parcel. Leave out for everything not yet shipped.',
  })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(200)
  @ValidateNested({ each: true })
  @Type(() => ShipmentItemInputDto)
  items?: ShipmentItemInputDto[];
}

export class UpdateManualShipmentDto {
  @ApiPropertyOptional()
  @IsOptional()
  @Transform(trim)
  @IsString()
  @MinLength(1)
  @MaxLength(60)
  courierName?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @Transform(trim)
  @IsString()
  @MinLength(1)
  @MaxLength(60)
  trackingNumber?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @Transform(trim)
  @Matches(HTTPS_LINK, { message: 'Enter a link that starts with https://' })
  trackingUrl?: string;

  @ApiPropertyOptional({ format: 'date' })
  @IsOptional()
  @IsDateString({}, { message: 'Enter a valid date.' })
  estimatedDelivery?: string;

  @ApiPropertyOptional({
    enum: MANUAL_SHIPMENT_STATUSES,
    description: 'Move the parcel forward; the order follows it.',
  })
  @IsOptional()
  @IsIn(MANUAL_SHIPMENT_STATUSES, { message: 'Choose a valid status.' })
  status?: (typeof MANUAL_SHIPMENT_STATUSES)[number];
}

export class CreateShipmentDto {
  @ApiPropertyOptional({
    type: [ShipmentItemInputDto],
    description:
      'Which items (and how many) go in this parcel. Leave out to ship everything not yet shipped. Cash-on-delivery orders ship in one parcel.',
  })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(200)
  @ValidateNested({ each: true })
  @Type(() => ShipmentItemInputDto)
  items?: ShipmentItemInputDto[];

  @ApiPropertyOptional({
    example: 'delhivery',
    description:
      'The carrier to book with. Leave out to use the carrier priced at checkout, or (when your settings choose automatically) the best one for this parcel.',
  })
  @IsOptional()
  @Transform(trim)
  @Matches(/^[a-z][a-z0-9_]{1,31}$/, { message: 'Choose a carrier.' })
  providerCode?: string;

  @ApiPropertyOptional({
    description:
      'The carrier service (courier) to use, as listed by your carrier comparison.',
  })
  @IsOptional()
  @Transform(trim)
  @IsString()
  @MaxLength(60)
  serviceCode?: string;

  @ApiPropertyOptional({
    minimum: 1,
    maximum: 1_000_000,
    description:
      'Parcel weight in grams, when it differs from the sum of the item weights (packaging) or the items have no weight saved.',
  })
  @IsOptional()
  @Type(() => Number)
  @IsInt({ message: 'Enter the weight as a whole number of grams.' })
  @Min(1, { message: 'Enter the parcel weight in grams.' })
  @Max(1_000_000)
  weightGrams?: number;

  @ApiPropertyOptional({ minimum: 1, maximum: 500 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(500)
  lengthCm?: number;

  @ApiPropertyOptional({ minimum: 1, maximum: 500 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(500)
  breadthCm?: number;

  @ApiPropertyOptional({ minimum: 1, maximum: 500 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(500)
  heightCm?: number;
}

export class ShipmentListQueryDto extends PaginationQueryDto {
  @ApiPropertyOptional({ enum: SHIPMENT_STATUSES })
  @IsOptional()
  @IsIn(SHIPMENT_STATUSES)
  status?: string;

  @ApiPropertyOptional({ example: 'delhivery' })
  @IsOptional()
  @Matches(/^[a-z][a-z0-9_]{1,31}$/)
  providerCode?: string;
}

export class ShipmentEventDto {
  @ApiProperty() status!: string;
  @ApiProperty() description!: string;
  @ApiPropertyOptional({ nullable: true }) location!: string | null;
  @ApiPropertyOptional({ nullable: true }) occurredAt!: Date | null;
  @ApiProperty({ enum: ['system', 'carrier_api', 'carrier_webhook', 'owner'] })
  source!: string;
  @ApiProperty() recordedAt!: Date;
}

export class ShipmentItemDto {
  @ApiProperty({ format: 'uuid' }) orderItemId!: string;
  @ApiProperty() name!: string;
  @ApiPropertyOptional({ nullable: true }) sku!: string | null;
  @ApiProperty() quantity!: number;
}

export class ShipmentDto {
  @ApiProperty({ format: 'uuid' }) id!: string;
  @ApiProperty({ format: 'uuid' }) orderId!: string;
  @ApiProperty() orderNumber!: number;
  @ApiProperty({ enum: SHIPMENT_STATUSES }) status!: string;
  @ApiProperty({ example: 'delhivery' }) providerCode!: string;
  @ApiPropertyOptional({ nullable: true }) courierName!: string | null;
  @ApiPropertyOptional({ nullable: true }) serviceCode!: string | null;
  @ApiPropertyOptional({
    nullable: true,
    description: 'The carrier waybill number.',
  })
  awb!: string | null;
  @ApiPropertyOptional({ nullable: true }) trackingUrl!: string | null;
  @ApiPropertyOptional({ nullable: true }) estimatedDelivery!: Date | null;
  @ApiProperty({ enum: ['prepaid', 'cod'] }) paymentMode!: string;
  @ApiProperty({
    description:
      'Cash the courier collects at the door, in paise (0 for prepaid).',
  })
  codAmountMinor!: number;
  @ApiProperty() declaredValueMinor!: number;
  @ApiProperty() weightGrams!: number;
  @ApiProperty({
    description: 'A label is available for download from this API.',
  })
  hasLabel!: boolean;
  @ApiPropertyOptional({
    nullable: true,
    description: 'A link to the label held by the carrier.',
  })
  labelUrl!: string | null;
  @ApiPropertyOptional({
    nullable: true,
    description: 'Why booking did not finish, or the last tracking problem.',
  })
  failureReason!: string | null;
  @ApiPropertyOptional({ nullable: true }) lastSyncedAt!: Date | null;
  @ApiPropertyOptional({ nullable: true }) pickedUpAt!: Date | null;
  @ApiPropertyOptional({ nullable: true }) deliveredAt!: Date | null;
  @ApiProperty() createdAt!: Date;
}

export class ShipmentDetailDto extends ShipmentDto {
  @ApiProperty({ type: [ShipmentItemDto] }) items!: ShipmentItemDto[];
  @ApiProperty({ type: [ShipmentEventDto], description: 'Newest first.' })
  events!: ShipmentEventDto[];
}

export class ShipmentLabelDto {
  @ApiProperty() available!: boolean;
  @ApiPropertyOptional({
    nullable: true,
    description: 'Set when the carrier holds the label: open it directly.',
  })
  url!: string | null;
  @ApiProperty({
    description:
      'The PDF is stored here and can be downloaded from the label file route.',
  })
  stored!: boolean;
}

export class TrackingSyncResultDto {
  @ApiProperty() tenants!: number;
  @ApiProperty() shipments!: number;
  @ApiProperty() updated!: number;
  @ApiProperty() failed!: number;
}
