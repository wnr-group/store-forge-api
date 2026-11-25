import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsIn, IsOptional, IsUUID } from 'class-validator';
import { BILLING_INTERVALS } from '../../../common/constants/plan-catalog.js';
import { PaginationQueryDto } from '../../../common/dto/pagination-query.dto.js';
import {
  CurrencyField,
  EmailField,
  OptionalEmail,
  OptionalPhone,
  OptionalText,
  PasswordField,
  RequiredText,
  StoreSlug,
  TimezoneField,
  WhenPresent,
} from '../../../common/validation/fields.js';
import { TeamMemberDto } from '../../team/team.dto.js';

// ---------------------------------------------------------------------------------------------------------------------
// Responses
// ---------------------------------------------------------------------------------------------------------------------

export class CompanyDto {
  @ApiProperty({ format: 'uuid' }) id!: string;
  @ApiProperty() name!: string;
  @ApiProperty() slug!: string;
  @ApiProperty({
    example: 'zqkod2',
    description: 'Read-only random public identifier.',
  })
  publicId!: string;
  @ApiProperty({ enum: ['active', 'suspended'] }) status!: string;
  @ApiPropertyOptional({ nullable: true }) contactPhone!: string | null;
  @ApiPropertyOptional({ nullable: true }) address!: string | null;
  @ApiProperty() createdAt!: Date;
  @ApiPropertyOptional({ format: 'uuid', nullable: true }) storeId!:
    string | null;
  @ApiPropertyOptional({ nullable: true }) storeName!: string | null;
  @ApiPropertyOptional({ nullable: true }) storeSlug!: string | null;
  @ApiPropertyOptional({ format: 'uuid', nullable: true }) ownerId!:
    string | null;
  @ApiPropertyOptional({ nullable: true }) ownerName!: string | null;
  @ApiPropertyOptional({ nullable: true }) ownerEmail!: string | null;
  @ApiProperty() memberCount!: number;
}

export class PlatformOverviewDto {
  @ApiProperty() totalOrganizations!: number;
  @ApiProperty() active!: number;
  @ApiProperty() suspended!: number;
  @ApiProperty() totalUsers!: number;
  @ApiProperty({
    type: [CompanyDto],
    description: 'The five organizations created most recently.',
  })
  recent!: CompanyDto[];
}

export class PlatformStoreDto {
  @ApiProperty({ format: 'uuid' }) id!: string;
  @ApiProperty() name!: string;
  @ApiProperty() slug!: string;
  @ApiPropertyOptional({ nullable: true }) description!: string | null;
  @ApiProperty({ example: 'INR' }) currency!: string;
  @ApiProperty({ example: 'Asia/Kolkata' }) timezone!: string;
  @ApiProperty({ enum: ['active', 'inactive', 'suspended'] }) status!: string;
  @ApiPropertyOptional({ nullable: true }) contactEmail!: string | null;
  @ApiPropertyOptional({ nullable: true }) contactPhone!: string | null;
  @ApiProperty({
    description:
      'Becomes true once the store has products or orders. From then on the currency can no longer be changed.',
  })
  hasMoneyData!: boolean;
}

export class CompanyDetailDto {
  @ApiProperty({ type: CompanyDto }) company!: CompanyDto;
  @ApiProperty({ type: PlatformStoreDto, nullable: true })
  store!: PlatformStoreDto | null;
  @ApiProperty({ type: [TeamMemberDto] }) team!: TeamMemberDto[];
}

export class CreatedCompanyDto {
  @ApiProperty({ format: 'uuid' }) tenantId!: string;
  @ApiProperty({ example: 'zqkod2' }) publicId!: string;
  @ApiProperty({ format: 'uuid' }) storeId!: string;
  @ApiProperty({ format: 'uuid' }) ownerId!: string;
  @ApiProperty() ownerEmail!: string;
}

export class RecoveredOwnerDto {
  @ApiProperty() email!: string;
}

// ---------------------------------------------------------------------------------------------------------------------
// Requests
// ---------------------------------------------------------------------------------------------------------------------

export class OrgListQueryDto extends PaginationQueryDto {
  @ApiPropertyOptional({ enum: ['all', 'active', 'suspended'], default: 'all' })
  @IsOptional()
  @IsIn(['all', 'active', 'suspended'])
  status: 'all' | 'active' | 'suspended' = 'all';

  @ApiPropertyOptional({ enum: ['created', 'name'], default: 'created' })
  @IsOptional()
  @IsIn(['created', 'name'])
  sortBy: 'created' | 'name' = 'created';
}

export class CreateOrganizationDto {
  @ApiProperty({ minLength: 2, maxLength: 80 })
  @RequiredText('Organization name', 80, 2)
  companyName!: string;

  @ApiProperty({ minLength: 2, maxLength: 80 })
  @RequiredText('Store name', 80, 2)
  storeName!: string;

  @ApiProperty({
    example: 'acme-store',
    description:
      'The store web address: 3 to 40 characters. Reserved names cannot be used.',
  })
  @StoreSlug()
  storeSlug!: string;

  @ApiPropertyOptional({ nullable: true, maxLength: 500 })
  @OptionalText('Store description', 500)
  storeDescription?: string | null;

  @ApiPropertyOptional({ nullable: true })
  @OptionalPhone()
  contactPhone?: string | null;

  @ApiPropertyOptional({ nullable: true, maxLength: 300 })
  @OptionalText('Address', 300)
  address?: string | null;

  @ApiProperty({ minLength: 2, maxLength: 120 })
  @RequiredText('Owner name', 120, 2)
  ownerName!: string;

  @ApiProperty()
  @EmailField('Owner email')
  ownerEmail!: string;

  @ApiProperty({
    description:
      'The first password for the Owner, 8 to 72 characters with at least one letter and one number. It is never saved or written to logs.',
  })
  @PasswordField()
  ownerPassword!: string;

  @ApiPropertyOptional({
    format: 'uuid',
    description:
      'The plan to start on. It must be active. Leave it out to use the default plan.',
  })
  @IsOptional()
  @IsUUID(undefined, { message: 'Choose a plan.' })
  planId?: string;

  @ApiPropertyOptional({ enum: BILLING_INTERVALS, default: 'monthly' })
  @IsOptional()
  @IsIn(BILLING_INTERVALS, { message: 'Choose monthly or yearly billing.' })
  billingInterval?: (typeof BILLING_INTERVALS)[number];
}

/** Organization: name, contact phone and address. The slug and status are not editable here. */
export class UpdateOrganizationDto {
  @ApiPropertyOptional({ minLength: 2, maxLength: 80 })
  @WhenPresent()
  @RequiredText('Organization name', 80, 2)
  companyName?: string;

  @ApiPropertyOptional({ nullable: true })
  @OptionalPhone()
  contactPhone?: string | null;

  @ApiPropertyOptional({ nullable: true, maxLength: 300 })
  @OptionalText('Address', 300)
  address?: string | null;
}

export class OrganizationStatusDto {
  @ApiProperty({ enum: ['active', 'suspended'] })
  @IsIn(['active', 'suspended'])
  status!: 'active' | 'suspended';
}

/** Store: name, description, contacts, currency and timezone (never the address or logo). */
export class UpdateOrganizationStoreDto {
  @ApiPropertyOptional({ minLength: 2, maxLength: 80 })
  @WhenPresent()
  @RequiredText('Store name', 80, 2)
  name?: string;

  @ApiPropertyOptional({ nullable: true, maxLength: 500 })
  @OptionalText('Store description', 500)
  description?: string | null;

  @ApiPropertyOptional({ nullable: true })
  @OptionalEmail('Store email')
  contactEmail?: string | null;

  @ApiPropertyOptional({ nullable: true })
  @OptionalPhone()
  contactPhone?: string | null;

  @ApiPropertyOptional({ example: 'INR' })
  @WhenPresent()
  @CurrencyField()
  currency?: string;

  @ApiPropertyOptional({ example: 'Asia/Kolkata' })
  @WhenPresent()
  @TimezoneField()
  timezone?: string;
}

const PREVIOUS_OWNER = ['keep', 'disable'] as const;

export class TransferOwnershipDto {
  @ApiProperty({
    format: 'uuid',
    description:
      'The id of an active member of this organization who will become the new Owner.',
  })
  @IsUUID('all', { message: 'Choose a team member.' })
  userId!: string;

  @ApiPropertyOptional({
    enum: PREVIOUS_OWNER,
    default: 'keep',
    description:
      'What happens to the current Owner after the transfer: `keep` them as a team member or `disable` their access.',
  })
  @IsOptional()
  @IsIn(PREVIOUS_OWNER, {
    message: 'Choose what happens to the current owner.',
  })
  previousOwner?: 'keep' | 'disable';
}

export class RecoverOwnerDto {
  @ApiProperty({ minLength: 2, maxLength: 120 })
  @RequiredText('Owner name', 120, 2)
  ownerName!: string;

  @ApiProperty()
  @EmailField('Owner email')
  ownerEmail!: string;

  @ApiProperty({
    description:
      'The first password for the new Owner. It is set once and is never saved or written to logs.',
  })
  @PasswordField()
  ownerPassword!: string;

  @ApiPropertyOptional({ enum: PREVIOUS_OWNER, default: 'keep' })
  @IsOptional()
  @IsIn(PREVIOUS_OWNER, {
    message: 'Choose what happens to the current owner.',
  })
  previousOwner?: 'keep' | 'disable';
}
