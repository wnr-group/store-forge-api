import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
} from '@nestjs/common';
import { ApiParam, ApiTags } from '@nestjs/swagger';
import { ApiEndpoint } from '../../common/decorators/api-endpoint.decorator.js';
import {
  CurrentOrg,
  OrgScoped,
  RequirePermission,
} from '../../common/decorators/decorators.js';
import type { OrgContext } from '../../common/interfaces/request-context.js';
import {
  CreateCustomerDto,
  CustomerDetailDto,
  CustomerDto,
  CustomerListQueryDto,
  UpdateCustomerDto,
} from './customers.dto.js';
import { CustomersService } from './customers.service.js';

@ApiTags('customers')
@Controller('customers')
@OrgScoped()
export class CustomersController {
  constructor(private readonly customers: CustomersService) {}

  @Get()
  @RequirePermission('customers:view')
  @ApiEndpoint({
    summary: 'List customers',
    description:
      'Search by name, email or phone; sort by `createdAt`, `name`, `spent` or `orders`. Order counts and spend (paid + fulfilled orders) are computed in SQL.',
    auth: 'org',
    permission: 'customers:view',
    response: [CustomerDto],
    paginated: true,
    message: 'Customers retrieved successfully',
  })
  list(@CurrentOrg() org: OrgContext, @Query() query: CustomerListQueryDto) {
    return this.customers.list(org, query);
  }

  @Get(':id')
  @RequirePermission('customers:view')
  @ApiParam({ name: 'id', format: 'uuid' })
  @ApiEndpoint({
    summary: 'Get a customer with recent orders',
    auth: 'org',
    permission: 'customers:view',
    response: CustomerDetailDto,
    message: 'Customer retrieved successfully',
    errors: [404],
  })
  get(@CurrentOrg() org: OrgContext, @Param('id', ParseUUIDPipe) id: string) {
    return this.customers.get(org, id);
  }

  @Post()
  @RequirePermission('customers:manage')
  @ApiEndpoint({
    summary: 'Create a customer',
    auth: 'org',
    permission: 'customers:manage',
    body: CreateCustomerDto,
    response: CustomerDetailDto,
    status: 201,
    message: 'Customer created successfully',
    errors: [409],
  })
  create(@CurrentOrg() org: OrgContext, @Body() dto: CreateCustomerDto) {
    return this.customers.create(org, dto);
  }

  @Patch(':id')
  @RequirePermission('customers:manage')
  @ApiParam({ name: 'id', format: 'uuid' })
  @ApiEndpoint({
    summary: 'Update a customer',
    description: 'Partial update.',
    auth: 'org',
    permission: 'customers:manage',
    body: UpdateCustomerDto,
    response: CustomerDetailDto,
    message: 'Customer updated successfully',
    errors: [404, 409],
  })
  update(
    @CurrentOrg() org: OrgContext,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateCustomerDto,
  ) {
    return this.customers.update(org, id, dto);
  }

  @Delete(':id')
  @RequirePermission('customers:delete')
  @ApiParam({ name: 'id', format: 'uuid' })
  @ApiEndpoint({
    summary: 'Delete a customer',
    description:
      'Their orders are kept; the orders simply lose the customer link.',
    auth: 'org',
    permission: 'customers:delete',
    response: null,
    message: 'Customer deleted successfully',
    errors: [404],
  })
  async remove(
    @CurrentOrg() org: OrgContext,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    await this.customers.remove(org, id);
  }
}
