import {
  Body,
  Controller,
  Get,
  HttpCode,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
  Res,
  StreamableFile,
} from '@nestjs/common';
import { ApiParam, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import type { Response } from 'express';
import { ApiEndpoint } from '../../common/decorators/api-endpoint.decorator.js';
import {
  CurrentOrg,
  OrgScoped,
  RequirePermission,
} from '../../common/decorators/decorators.js';
import type { OrgContext } from '../../common/interfaces/request-context.js';
import {
  BillingPaymentDto,
  InvoiceDetailDto,
  InvoiceDto,
  InvoiceListQueryDto,
  PaymentIntentDto,
  PaymentListQueryDto,
  PaymentVerifiedDto,
  TenantBillingDto,
  VerifyPaymentDto,
} from './billing.dto.js';
import { BillingPaymentsService } from './billing-payments.service.js';
import { BillingService } from './billing.service.js';

const INVOICE = { name: 'id', format: 'uuid', description: 'Invoice id' };
const PAY_LIMIT = { default: { limit: 20, ttl: 60_000 } };
const OWNER_NOTE =
  'Only the Owner of the organization can use this: it is where the organization pays StoreForge for its plan.';

@ApiTags('billing')
@Controller('billing')
@OrgScoped()
@RequirePermission('billing:manage')
export class TenantBillingController {
  constructor(
    private readonly billing: BillingService,
    private readonly payments: BillingPaymentsService,
  ) {}

  @Get('overview')
  @ApiEndpoint({
    summary: 'My plan and what I owe',
    description: `Your plan, billing interval, renewal date, open and overdue invoices, and your latest invoices and payments. ${OWNER_NOTE}`,
    auth: 'org',
    permission: 'billing:manage (Owner only)',
    response: TenantBillingDto,
    message: 'Billing retrieved successfully',
  })
  overview(@CurrentOrg() org: OrgContext) {
    return this.billing.tenantBilling(org.userId, org.tenantId);
  }

  @Get('invoices')
  @ApiEndpoint({
    summary: 'My invoices',
    description: `Your organization's invoices, newest first. ${OWNER_NOTE}`,
    auth: 'org',
    permission: 'billing:manage (Owner only)',
    response: [InvoiceDto],
    paginated: true,
    message: 'Invoices retrieved successfully',
  })
  invoices(@CurrentOrg() org: OrgContext, @Query() q: InvoiceListQueryDto) {
    return this.billing.listInvoices(org.userId, q, org.tenantId);
  }

  @Get('invoices/:id')
  @ApiParam(INVOICE)
  @ApiEndpoint({
    summary: 'View one of my invoices',
    description: `An invoice with its payments. ${OWNER_NOTE}`,
    auth: 'org',
    permission: 'billing:manage (Owner only)',
    response: InvoiceDetailDto,
    message: 'Invoice retrieved successfully',
    errors: [404],
  })
  invoice(
    @CurrentOrg() org: OrgContext,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return this.billing.getInvoice(org.userId, id, org.tenantId);
  }

  @Get('invoices/:id/download')
  @ApiParam(INVOICE)
  @ApiEndpoint({
    summary: 'Download one of my invoices as a PDF',
    description: `The invoice as a PDF. ${OWNER_NOTE}`,
    auth: 'org',
    permission: 'billing:manage (Owner only)',
    response: null,
    message: 'Invoice downloaded',
    errors: [404],
  })
  async download(
    @CurrentOrg() org: OrgContext,
    @Param('id', ParseUUIDPipe) id: string,
    @Res({ passthrough: true }) res: Response,
  ) {
    const { number, pdf } = await this.billing.invoicePdf(
      org.userId,
      id,
      org.tenantId,
    );
    res.set({
      'Content-Type': 'application/pdf',
      'Content-Disposition': `attachment; filename="${number}.pdf"`,
      'Cache-Control': 'private, no-store',
    });
    return new StreamableFile(pdf);
  }

  @Get('payments')
  @ApiEndpoint({
    summary: 'My payments',
    description: `Your payment attempts, newest first. ${OWNER_NOTE}`,
    auth: 'org',
    permission: 'billing:manage (Owner only)',
    response: [BillingPaymentDto],
    paginated: true,
    message: 'Payments retrieved successfully',
  })
  paymentsList(@CurrentOrg() org: OrgContext, @Query() q: PaymentListQueryDto) {
    return this.billing.listPayments(org.userId, q, org.tenantId);
  }

  @Post('invoices/:id/pay')
  @HttpCode(200)
  @Throttle(PAY_LIMIT)
  @ApiParam(INVOICE)
  @ApiEndpoint({
    summary: 'Start paying an invoice',
    description: `Prepares an online payment for an open invoice and returns what Razorpay Checkout needs: the order id and StoreForge's PUBLIC key id. Asking twice reuses the same order. The payment only counts after you confirm it with \`POST /billing/payments/verify\` (or Razorpay's own webhook). Answers 503 \`BILLING_PAYMENTS_UNAVAILABLE\` when online payment is not set up. ${OWNER_NOTE}`,
    auth: 'org',
    permission: 'billing:manage (Owner only)',
    response: PaymentIntentDto,
    message: 'Payment started successfully',
    errors: [404, 409, 429, 503],
  })
  pay(@CurrentOrg() org: OrgContext, @Param('id', ParseUUIDPipe) id: string) {
    return this.payments.startPayment(org, id);
  }

  @Post('payments/verify')
  @HttpCode(200)
  @Throttle(PAY_LIMIT)
  @ApiEndpoint({
    summary: 'Confirm a payment',
    description: `Send what Razorpay Checkout returned. The server checks the signature and then asks Razorpay itself whether the payment really succeeded for this order and amount; what the browser says is never trusted on its own. A paid invoice settles and your subscription is extended. Confirming the same payment again changes nothing. ${OWNER_NOTE}`,
    auth: 'org',
    permission: 'billing:manage (Owner only)',
    body: VerifyPaymentDto,
    response: PaymentVerifiedDto,
    message: 'Payment confirmed successfully',
    errors: [404, 409, 429, 503],
  })
  verify(@CurrentOrg() org: OrgContext, @Body() dto: VerifyPaymentDto) {
    return this.payments.verifyPayment(org, dto);
  }
}
