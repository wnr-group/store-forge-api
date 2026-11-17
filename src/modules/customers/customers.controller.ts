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
      'See the people who have bought from your store, a page at a time. You can search by name, email or phone number, and sort by when they were added (`createdAt`), their name (`name`), how much they have spent (`spent`) or how many orders they placed (`orders`). Each customer shows their order count and total spend. Total spend counts only paid and fulfilled orders.',
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
    summary: 'View one customer',
    description:
      "Get a customer's details together with their order history. The history shows their 50 most recent orders, newest first.",
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
    summary: 'Add a customer',
    description:
      'Add a new customer to your store. Two customers in the same store cannot have the same email address.',
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
    summary: 'Edit a customer',
    description:
      "Change a customer's details. Send only the fields you want to change and the rest stay as they are.",
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
    summary: 'Remove a customer',
    description:
      'Delete a customer. Their past orders are not deleted, they just no longer point to a customer.',
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
