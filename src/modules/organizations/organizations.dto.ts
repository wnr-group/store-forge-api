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
    description:
      'The name shown for your role: Owner, Manager, Staff, Viewer or Custom.',
  })
  roleLabel!: string;
  @ApiProperty() permissions!: Record<string, string>;
  @ApiProperty({
    type: [AccessEntryDto],
    description:
      'The parts (modules) of the store you can use, with your actual access level for each. The Owner can use everything.',
  })
  access!: AccessEntryDto[];
  @ApiProperty({ type: StoreDto, nullable: true }) store!: StoreDto | null;
}
