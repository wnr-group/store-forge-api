import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform, Type } from 'class-transformer';
import {
  IsDefined,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  Matches,
  Max,
  MaxLength,
  Min,
  MinLength,
  ValidateNested,
} from 'class-validator';
import {
  CARRIER_SELECTION_MODES,
  CARRIER_STRATEGIES,
} from '../../database/schema/shipping.js';

const trim = ({ value }: { value: unknown }) =>
  typeof value === 'string' ? value.trim() : value;
const PHONE = /^[0-9+\-\s()]{6,20}$/;

// --- origin ----------------------------------------------------------------------------------------------------------------

export class SaveOriginDto {
  @ApiProperty({
    description: 'The name on the pickup (your shop or warehouse).',
  })
  @Transform(trim)
  @IsString()
  @MinLength(1)
  @MaxLength(120)
  name!: string;

  @ApiProperty({ example: '9876543210' })
  @Transform(trim)
  @Matches(PHONE, { message: 'Enter a valid phone number.' })
  phone!: string;

  @ApiPropertyOptional()
  @IsOptional()
  @Transform(trim)
  @IsString()
  @MaxLength(254)
  email?: string;

  @ApiProperty()
  @Transform(trim)
  @IsString()
  @MinLength(1)
  @MaxLength(200)
  line1!: string;

  @ApiPropertyOptional()
  @IsOptional()
  @Transform(trim)
  @IsString()
  @MaxLength(200)
  line2?: string;

  @ApiProperty()
  @Transform(trim)
  @IsString()
  @MinLength(1)
  @MaxLength(100)
  city!: string;

  @ApiProperty({
    example: 'Karnataka',
    description: 'A state or union territory name (or its GST code).',
  })
  @Transform(trim)
  @IsString()
  state!: string;

  @ApiProperty({ example: '560001' })
  @Transform(trim)
  @Matches(/^[1-9]\d{5}$/, { message: 'Enter a valid 6-digit PIN code.' })
  postalCode!: string;
}

export class OriginDto {
  @ApiProperty({
    description: 'False until the pickup address has been saved.',
  })
  configured!: boolean;
  @ApiPropertyOptional({ nullable: true }) name!: string | null;
  @ApiPropertyOptional({ nullable: true }) phone!: string | null;
  @ApiPropertyOptional({ nullable: true }) email!: string | null;
  @ApiPropertyOptional({ nullable: true }) line1!: string | null;
  @ApiPropertyOptional({ nullable: true }) line2!: string | null;
  @ApiPropertyOptional({ nullable: true }) city!: string | null;
  @ApiPropertyOptional({ nullable: true }) state!: string | null;
  @ApiPropertyOptional({ nullable: true }) postalCode!: string | null;
  @ApiPropertyOptional({ nullable: true }) updatedAt!: Date | null;
}

// --- quotes ----------------------------------------------------------------------------------------------------------------

export class QuoteAddressDto {
  @ApiProperty({
    example: 'Karnataka',
    description: 'A state or union territory name (or its GST code).',
  })
  @Transform(trim)
  @IsString()
  state!: string;

  @ApiPropertyOptional({ example: 'Bengaluru' })
  @IsOptional()
  @Transform(trim)
  @IsString()
  @MaxLength(100)
  city?: string;

  @ApiProperty({ example: '560001' })
  @Transform(trim)
  @Matches(/^[1-9]\d{5}$/, { message: 'Enter a valid 6-digit PIN code.' })
  postalCode!: string;
}

export class PreviewDto {
  @ApiProperty({ type: QuoteAddressDto })
  @IsDefined({ message: 'Enter the delivery address.' })
  @ValidateNested()
  @Type(() => QuoteAddressDto)
  destination!: QuoteAddressDto;

  @ApiProperty({
    minimum: 0,
    description: 'The items subtotal to try, in paise.',
  })
  @IsInt()
  @Min(0)
  @Max(100_000_000_000)
  subtotalMinor!: number;

  @ApiProperty({
    minimum: 0,
    description: 'The parcel weight to try, in grams. 0 means unknown.',
  })
  @IsInt()
  @Min(0)
  @Max(1_000_000_000)
  weightGrams!: number;

  @ApiPropertyOptional({ enum: ['razorpay', 'cod'] })
  @IsOptional()
  @IsIn(['razorpay', 'cod'])
  paymentMethod?: 'razorpay' | 'cod';
}

export class CarrierComparisonDto {
  @ApiProperty({ example: '400001' })
  @Matches(/^[1-9]\d{5}$/, { message: 'Enter a valid 6-digit PIN code.' })
  destinationPostalCode!: string;

  @ApiProperty({ minimum: 1, description: 'The parcel weight in grams.' })
  @IsInt()
  @Min(1)
  @Max(1_000_000_000)
  weightGrams!: number;

  @ApiProperty({ enum: ['prepaid', 'cod'] })
  @IsIn(['prepaid', 'cod'])
  paymentMode!: 'prepaid' | 'cod';

  @ApiPropertyOptional({
    minimum: 0,
    description: 'The declared value in paise (COD carriers need it).',
  })
  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(100_000_000_000)
  declaredValueMinor?: number;
}

export class ShippingCarrierInfoDto {
  @ApiProperty() code!: string;
  @ApiProperty() name!: string;
  @ApiProperty() serviceCode!: string;
  @ApiProperty() serviceName!: string;
  @ApiProperty({ description: 'The carrier calls its price approximate.' })
  estimate!: boolean;
}

export class ShippingDaysDto {
  @ApiProperty() min!: number;
  @ApiProperty() max!: number;
}

export class ShippingOptionDto {
  @ApiProperty({ format: 'uuid' }) methodId!: string;
  @ApiProperty() name!: string;
  @ApiProperty({ enum: ['standard', 'express'] }) kind!: string;
  @ApiProperty() pricingType!: string;
  @ApiProperty({
    description: 'What shipping costs, in paise, as the server worked it out.',
  })
  chargeMinor!: number;
  @ApiProperty() free!: boolean;
  @ApiPropertyOptional({ type: ShippingDaysDto, nullable: true })
  estimatedDays!: ShippingDaysDto | null;
  @ApiProperty({
    description:
      'Whether cash on delivery may be used with this delivery option.',
  })
  codAllowed!: boolean;
  @ApiPropertyOptional({ type: ShippingCarrierInfoDto, nullable: true })
  carrier!: ShippingCarrierInfoDto | null;
}

export class UnavailableMethodDto {
  @ApiProperty({ format: 'uuid' }) methodId!: string;
  @ApiProperty() name!: string;
  @ApiProperty() reason!: string;
}

export class ShippingZoneRefDto {
  @ApiProperty({ format: 'uuid' }) id!: string;
  @ApiProperty() name!: string;
  @ApiProperty() codAllowed!: boolean;
}

export class ShippingQuoteDto {
  @ApiProperty({
    description:
      'False when the organization has no shipping zones: nothing is charged or enforced.',
  })
  configured!: boolean;
  @ApiProperty({
    description:
      'Whether the address can be delivered to and at least one option is available.',
  })
  deliverable!: boolean;
  @ApiPropertyOptional({ type: ShippingZoneRefDto, nullable: true })
  zone!: ShippingZoneRefDto | null;
  @ApiProperty({ type: [ShippingOptionDto] }) options!: ShippingOptionDto[];
  @ApiProperty({
    type: [UnavailableMethodDto],
    description:
      'Methods of the zone that cannot be used for this cart, and why.',
  })
  unavailable!: UnavailableMethodDto[];
  @ApiPropertyOptional({ nullable: true }) reason!: string | null;
}

// --- carrier comparison ----------------------------------------------------------------------------------------------------

export class CarrierCandidateDto {
  @ApiProperty() providerCode!: string;
  @ApiProperty() providerName!: string;
  @ApiProperty() serviceCode!: string;
  @ApiProperty() serviceName!: string;
  @ApiProperty() amountMinor!: number;
  @ApiPropertyOptional({ nullable: true }) estimatedDeliveryDays!:
    number | null;
  @ApiPropertyOptional({ nullable: true }) codChargeMinor!: number | null;
  @ApiProperty() estimate!: boolean;
}

export class SkippedCarrierDto {
  @ApiProperty() providerCode!: string;
  @ApiProperty() providerName!: string;
  @ApiProperty() reason!: string;
}

export class CarrierChoiceDto {
  @ApiPropertyOptional({ type: CarrierCandidateDto, nullable: true })
  candidate!: CarrierCandidateDto | null;
  @ApiProperty({ enum: CARRIER_STRATEGIES }) strategy!: string;
  @ApiProperty({
    description:
      'The strategy could not be followed, so another rule was used.',
  })
  fellBack!: boolean;
  @ApiProperty() reason!: string;
}

export class CarrierComparisonResultDto {
  @ApiProperty({
    type: [CarrierCandidateDto],
    description: 'Carriers that confirmed delivery and quoted a price.',
  })
  candidates!: CarrierCandidateDto[];
  @ApiProperty({
    type: [SkippedCarrierDto],
    description: 'Carriers not used, and why.',
  })
  skipped!: SkippedCarrierDto[];
  @ApiProperty({ enum: CARRIER_STRATEGIES }) strategy!: string;
  @ApiProperty({ enum: CARRIER_SELECTION_MODES }) mode!: string;
  @ApiPropertyOptional({ nullable: true }) defaultCarrier!: string | null;
  @ApiProperty({
    type: CarrierChoiceDto,
    description:
      'What your selection settings would choose (nothing in manual mode).',
  })
  choice!: CarrierChoiceDto;
}
