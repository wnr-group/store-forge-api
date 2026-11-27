import {
  Body,
  Controller,
  Delete,
  Get,
  Headers,
  HttpCode,
  Param,
  ParseIntPipe,
  ParseUUIDPipe,
  Patch,
  Post,
  Put,
  Query,
} from '@nestjs/common';
import { ApiHeader, ApiParam, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { ApiEndpoint } from '../../common/decorators/api-endpoint.decorator.js';
import { Public } from '../../common/decorators/decorators.js';
import {
  AccountOrderDto,
  AccountOrderSummaryDto,
  ChangeCustomerPasswordDto,
  CustomerAccountOrdersQueryDto,
  CustomerAddressDto,
  CustomerAddressInputDto,
  CustomerProfileDto,
  CustomerSessionDto,
  LoginCustomerDto,
  RegisterCustomerDto,
  UpdateCustomerProfileDto,
} from './customer-accounts.dto.js';
import { CustomerAccountsService } from './customer-accounts.service.js';

/** Creating accounts and guessing passwords are the abusable calls: tighter limits than the global default. */
const AUTH_LIMIT = { default: { limit: 10, ttl: 60_000 } };
const READ_LIMIT = { default: { limit: 60, ttl: 60_000 } };
const WRITE_LIMIT = { default: { limit: 30, ttl: 60_000 } };

const SESSION_HEADER = {
  name: 'X-Customer-Session',
  required: true,
  description:
    'The shopper session token returned by register or login for THIS store. A token from another store, an expired or a signed-out one is a 401.',
};

/**
 * The shopper's own account area of one store. Public in the sense that no owner/staff/admin login is involved (those tokens are
 * never accepted here); the shopper proves who they are with the opaque session this module issues, and every query is pinned to
 * the store in the URL and to the account behind that session.
 */
@ApiTags('customer-accounts')
@Controller('public/stores/:slug/account')
@Public()
export class CustomerAccountsController {
  constructor(private readonly accounts: CustomerAccountsService) {}

  @Post('register')
  @Throttle(AUTH_LIMIT)
  @ApiParam({ name: 'slug', example: 'acme-store' })
  @ApiEndpoint({
    summary: 'Create a shopper account',
    description:
      'Creates an account for this store (the same email can have an account in other stores) and signs the shopper in. Browsing, the cart and product pages never need one; it is asked for at checkout.',
    auth: 'public',
    body: RegisterCustomerDto,
    response: CustomerSessionDto,
    status: 201,
    message: 'Account created successfully',
    errors: [400, 404, 409, 429],
  })
  register(@Param('slug') slug: string, @Body() dto: RegisterCustomerDto) {
    return this.accounts.register(slug.toLowerCase(), dto);
  }

  @Post('login')
  @HttpCode(200)
  @Throttle(AUTH_LIMIT)
  @ApiParam({ name: 'slug', example: 'acme-store' })
  @ApiEndpoint({
    summary: 'Sign a shopper in',
    description:
      'Checks the email and password for this store. A wrong email and a wrong password look the same; after repeated wrong passwords the account is locked for a few minutes.',
    auth: 'public',
    body: LoginCustomerDto,
    response: CustomerSessionDto,
    message: 'Signed in successfully',
    errors: [400, 401, 404, 429],
  })
  login(@Param('slug') slug: string, @Body() dto: LoginCustomerDto) {
    return this.accounts.login(slug.toLowerCase(), dto);
  }

  @Post('logout')
  @HttpCode(200)
  @Throttle(WRITE_LIMIT)
  @ApiParam({ name: 'slug', example: 'acme-store' })
  @ApiHeader(SESSION_HEADER)
  @ApiEndpoint({
    summary: 'Sign a shopper out',
    description: 'Ends this session. Other devices stay signed in.',
    auth: 'public',
    response: null,
    message: 'Signed out successfully',
    errors: [404, 429],
  })
  logout(
    @Param('slug') slug: string,
    @Headers('x-customer-session') token: string | undefined,
  ) {
    return this.accounts.logout(slug.toLowerCase(), token);
  }

  @Get('me')
  @Throttle(READ_LIMIT)
  @ApiParam({ name: 'slug', example: 'acme-store' })
  @ApiHeader(SESSION_HEADER)
  @ApiEndpoint({
    summary: 'Get my profile',
    description:
      'The signed-in shopper’s name, email and phone number for this store. Also the quickest way to check that a session is still valid.',
    auth: 'public',
    response: CustomerProfileDto,
    message: 'Profile retrieved successfully',
    errors: [401, 404, 429],
  })
  me(
    @Param('slug') slug: string,
    @Headers('x-customer-session') token: string | undefined,
  ) {
    return this.accounts.me(slug.toLowerCase(), token);
  }

  @Patch('me')
  @Throttle(WRITE_LIMIT)
  @ApiParam({ name: 'slug', example: 'acme-store' })
  @ApiHeader(SESSION_HEADER)
  @ApiEndpoint({
    summary: 'Update my profile',
    description:
      'Changes the name and phone number. The email is the sign-in identity and cannot be changed here.',
    auth: 'public',
    body: UpdateCustomerProfileDto,
    response: CustomerProfileDto,
    message: 'Profile updated successfully',
    errors: [400, 401, 404, 429],
  })
  updateProfile(
    @Param('slug') slug: string,
    @Headers('x-customer-session') token: string | undefined,
    @Body() dto: UpdateCustomerProfileDto,
  ) {
    return this.accounts.updateProfile(slug.toLowerCase(), token, dto);
  }

  @Post('password')
  @HttpCode(200)
  @Throttle(AUTH_LIMIT)
  @ApiParam({ name: 'slug', example: 'acme-store' })
  @ApiHeader(SESSION_HEADER)
  @ApiEndpoint({
    summary: 'Change my password',
    description:
      'Needs the current password. Every other signed-in device is signed out. (There is no "forgot password" flow.)',
    auth: 'public',
    body: ChangeCustomerPasswordDto,
    response: null,
    message: 'Password changed successfully',
    errors: [400, 401, 404, 429],
  })
  changePassword(
    @Param('slug') slug: string,
    @Headers('x-customer-session') token: string | undefined,
    @Body() dto: ChangeCustomerPasswordDto,
  ) {
    return this.accounts.changePassword(slug.toLowerCase(), token, dto);
  }

  @Get('addresses')
  @Throttle(READ_LIMIT)
  @ApiParam({ name: 'slug', example: 'acme-store' })
  @ApiHeader(SESSION_HEADER)
  @ApiEndpoint({
    summary: 'List my saved addresses',
    description:
      'The delivery addresses this shopper saved in this store, the default one first. Another shopper’s addresses never appear.',
    auth: 'public',
    response: [CustomerAddressDto],
    message: 'Addresses retrieved successfully',
    errors: [401, 404, 429],
  })
  addresses(
    @Param('slug') slug: string,
    @Headers('x-customer-session') token: string | undefined,
  ) {
    return this.accounts.listAddresses(slug.toLowerCase(), token);
  }

  @Post('addresses')
  @Throttle(WRITE_LIMIT)
  @ApiParam({ name: 'slug', example: 'acme-store' })
  @ApiHeader(SESSION_HEADER)
  @ApiEndpoint({
    summary: 'Save a delivery address',
    description:
      'Up to 10 per account. The first one is the default. Returns the updated list.',
    auth: 'public',
    body: CustomerAddressInputDto,
    response: [CustomerAddressDto],
    status: 201,
    message: 'Address saved successfully',
    errors: [400, 401, 404, 409, 429],
  })
  addAddress(
    @Param('slug') slug: string,
    @Headers('x-customer-session') token: string | undefined,
    @Body() dto: CustomerAddressInputDto,
  ) {
    return this.accounts.addAddress(slug.toLowerCase(), token, dto);
  }

  @Put('addresses/:id')
  @Throttle(WRITE_LIMIT)
  @ApiParam({ name: 'slug', example: 'acme-store' })
  @ApiParam({ name: 'id', format: 'uuid' })
  @ApiHeader(SESSION_HEADER)
  @ApiEndpoint({
    summary: 'Change a saved address',
    description: 'Returns the updated list.',
    auth: 'public',
    body: CustomerAddressInputDto,
    response: [CustomerAddressDto],
    message: 'Address updated successfully',
    errors: [400, 401, 404, 429],
  })
  updateAddress(
    @Param('slug') slug: string,
    @Param('id', ParseUUIDPipe) id: string,
    @Headers('x-customer-session') token: string | undefined,
    @Body() dto: CustomerAddressInputDto,
  ) {
    return this.accounts.updateAddress(slug.toLowerCase(), token, id, dto);
  }

  @Delete('addresses/:id')
  @Throttle(WRITE_LIMIT)
  @ApiParam({ name: 'slug', example: 'acme-store' })
  @ApiParam({ name: 'id', format: 'uuid' })
  @ApiHeader(SESSION_HEADER)
  @ApiEndpoint({
    summary: 'Remove a saved address',
    description:
      'Returns the updated list. Orders already placed keep their own copy of the address.',
    auth: 'public',
    response: [CustomerAddressDto],
    message: 'Address removed successfully',
    errors: [401, 404, 429],
  })
  deleteAddress(
    @Param('slug') slug: string,
    @Param('id', ParseUUIDPipe) id: string,
    @Headers('x-customer-session') token: string | undefined,
  ) {
    return this.accounts.deleteAddress(slug.toLowerCase(), token, id);
  }

  @Get('orders')
  @Throttle(READ_LIMIT)
  @ApiParam({ name: 'slug', example: 'acme-store' })
  @ApiHeader(SESSION_HEADER)
  @ApiEndpoint({
    summary: 'List my orders',
    description:
      'The orders placed from this account in this store, newest first. Nobody else’s orders can appear here.',
    auth: 'public',
    response: [AccountOrderSummaryDto],
    paginated: true,
    message: 'Orders retrieved successfully',
    errors: [400, 401, 404, 429],
  })
  orders(
    @Param('slug') slug: string,
    @Headers('x-customer-session') token: string | undefined,
    @Query() query: CustomerAccountOrdersQueryDto,
  ) {
    return this.accounts.listOrders(slug.toLowerCase(), token, query);
  }

  @Get('orders/:orderNumber')
  @Throttle(READ_LIMIT)
  @ApiParam({ name: 'slug', example: 'acme-store' })
  @ApiParam({ name: 'orderNumber', example: 1001 })
  @ApiHeader(SESSION_HEADER)
  @ApiEndpoint({
    summary: 'View one of my orders',
    description:
      'Items, amounts, payment, delivery address, parcels (courier, tracking number and link) and the status timeline with times. Someone else’s order and a missing one both answer 404.',
    auth: 'public',
    response: AccountOrderDto,
    message: 'Order retrieved successfully',
    errors: [401, 404, 429],
  })
  order(
    @Param('slug') slug: string,
    @Param('orderNumber', ParseIntPipe) orderNumber: number,
    @Headers('x-customer-session') token: string | undefined,
  ) {
    return this.accounts.getOrder(slug.toLowerCase(), token, orderNumber);
  }

  @Post('orders/:orderNumber/cancel')
  @HttpCode(200)
  @Throttle(WRITE_LIMIT)
  @ApiParam({ name: 'slug', example: 'acme-store' })
  @ApiParam({ name: 'orderNumber', example: 1001 })
  @ApiHeader(SESSION_HEADER)
  @ApiEndpoint({
    summary: 'Cancel one of my orders',
    description:
      'Only while the store has not started on it (unpaid or confirmed). A paid order has to be refunded first (409 `REFUND_REQUIRED`).',
    auth: 'public',
    response: AccountOrderDto,
    message: 'Order cancelled successfully',
    errors: [401, 404, 409, 429],
  })
  cancel(
    @Param('slug') slug: string,
    @Param('orderNumber', ParseIntPipe) orderNumber: number,
    @Headers('x-customer-session') token: string | undefined,
  ) {
    return this.accounts.cancelOrder(slug.toLowerCase(), token, orderNumber);
  }
}
