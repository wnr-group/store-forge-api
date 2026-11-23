import {
  Body,
  Controller,
  Get,
  Headers,
  HttpCode,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
} from '@nestjs/common';
import { ApiHeader, ApiParam, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { ApiEndpoint } from '../../common/decorators/api-endpoint.decorator.js';
import {
  CurrentOrg,
  OrgScoped,
  RequireExplicitOrganization,
  RequirePermission,
} from '../../common/decorators/decorators.js';
import type { OrgContext } from '../../common/interfaces/request-context.js';
import {
  CreateRefundDto,
  RefundDto,
  RefundListQueryDto,
} from './refunds.dto.js';
import { RefundsService } from './refunds.service.js';
import {
  TransactionDetailDto,
  TransactionDto,
  TransactionListQueryDto,
} from './transactions.dto.js';
import { TransactionsService } from './transactions.service.js';

const SENSITIVE = { default: { limit: 10, ttl: 60_000 } };
const ORG_HEADER_NOTE =
  'This route REQUIRES the `X-Organization-Id` header (a missing or blank header is a 400 `ORGANIZATION_REQUIRED`).';

/** The Owner's money records: what was paid, and what was given back. */
@ApiTags('payments')
@Controller('payments')
@OrgScoped()
@RequirePermission('payments:manage')
@RequireExplicitOrganization()
export class PaymentsLedgerController {
  constructor(
    private readonly transactions: TransactionsService,
    private readonly refunds: RefundsService,
  ) {}

  @Get('transactions')
  @ApiEndpoint({
    summary: 'Payment transaction history',
    description: `Every payment, online and cash on delivery, newest first, a page at a time. Search by order number, internal transaction id or Razorpay order/payment id; filter by status, provider, payment method, refund state and date range. Each row shows the amount, method, status, how much has been refunded and whether the money needs refunding. ${ORG_HEADER_NOTE}`,
    auth: 'org',
    permission: 'payments:manage (Owner only)',
    response: [TransactionDto],
    paginated: true,
    message: 'Transactions retrieved successfully',
  })
  list(@CurrentOrg() org: OrgContext, @Query() query: TransactionListQueryDto) {
    return this.transactions.list(org, query);
  }

  @Get('transactions/:id')
  @ApiParam({ name: 'id', format: 'uuid' })
  @ApiEndpoint({
    summary: 'View one payment transaction',
    description: `One payment in full: the Razorpay ids, amount, method and status, the failure reason of a failed attempt, every refund made against it, and the timeline of what Razorpay reported. ${ORG_HEADER_NOTE}`,
    auth: 'org',
    permission: 'payments:manage (Owner only)',
    response: TransactionDetailDto,
    message: 'Transaction retrieved successfully',
    errors: [404],
  })
  get(@CurrentOrg() org: OrgContext, @Param('id', ParseUUIDPipe) id: string) {
    return this.transactions.get(org, id);
  }

  @Post('transactions/:id/refunds')
  @HttpCode(201)
  @Throttle(SENSITIVE)
  @ApiParam({ name: 'id', format: 'uuid' })
  @ApiHeader({
    name: 'Idempotency-Key',
    required: true,
    description:
      'A unique key per refund attempt (8-128 letters, numbers, - or _). Repeating the request with the same key returns the same refund instead of refunding twice.',
  })
  @ApiEndpoint({
    summary: 'Refund a payment, in full or in part',
    description: `Refunds an online payment through Razorpay. Leave \`amountMinor\` out for a full refund of what is left, or give an amount for a partial one. The total refunded can never exceed what was received (409 \`REFUND_EXCEEDS_PAYMENT\`). The refund is saved first and then sent to Razorpay with a reference of its own, so an unclear failure can never lead to a second refund; if Razorpay cannot be reached you get 503 and the refund stays saved, to be retried or synced. Cash on delivery payments cannot be refunded here. ${ORG_HEADER_NOTE}`,
    auth: 'org',
    permission: 'payments:manage (Owner only)',
    body: CreateRefundDto,
    response: RefundDto,
    status: 201,
    message: 'Refund requested successfully',
    errors: [404, 409, 429, 503],
  })
  refund(
    @CurrentOrg() org: OrgContext,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: CreateRefundDto,
    @Headers('idempotency-key') key?: string,
  ) {
    return this.refunds.create(org, id, dto, key);
  }

  @Get('refunds')
  @ApiEndpoint({
    summary: 'Refund history',
    description: `Every refund, newest first, with its status (pending, processing, processed or failed), amount, reason and the order it belongs to. Includes refunds made directly in the Razorpay dashboard once Razorpay reports them. ${ORG_HEADER_NOTE}`,
    auth: 'org',
    permission: 'payments:manage (Owner only)',
    response: [RefundDto],
    paginated: true,
    message: 'Refunds retrieved successfully',
  })
  listRefunds(
    @CurrentOrg() org: OrgContext,
    @Query() query: RefundListQueryDto,
  ) {
    return this.refunds.list(org, query);
  }

  @Post('refunds/:id/sync')
  @HttpCode(200)
  @Throttle(SENSITIVE)
  @ApiParam({ name: 'id', format: 'uuid' })
  @ApiEndpoint({
    summary: 'Check a refund with Razorpay',
    description: `Asks Razorpay where a refund stands and updates it, or finishes sending a refund whose outcome was unclear. Safe to repeat. ${ORG_HEADER_NOTE}`,
    auth: 'org',
    permission: 'payments:manage (Owner only)',
    response: RefundDto,
    message: 'Refund checked',
    errors: [404, 429, 503],
  })
  sync(@CurrentOrg() org: OrgContext, @Param('id', ParseUUIDPipe) id: string) {
    return this.refunds.sync(org, id);
  }
}
