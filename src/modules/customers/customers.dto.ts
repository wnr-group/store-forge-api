import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsIn, IsOptional } from 'class-validator';
import { PaginationQueryDto } from '../../common/dto/pagination-query.dto.js';
import {
  EmailField,
  OptionalPhone,
  OptionalText,
  RequiredText,
  WhenPresent,
} from '../../common/validation/fields.js';
import { ORDER_STATUSES } from '../../database/schema/enums.js';

export class CustomerDto {
  @ApiProperty({ format: 'uuid' }) id!: string;
  @ApiProperty() fullName!: string;
  @ApiProperty() email!: string;
  @ApiPropertyOptional({ nullable: true }) phone!: string | null;
  @ApiPropertyOptional({ nullable: true }) notes!: string | null;
  @ApiProperty({ description: 'Orders of any status.' }) orderCount!: number;
  @ApiProperty({
    description: 'Sum of paid and fulfilled orders, in minor units.',
  })
  totalSpentMinor!: number;
  @ApiPropertyOptional({ nullable: true }) lastOrderAt!: Date | null;
  @ApiProperty() createdAt!: Date;
  @ApiProperty() updatedAt!: Date;
}

export class CustomerOrderDto {
  @ApiProperty({ format: 'uuid' }) id!: string;
  @ApiProperty() orderNumber!: number;
  @ApiProperty({ enum: ORDER_STATUSES }) status!: string;
  @ApiProperty({ example: 'INR' }) currency!: string;
  @ApiProperty() subtotalMinor!: number;
  @ApiProperty() totalMinor!: number;
  @ApiProperty() placedAt!: Date;
}

export class CustomerDetailDto extends CustomerDto {
  @ApiProperty({
    type: [CustomerOrderDto],
    description: 'The 50 most recent orders. Orders are read-only.',
  })
  orders!: CustomerOrderDto[];
}

export class CustomerListQueryDto extends PaginationQueryDto {
  @ApiPropertyOptional({
    enum: ['createdAt', 'name', 'spent', 'orders'],
    default: 'createdAt',
  })
  @IsOptional()
  @IsIn(['createdAt', 'name', 'spent', 'orders'])
  sortBy: 'createdAt' | 'name' | 'spent' | 'orders' = 'createdAt';
}

export class CreateCustomerDto {
  @ApiProperty({ maxLength: 120 })
  @RequiredText('Customer name', 120)
  fullName!: string;

  @ApiProperty({ description: 'Unique per organization, case-insensitive.' })
  @EmailField('Email address')
  email!: string;

  @ApiPropertyOptional({ nullable: true })
  @OptionalPhone()
  phone?: string | null;

  @ApiPropertyOptional({ nullable: true, maxLength: 2000 })
  @OptionalText('Notes', 2000)
  notes?: string | null;
}

export class UpdateCustomerDto {
  @ApiPropertyOptional({ maxLength: 120 })
  @WhenPresent()
  @RequiredText('Customer name', 120)
  fullName?: string;

  @ApiPropertyOptional()
  @WhenPresent()
  @EmailField('Email address')
  email?: string;

  @ApiPropertyOptional({ nullable: true })
  @OptionalPhone()
  phone?: string | null;

  @ApiPropertyOptional({ nullable: true, maxLength: 2000 })
  @OptionalText('Notes', 2000)
  notes?: string | null;
}
