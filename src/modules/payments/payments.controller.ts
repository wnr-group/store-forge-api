import { Body, Controller, Delete, Get, Put } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { ApiEndpoint } from '../../common/decorators/api-endpoint.decorator.js';
import {
  CurrentOrg,
  OrgScoped,
  RequireExplicitOrganization,
  RequirePermission,
} from '../../common/decorators/decorators.js';
import type { OrgContext } from '../../common/interfaces/request-context.js';
import { RazorpayStatusDto, SaveRazorpayConfigDto } from './payments.dto.js';
import { PaymentsService } from './payments.service.js';

/** Same limit as the team routes: 10 sensitive writes per minute per client. */
const SENSITIVE = { default: { limit: 10, ttl: 60_000 } };

const ORG_HEADER_NOTE =
  'Unlike most routes, this one REQUIRES the `X-Organization-Id` header (a missing or blank header is a 400 `ORGANIZATION_REQUIRED`): your first organization is never used as a fallback.';

@ApiTags('payments')
@Controller('payments/razorpay')
@OrgScoped()
@RequirePermission('payments:manage')
@RequireExplicitOrganization()
export class PaymentsController {
  constructor(private readonly payments: PaymentsService) {}

  @Get()
  @ApiEndpoint({
    summary: 'See the Razorpay settings',
    description: `Shows whether your Razorpay Key ID and Key Secret are saved, with the Key ID partly hidden, whether it is Test or Live, whether a webhook secret is saved, and who saved it and when. The Key Secret and webhook secret are never shown. "Saved" does not mean the keys were checked with Razorpay. ${ORG_HEADER_NOTE}`,
    auth: 'org',
    permission: 'payments:manage (Owner only)',
    response: RazorpayStatusDto,
    message: 'Razorpay settings retrieved successfully',
  })
  get(@CurrentOrg() org: OrgContext) {
    return this.payments.get(org);
  }

  @Put()
  @Throttle(SENSITIVE)
  @ApiEndpoint({
    summary: 'Save the Razorpay settings',
    description: `Saves or replaces your Razorpay Key ID and Key Secret together, and optionally your webhook secret (the one you set in Razorpay under Settings > Webhooks). Secrets are encrypted before they are stored and cannot be viewed again; to change the Key Secret, send a new pair. Leave webhookSecret out to keep a saved webhook secret. Nothing is sent to Razorpay. If payment settings are temporarily unavailable (503 PAYMENTS_UNAVAILABLE) nothing is saved and any existing settings stay as they were. ${ORG_HEADER_NOTE}`,
    auth: 'org',
    permission: 'payments:manage (Owner only)',
    body: SaveRazorpayConfigDto,
    response: RazorpayStatusDto,
    message: 'Razorpay settings saved successfully',
    errors: [429, 503],
  })
  save(@CurrentOrg() org: OrgContext, @Body() dto: SaveRazorpayConfigDto) {
    return this.payments.save(org, dto);
  }

  @Delete()
  @Throttle(SENSITIVE)
  @ApiEndpoint({
    summary: 'Remove the Razorpay settings',
    description: `Permanently deletes the saved Key ID and Key Secret. It works even when nothing is saved, and does not need the encryption key. ${ORG_HEADER_NOTE}`,
    auth: 'org',
    permission: 'payments:manage (Owner only)',
    response: RazorpayStatusDto,
    message: 'Razorpay settings removed successfully',
    errors: [429],
  })
  remove(@CurrentOrg() org: OrgContext) {
    return this.payments.remove(org);
  }
}
