import { ApiProperty } from '@nestjs/swagger';
import { StoreDto } from '../store/store.dto.js';

export class OrganizationSummaryDto {
  @ApiProperty({ format: 'uuid' }) id!: string;
  @ApiProperty() name!: string;
  @ApiProperty() slug!: string;
  @ApiProperty({ enum: ['owner', 'admin', 'staff'] }) role!: string;
  @ApiProperty({
    example: {
      products: 'write',
      orders: 'read',
      customers: 'write',
      settings: 'read',
    },
  })
  permissions!: Record<string, string>;
  @ApiProperty() joinedAt!: Date;
}

export class AccessEntryDto {
  @ApiProperty({ enum: ['products', 'orders', 'customers', 'settings'] })
  module!: string;
  @ApiProperty({ example: 'Products & inventory' }) label!: string;
  @ApiProperty({ enum: ['read', 'write'] }) level!: string;
}

export class OrganizationRefDto {
  @ApiProperty({ format: 'uuid' }) id!: string;
  @ApiProperty() name!: string;
  @ApiProperty() slug!: string;
}

export class CurrentOrganizationDto {
  @ApiProperty({ type: OrganizationRefDto }) organization!: OrganizationRefDto;
  @ApiProperty({ enum: ['owner', 'admin', 'staff'] }) role!: string;
  @ApiProperty({
    description: 'Display label: Owner, Manager, Staff, Viewer or Custom.',
  })
  roleLabel!: string;
  @ApiProperty() permissions!: Record<string, string>;
  @ApiProperty({
    type: [AccessEntryDto],
    description:
      'Modules the caller can reach, with their effective level (the Owner has everything).',
  })
  access!: AccessEntryDto[];
  @ApiProperty({ type: StoreDto, nullable: true }) store!: StoreDto | null;
}
