import { Body, Controller, Get, HttpCode, Post } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { ApiEndpoint } from '../../common/decorators/api-endpoint.decorator.js';
import { CurrentUser } from '../../common/decorators/decorators.js';
import type { AuthUser } from '../../common/interfaces/request-context.js';
import { VerifyPaymentDto } from '../billing/billing.dto.js';
import {
  CreateStoreDto,
  SignupCheckoutDto,
  SignupPaymentVerifiedDto,
  SignupStatusDto,
  SignupStoreDto,
  StartCheckoutDto,
} from './signup.dto.js';
import { SignupService } from './signup.service.js';

const LIMIT = { default: { limit: 20, ttl: 60_000 } };

/**
 * Self-service sign-up after the account exists. These routes need a signed-in person but NO organization (the person does not have one
 * yet), and every one of them works only on the caller's own purchase: it is looked up by the verified user id, never by an id the
 * browser sends.
 */
@ApiTags('signup')
@Controller('signup')
export class SignupController {
  constructor(private readonly signup: SignupService) {}

  @Get('status')
  @ApiEndpoint({
    summary: 'Where am I in the sign-up?',
    description:
      'Tells the signed-in person what to do next: nothing started yet, pay for the chosen plan, name the store (the plan is paid), or the store already exists.',
    auth: 'jwt',
    response: SignupStatusDto,
    message: 'Sign-up status retrieved successfully',
  })
  status(@CurrentUser() user: AuthUser) {
    return this.signup.status(user);
  }

  @Post('checkout')
  @HttpCode(200)
  @Throttle(LIMIT)
  @ApiEndpoint({
    summary: 'Choose a plan and start paying',
    description:
      'Starts (or resumes) the purchase of a published plan. The price is worked out on the server from the plan and the current tax settings. The answer holds what Razorpay Checkout needs (the order id and the public key id). Calling it again after a failed or abandoned payment returns the same order, so a retry needs no new account. A free plan needs no payment: the answer has `state: store_required` and no `payment`.',
    auth: 'jwt',
    body: StartCheckoutDto,
    response: SignupCheckoutDto,
    message: 'Checkout started successfully',
    errors: [400, 404, 409, 429, 503],
  })
  checkout(@CurrentUser() user: AuthUser, @Body() dto: StartCheckoutDto) {
    return this.signup.startCheckout(user, dto);
  }

  @Post('verify-payment')
  @HttpCode(200)
  @Throttle(LIMIT)
  @ApiEndpoint({
    summary: 'Confirm a payment',
    description:
      "Hands Razorpay's three checkout values to the server. It checks the signature AND asks Razorpay itself whether the payment is captured, for this order and this amount, before anything is marked paid. The browser saying 'success' proves nothing. Idempotent: confirming the same payment twice changes nothing. Razorpay's signed webhook reaches the same result if the browser never gets here.",
    auth: 'jwt',
    body: VerifyPaymentDto,
    response: SignupPaymentVerifiedDto,
    message: 'Payment confirmed successfully',
    errors: [400, 404, 409, 429, 503],
  })
  verify(@CurrentUser() user: AuthUser, @Body() dto: VerifyPaymentDto) {
    return this.signup.verifyPayment(user, dto);
  }

  @Post('store')
  @HttpCode(200)
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @ApiEndpoint({
    summary: 'Create my store',
    description:
      'After the plan is paid: creates the organization and its store from a store name, makes the person who paid its Owner, and puts it on the plan they paid for. The store address is made from the name. Refused until the payment is confirmed. Sending it twice returns the same store.',
    auth: 'jwt',
    body: CreateStoreDto,
    response: SignupStoreDto,
    message: 'Store created successfully',
    errors: [400, 404, 409, 429],
  })
  store(@CurrentUser() user: AuthUser, @Body() dto: CreateStoreDto) {
    return this.signup.createStore(user, dto);
  }
}
