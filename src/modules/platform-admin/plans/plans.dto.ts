import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import {
  IsBoolean,
  IsIn,
  IsObject,
  IsOptional,
  IsString,
  Matches,
} from 'class-validator';
import {
  FEATURE_KEYS,
  LIMIT_KEYS,
  PLAN_STATUSES,
  isFeatureKey,
  isLimitKey,
} from '../../../common/constants/plan-catalog.js';
import { PaginationQueryDto } from '../../../common/dto/pagination-query.dto.js';
import {
  Check,
  CurrencyField,
  MoneyText,
  OptionalText,
  RequiredText,
  WholeNumber,
  WhenPresent,
} from '../../../common/validation/fields.js';

export class LimitValueDto {
  @ApiPropertyOptional({
    nullable: true,
    description:
      'Warn at this number (a warning, never a block). Empty means no warning.',
  })
  soft!: number | null;
  @ApiPropertyOptional({
    nullable: true,
    description:
      'Refuse to go past this number. Empty means unlimited. It cannot be lower than the soft limit.',
  })
  hard!: number | null;
}

export class FeatureCatalogItemDto {
  @ApiProperty({ enum: FEATURE_KEYS }) key!: string;
  @ApiProperty() label!: string;
  @ApiProperty() description!: string;
  @ApiProperty() group!: string;
}
export class LimitCatalogItemDto {
  @ApiProperty({ enum: LIMIT_KEYS }) key!: string;
  @ApiProperty() label!: string;
  @ApiProperty() description!: string;
  @ApiProperty({ enum: ['count', 'bytes'] }) unit!: string;
  @ApiProperty({
    description:
      'Whether going past the hard limit is refused. Orders are only reported.',
  })
  enforced!: boolean;
}
export class PlanCatalogDto {
  @ApiProperty({ type: [FeatureCatalogItemDto] })
  features!: FeatureCatalogItemDto[];
  @ApiProperty({ type: [LimitCatalogItemDto] })
  limits!: LimitCatalogItemDto[];
}

export class PlanDto {
  @ApiProperty({ format: 'uuid' }) id!: string;
  @ApiProperty({ example: 'starter' }) code!: string;
  @ApiProperty() name!: string;
  @ApiPropertyOptional({ nullable: true }) description!: string | null;
  @ApiProperty({ enum: PLAN_STATUSES }) status!: string;
  @ApiProperty({ example: 'INR' }) currency!: string;
  @ApiProperty({ example: '499.00' }) monthlyPrice!: string;
  @ApiProperty() monthlyPriceMinor!: number;
  @ApiProperty({ example: '4990.00' }) yearlyPrice!: string;
  @ApiProperty() yearlyPriceMinor!: number;
  @ApiProperty() trialDays!: number;
  @ApiProperty({
    description: 'The plan a new organization gets when none is chosen.',
  })
  isDefault!: boolean;
  @ApiProperty({
    description:
      'Every feature is on and nothing is limited, whatever the lists below say.',
  })
  isUnrestricted!: boolean;
  @ApiProperty() sortOrder!: number;
  @ApiProperty({
    type: 'object',
    additionalProperties: { type: 'boolean' },
    description: 'Every feature in the catalog, included or not.',
  })
  features!: Record<string, boolean>;
  @ApiProperty({
    type: 'object',
    additionalProperties: { $ref: '#/components/schemas/LimitValueDto' },
    description: 'Every limit in the catalog; empty numbers mean unlimited.',
  })
  limits!: Record<string, LimitValueDto>;
  @ApiProperty({ description: 'Organizations on this plan right now.' })
  subscriberCount!: number;
  @ApiProperty() createdAt!: Date;
  @ApiProperty() updatedAt!: Date;
}

export class PlanListQueryDto extends PaginationQueryDto {
  @ApiPropertyOptional({ enum: ['all', ...PLAN_STATUSES], default: 'all' })
  @IsOptional()
  @IsIn(['all', ...PLAN_STATUSES])
  status: 'all' | (typeof PLAN_STATUSES)[number] = 'all';
}

const isPlainObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

const validFeatures = (v: unknown) =>
  isPlainObject(v) &&
  Object.entries(v).every(
    ([k, enabled]) => isFeatureKey(k) && typeof enabled === 'boolean',
  );

const wholeOrNull = (v: unknown) =>
  v === null ||
  v === undefined ||
  (typeof v === 'number' && Number.isSafeInteger(v) && v >= 0);

const validLimits = (v: unknown) =>
  isPlainObject(v) &&
  Object.entries(v).every(([k, value]) => {
    if (!isLimitKey(k)) return false;
    if (value === null) return true; // removes the limit (unlimited)
    if (!isPlainObject(value)) return false;
    if (Object.keys(value).some((x) => x !== 'soft' && x !== 'hard'))
      return false;
    if (!wholeOrNull(value.soft) || !wholeOrNull(value.hard)) return false;
    return (
      typeof value.soft !== 'number' ||
      typeof value.hard !== 'number' ||
      value.soft <= value.hard
    );
  });

const FEATURES_MESSAGE = `features must map known feature keys (${FEATURE_KEYS.join(', ')}) to true or false.`;
const LIMITS_MESSAGE = `limits must map known limit keys (${LIMIT_KEYS.join(', ')}) to null (unlimited) or { soft, hard } with whole numbers, soft not above hard.`;

export class CreatePlanDto {
  @ApiProperty({
    example: 'starter',
    description:
      'A short permanent name for the plan: lowercase letters, numbers, - and _. It cannot be changed later.',
  })
  @Transform(({ value }) =>
    typeof value === 'string' ? value.trim().toLowerCase() : value,
  )
  @IsString({ message: 'Plan code is required.' })
  @Matches(/^[a-z0-9][a-z0-9_-]{1,38}[a-z0-9]$/, {
    message:
      'Plan code must be 3 to 40 characters: lowercase letters, numbers, - and _.',
  })
  code!: string;

  @ApiProperty({ minLength: 2, maxLength: 60 })
  @RequiredText('Plan name', 60, 2)
  name!: string;

  @ApiPropertyOptional({ nullable: true, maxLength: 500 })
  @OptionalText('Description', 500)
  description?: string | null;

  @ApiPropertyOptional({ example: 'INR', default: 'INR' })
  @WhenPresent()
  @CurrencyField()
  currency?: string;

  @ApiProperty({
    example: '499',
    description: 'Price per month, as plain decimal text. 0 for a free plan.',
  })
  @MoneyText('Monthly price', { required: true })
  monthlyPrice!: string;

  @ApiProperty({
    example: '4990',
    description: 'Price per year, as plain decimal text. 0 for a free plan.',
  })
  @MoneyText('Yearly price', { required: true })
  yearlyPrice!: string;

  @ApiPropertyOptional({ default: 0, minimum: 0, maximum: 365 })
  @WhenPresent()
  @WholeNumber('Trial days', { min: 0, max: 365 })
  trialDays?: number;

  @ApiPropertyOptional({
    description: 'Make this the plan new organizations get by default.',
  })
  @IsOptional()
  @IsBoolean()
  isDefault?: boolean;

  @ApiPropertyOptional({
    description:
      'Every feature on and no limits. Meant for grandfathered or internal plans.',
  })
  @IsOptional()
  @IsBoolean()
  isUnrestricted?: boolean;

  @ApiPropertyOptional({
    default: 0,
    description: 'Lower numbers are listed first.',
  })
  @WhenPresent()
  @WholeNumber('Sort order', { min: 0, max: 10_000 })
  sortOrder?: number;

  @ApiPropertyOptional({
    type: 'object',
    additionalProperties: { type: 'boolean' },
    example: { discount_codes: true, google_analytics: false },
  })
  @IsOptional()
  @IsObject()
  @Check((v) => v === undefined || validFeatures(v), FEATURES_MESSAGE)
  features?: Record<string, boolean>;

  @ApiPropertyOptional({
    type: 'object',
    additionalProperties: { $ref: '#/components/schemas/LimitValueDto' },
    example: { products: { soft: 80, hard: 100 }, staff_accounts: { hard: 3 } },
  })
  @IsOptional()
  @IsObject()
  @Check((v) => v === undefined || validLimits(v), LIMITS_MESSAGE)
  limits?: Record<
    string,
    { soft?: number | null; hard?: number | null } | null
  >;
}

/** Partial update: omitted fields keep their value. The code is permanent. Feature and limit keys that are sent are changed; the others stay. */
export class UpdatePlanDto {
  @ApiPropertyOptional({ minLength: 2, maxLength: 60 })
  @WhenPresent()
  @RequiredText('Plan name', 60, 2)
  name?: string;

  @ApiPropertyOptional({ nullable: true, maxLength: 500 })
  @OptionalText('Description', 500)
  description?: string | null;

  @ApiPropertyOptional({ example: 'INR' })
  @WhenPresent()
  @CurrencyField()
  currency?: string;

  @ApiPropertyOptional({ example: '499' })
  @WhenPresent()
  @MoneyText('Monthly price', { required: true })
  monthlyPrice?: string;

  @ApiPropertyOptional({ example: '4990' })
  @WhenPresent()
  @MoneyText('Yearly price', { required: true })
  yearlyPrice?: string;

  @ApiPropertyOptional({ minimum: 0, maximum: 365 })
  @WhenPresent()
  @WholeNumber('Trial days', { min: 0, max: 365 })
  trialDays?: number;

  @ApiPropertyOptional({
    description:
      'Set true to make this the default plan. The default cannot be turned off here: make another plan the default instead.',
  })
  @IsOptional()
  @IsBoolean()
  isDefault?: boolean;

  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  isUnrestricted?: boolean;

  @ApiPropertyOptional()
  @WhenPresent()
  @WholeNumber('Sort order', { min: 0, max: 10_000 })
  sortOrder?: number;

  @ApiPropertyOptional({
    type: 'object',
    additionalProperties: { type: 'boolean' },
  })
  @IsOptional()
  @IsObject()
  @Check((v) => v === undefined || validFeatures(v), FEATURES_MESSAGE)
  features?: Record<string, boolean>;

  @ApiPropertyOptional({
    type: 'object',
    additionalProperties: { $ref: '#/components/schemas/LimitValueDto' },
    description: 'A key set to null removes that limit (unlimited).',
  })
  @IsOptional()
  @IsObject()
  @Check((v) => v === undefined || validLimits(v), LIMITS_MESSAGE)
  limits?: Record<
    string,
    { soft?: number | null; hard?: number | null } | null
  >;
}

export class PlanStatusDto {
  @ApiProperty({ enum: PLAN_STATUSES })
  @IsIn(PLAN_STATUSES, { message: 'Choose active or inactive.' })
  status!: (typeof PLAN_STATUSES)[number];
}
