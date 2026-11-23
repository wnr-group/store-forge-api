import {
  Body,
  Controller,
  Get,
  Headers,
  HttpCode,
  Param,
  ParseIntPipe,
  Post,
  Query,
} from '@nestjs/common';
import { ApiHeader, ApiParam, ApiQuery, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { ApiEndpoint } from '../../common/decorators/api-endpoint.decorator.js';
import { Public } from '../../common/decorators/decorators.js';
import { PublicOrderDto } from '../orders/checkout.dto.js';
import { CheckoutService } from '../orders/checkout.service.js';
import { PaymentMethodsPolicy } from '../payments/payment-methods.policy.js';
import { DatabaseService } from '../../database/database.service.js';
import { invalid } from '../../common/app.exception.js';
import {
  PaymentMethodOptionsDto,
  RazorpaySessionDto,
  ReportRazorpayFailureDto,
  VerifyRazorpayPaymentDto,
} from './checkout-payments.dto.js';
import { RazorpayPaymentsService } from './razorpay-payments.service.js';

const PAY_LIMIT = { default: { limit: 20, ttl: 60_000 } };
const READ_LIMIT = { default: { limit: 60, ttl: 60_000 } };

@ApiTags('checkout')
@Controller('public/stores/:slug')
@Public()
export class CheckoutPaymentsController {
  constructor(
    private readonly razorpay: RazorpayPaymentsService,
    private readonly checkout: CheckoutService,
    private readonly db: DatabaseService,
    private readonly policy: PaymentMethodsPolicy,
  ) {}

  @Get('payment-methods')
  @Throttle(READ_LIMIT)
  @ApiParam({ name: 'slug', example: 'acme-store' })
  @ApiQuery({
    name: 'subtotalMinor',
    required: false,
    description:
      'The items subtotal in paise, to see whether COD limits allow it.',
  })
  @ApiEndpoint({
    summary: 'Which payment methods this store offers',
    description:
      'Tells the checkout page whether to show online payment (Razorpay) and cash on delivery for an order of this value, and the COD charge. Anyone can call it without signing in.',
    auth: 'public',
    response: PaymentMethodOptionsDto,
    message: 'Payment methods retrieved successfully',
    errors: [400, 404, 429],
  })
  async methods(
    @Param('slug') slug: string,
    @Query('subtotalMinor') subtotal?: string,
  ) {
    const value = subtotal === undefined ? 0 : Number(subtotal);
    if (!Number.isSafeInteger(value) || value < 0)
      throw invalid('Invalid order value.');
    const store = await this.checkout.resolveStore(slug.toLowerCase());
    const o = await this.db.withCheckout(store.tenantId, (tx) =>
      this.policy.options(tx, store.tenantId, value),
    );
    return {
      razorpayAvailable: o.razorpay.available,
      codAvailable: o.cod.available,
      codFeeMinor: o.cod.feeMinor,
      codUnavailableReason: o.cod.reason,
    };
  }

  @Post('orders/:orderNumber/payments/razorpay')
  @HttpCode(200)
  @Throttle(PAY_LIMIT)
  @ApiParam({ name: 'slug', example: 'acme-store' })
  @ApiParam({ name: 'orderNumber', example: 1001 })
  @ApiHeader({ name: 'X-Order-Token', required: true })
  @ApiEndpoint({
    summary: 'Start (or retry) the online payment for an order',
    description:
      'Creates the Razorpay order for an unpaid online order, for the amount the server computed, and returns what Razorpay Checkout needs (`key`, `order_id`, `amount`, `prefill`). Calling it again after a failed attempt reuses the same Razorpay order, so a retry never creates a second one. Fails with 409 if the order is not payable, has already been paid, or its payment time ran out.',
    auth: 'public',
    response: RazorpaySessionDto,
    message: 'Payment started successfully',
    errors: [404, 409, 429, 503],
  })
  start(
    @Param('slug') slug: string,
    @Param('orderNumber', ParseIntPipe) orderNumber: number,
    @Headers('x-order-token') token?: string,
  ) {
    return this.razorpay.createPayment(slug.toLowerCase(), orderNumber, token);
  }

  @Post('orders/:orderNumber/payments/razorpay/verify')
  @HttpCode(200)
  @Throttle(PAY_LIMIT)
  @ApiParam({ name: 'slug', example: 'acme-store' })
  @ApiParam({ name: 'orderNumber', example: 1001 })
  @ApiHeader({ name: 'X-Order-Token', required: true })
  @ApiEndpoint({
    summary: 'Confirm an online payment',
    description:
      "Send the three values Razorpay Checkout returns after a successful payment. The server checks the signature with the store's own secret and then asks Razorpay directly about the payment (order, amount, status), capturing it if Razorpay left it only authorised. Only then is the order marked paid and confirmed. Sending the same details twice is safe. If the items sold out while the shopper was paying, the order is cancelled and flagged for a refund.",
    auth: 'public',
    body: VerifyRazorpayPaymentDto,
    response: PublicOrderDto,
    message: 'Payment confirmed',
    errors: [400, 404, 409, 429, 503],
  })
  verify(
    @Param('slug') slug: string,
    @Param('orderNumber', ParseIntPipe) orderNumber: number,
    @Body() dto: VerifyRazorpayPaymentDto,
    @Headers('x-order-token') token?: string,
  ) {
    return this.razorpay.verifyPayment(
      slug.toLowerCase(),
      orderNumber,
      token,
      dto,
    );
  }

  @Post('orders/:orderNumber/payments/razorpay/failed')
  @HttpCode(200)
  @Throttle(PAY_LIMIT)
  @ApiParam({ name: 'slug', example: 'acme-store' })
  @ApiParam({ name: 'orderNumber', example: 1001 })
  @ApiHeader({ name: 'X-Order-Token', required: true })
  @ApiEndpoint({
    summary: 'Record a failed online payment attempt',
    description:
      "Call it when Razorpay Checkout reports a failed payment. The browser's word is not trusted: the server looks the payment up at Razorpay and records the failure reason Razorpay gives. The order stays open so the shopper can retry until the payment time runs out.",
    auth: 'public',
    body: ReportRazorpayFailureDto,
    response: PublicOrderDto,
    message: 'Payment failure recorded',
    errors: [400, 404, 409, 429, 503],
  })
  failed(
    @Param('slug') slug: string,
    @Param('orderNumber', ParseIntPipe) orderNumber: number,
    @Body() dto: ReportRazorpayFailureDto,
    @Headers('x-order-token') token?: string,
  ) {
    return this.razorpay.reportFailure(
      slug.toLowerCase(),
      orderNumber,
      token,
      dto,
    );
  }
}
