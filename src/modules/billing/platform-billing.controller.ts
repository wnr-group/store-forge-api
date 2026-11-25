import {
  Body,
  Controller,
  Get,
  Param,
  ParseUUIDPipe,
  Post,
  Put,
  Query,
  Res,
  StreamableFile,
} from '@nestjs/common';
import { ApiParam, ApiTags } from '@nestjs/swagger';
import type { Response } from 'express';
import { ApiEndpoint } from '../../common/decorators/api-endpoint.decorator.js';
import {
  CurrentUser,
  PlatformAccess,
} from '../../common/decorators/decorators.js';
import type { AuthUser } from '../../common/interfaces/request-context.js';
import {
  BillingPaymentDto,
  BillingRunDto,
  BillingSettingsDto,
  BillingSummaryDto,
  InvoiceDetailDto,
  InvoiceDto,
  InvoiceListQueryDto,
  IssueInvoiceDto,
  ManualPaymentDto,
  PaymentDetailDto,
  PaymentListQueryDto,
  RefundPaymentDto,
  SummaryQueryDto,
  TenantBillingDto,
  UpdateBillingSettingsDto,
  VoidInvoiceDto,
} from './billing.dto.js';
import { BillingService } from './billing.service.js';

const INVOICE = { name: 'id', format: 'uuid', description: 'Invoice id' };
const PAYMENT = { name: 'id', format: 'uuid', description: 'Payment id' };
const ORG = { name: 'id', format: 'uuid', description: 'Organization id' };
const READ = { permission: 'billing:read' } as const;
const WRITE = {
  permission: 'billing:manage',
  bucket: 'billing.manage',
} as const;

@ApiTags('platform-billing')
@Controller('platform')
@PlatformAccess(READ)
export class PlatformBillingController {
  constructor(private readonly billing: BillingService) {}

  @Get('billing/summary')
  @ApiEndpoint({
    summary: 'Billing summary',
    description:
      'Monthly recurring revenue (from paid, active subscriptions; yearly plans count as a twelfth), payments collected, failed and pending in the date range, refunds, and overdue invoices. Every number is read from the billing records, never estimated. The range defaults to the last 30 days.',
    auth: 'platform',
    permission: 'billing:read',
    response: BillingSummaryDto,
    message: 'Billing summary retrieved successfully',
  })
  summary(@CurrentUser() admin: AuthUser, @Query() q: SummaryQueryDto) {
    return this.billing.summary(admin.id, q);
  }

  @Get('billing/settings')
  @ApiEndpoint({
    summary: 'View billing settings',
    description:
      'The seller details printed on invoices, the tax rate, due and grace days, and whether StoreForge Razorpay keys are configured on the server (the keys are never returned).',
    auth: 'platform',
    permission: 'billing:read',
    response: BillingSettingsDto,
    message: 'Billing settings retrieved successfully',
  })
  settings(@CurrentUser() admin: AuthUser) {
    return this.billing.getSettings(admin.id);
  }

  @Put('billing/settings')
  @PlatformAccess(WRITE)
  @ApiEndpoint({
    summary: 'Update billing settings',
    description:
      'Change what appears on invoices and how renewals behave. Only what changed is written and logged. Invoices already issued keep the details they were issued with.',
    auth: 'platform',
    permission: 'billing:manage',
    body: UpdateBillingSettingsDto,
    response: BillingSettingsDto,
    message: 'Billing settings updated successfully',
  })
  updateSettings(
    @CurrentUser() admin: AuthUser,
    @Body() dto: UpdateBillingSettingsDto,
  ) {
    return this.billing.updateSettings(admin.id, dto);
  }

  @Get('billing/invoices')
  @ApiEndpoint({
    summary: 'List invoices',
    description:
      'All invoices, newest first, a page at a time. Filter by status (`overdue` = open and past due), organization and issue date, and search by invoice number or organization name.',
    auth: 'platform',
    permission: 'billing:read',
    response: [InvoiceDto],
    paginated: true,
    message: 'Invoices retrieved successfully',
  })
  invoices(@CurrentUser() admin: AuthUser, @Query() q: InvoiceListQueryDto) {
    return this.billing.listInvoices(admin.id, q);
  }

  @Get('billing/invoices/:id')
  @ApiParam(INVOICE)
  @ApiEndpoint({
    summary: 'View an invoice',
    description:
      'One invoice with its payments (including failed attempts) and refunds.',
    auth: 'platform',
    permission: 'billing:read',
    response: InvoiceDetailDto,
    message: 'Invoice retrieved successfully',
    errors: [404],
  })
  invoice(
    @CurrentUser() admin: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return this.billing.getInvoice(admin.id, id);
  }

  @Get('billing/invoices/:id/download')
  @ApiParam(INVOICE)
  @ApiEndpoint({
    summary: 'Download an invoice as a PDF',
    description:
      'The invoice as a PDF, built from the stored invoice and the verified payment that settled it. Amounts and seller details are exactly what was billed.',
    auth: 'platform',
    permission: 'billing:read',
    response: null,
    message: 'Invoice downloaded',
    errors: [404],
  })
  async download(
    @CurrentUser() admin: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Res({ passthrough: true }) res: Response,
  ) {
    const { number, pdf } = await this.billing.invoicePdf(admin.id, id);
    res.set({
      'Content-Type': 'application/pdf',
      'Content-Disposition': `attachment; filename="${number}.pdf"`,
      'Cache-Control': 'private, no-store',
    });
    return new StreamableFile(pdf);
  }

  @Post('billing/invoices/:id/void')
  @PlatformAccess(WRITE)
  @ApiParam(INVOICE)
  @ApiEndpoint({
    summary: 'Void an unpaid invoice',
    description:
      'Cancels an open invoice (for a billing mistake). A paid invoice cannot be voided: refund the payment instead. A payment that still arrives for a voided invoice is kept and flagged for refund.',
    auth: 'platform',
    permission: 'billing:manage',
    body: VoidInvoiceDto,
    response: InvoiceDetailDto,
    message: 'Invoice voided successfully',
    errors: [404, 409],
  })
  voidInvoice(
    @CurrentUser() admin: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: VoidInvoiceDto,
  ) {
    return this.billing.voidInvoice(admin.id, id, dto.reason);
  }

  @Post('billing/invoices/:id/payments')
  @PlatformAccess(WRITE)
  @ApiParam(INVOICE)
  @ApiEndpoint({
    summary: 'Record an offline payment',
    description:
      'Mark an open invoice paid because the money arrived outside Razorpay (bank transfer, cheque). The full invoice amount is recorded with your reference, the invoice is settled and the subscription is extended, exactly as for an online payment.',
    auth: 'platform',
    permission: 'billing:manage',
    body: ManualPaymentDto,
    response: InvoiceDetailDto,
    status: 201,
    message: 'Payment recorded successfully',
    errors: [404, 409],
  })
  recordPayment(
    @CurrentUser() admin: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: ManualPaymentDto,
  ) {
    return this.billing.recordManualPayment(admin.id, id, dto);
  }

  @Post('organizations/:id/billing/invoices')
  @PlatformAccess(WRITE)
  @ApiParam(ORG)
  @ApiEndpoint({
    summary: 'Issue an invoice for an organization',
    description:
      'Bill a subscription period now. `current` bills the period the organization is in (for a paid plan that was just assigned), `next` the one after it. The amount comes from the plan and billing interval the organization is on, plus the configured tax. A period is invoiced once (409 `INVOICE_EXISTS`); a free plan has nothing to bill (400 `NOTHING_TO_BILL`).',
    auth: 'platform',
    permission: 'billing:manage',
    body: IssueInvoiceDto,
    response: InvoiceDetailDto,
    status: 201,
    message: 'Invoice issued successfully',
    errors: [404, 409],
  })
  issue(
    @CurrentUser() admin: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: IssueInvoiceDto,
  ) {
    return this.billing.issueInvoice(admin.id, id, dto.period);
  }

  @Get('organizations/:id/billing')
  @ApiParam(ORG)
  @ApiEndpoint({
    summary: "View an organization's billing",
    description:
      'Plan, billing interval, renewal date, open and overdue invoices and the latest invoices and payments of one organization.',
    auth: 'platform',
    permission: 'billing:read',
    response: TenantBillingDto,
    message: 'Billing retrieved successfully',
  })
  tenantBilling(
    @CurrentUser() admin: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return this.billing.tenantBilling(admin.id, id);
  }

  @Get('billing/payments')
  @ApiEndpoint({
    summary: 'List payments',
    description:
      'Every payment attempt, newest first: successful, failed, pending and refunded, with the Razorpay references. Filter by status, organization, date or `refundRequired=true` (money received for an invoice that was already paid or void), and search by invoice number, organization, Razorpay id or offline reference.',
    auth: 'platform',
    permission: 'billing:read',
    response: [BillingPaymentDto],
    paginated: true,
    message: 'Payments retrieved successfully',
  })
  payments(@CurrentUser() admin: AuthUser, @Query() q: PaymentListQueryDto) {
    return this.billing.listPayments(admin.id, q);
  }

  @Get('billing/payments/:id')
  @ApiParam(PAYMENT)
  @ApiEndpoint({
    summary: 'View a payment',
    description: 'One payment with its refunds.',
    auth: 'platform',
    permission: 'billing:read',
    response: PaymentDetailDto,
    message: 'Payment retrieved successfully',
    errors: [404],
  })
  payment(
    @CurrentUser() admin: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return this.billing.getPayment(admin.id, id);
  }

  @Post('billing/payments/:id/refund')
  @PlatformAccess(WRITE)
  @ApiParam(PAYMENT)
  @ApiEndpoint({
    summary: 'Refund a payment',
    description:
      'Refund a successful payment, in full or in part, through Razorpay (or as a record, for an offline payment). `requestId` makes the request safe to repeat: the same id never refunds twice, even after a network failure. Razorpay completes some refunds later; the refund shows `pending` until the webhook or a repeat of the request confirms it.',
    auth: 'platform',
    permission: 'billing:manage',
    body: RefundPaymentDto,
    response: PaymentDetailDto,
    message: 'Refund recorded successfully',
    errors: [404, 409, 503],
  })
  refund(
    @CurrentUser() admin: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: RefundPaymentDto,
  ) {
    return this.billing.refundPayment(admin.id, id, dto);
  }

  @Post('billing/run')
  @PlatformAccess(WRITE)
  @ApiEndpoint({
    summary: 'Run billing now',
    description:
      'Does what the scheduler does: issues invoices for renewals that are coming up, marks subscriptions with an overdue invoice as past due, and expires those that stay unpaid past the grace period. Safe to run again at any time.',
    auth: 'platform',
    permission: 'billing:manage',
    response: BillingRunDto,
    message: 'Billing run completed successfully',
  })
  run(@CurrentUser() admin: AuthUser) {
    return this.billing.runBilling(admin.id);
  }
}
