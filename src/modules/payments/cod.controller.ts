import { Body, Controller, Get, Put } from '@nestjs/common';
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
import { CodSettingsDto, SaveCodSettingsDto } from './cod.dto.js';
import { CodService } from './cod.service.js';
import { PaymentsEventLogger } from './payments.logger.js';

const SENSITIVE = { default: { limit: 10, ttl: 60_000 } };
const ORG_HEADER_NOTE =
  'This route REQUIRES the `X-Organization-Id` header (a missing or blank header is a 400 `ORGANIZATION_REQUIRED`).';

@ApiTags('payments')
@Controller('payments/cod')
@OrgScoped()
@RequirePermission('payments:manage')
@RequireExplicitOrganization()
export class CodController {
  constructor(
    private readonly cod: CodService,
    private readonly events: PaymentsEventLogger,
  ) {}

  @Get()
  @ApiEndpoint({
    summary: 'See the cash on delivery settings',
    description: `Shows whether shoppers can pay on delivery, the minimum and maximum order value, and the extra COD charge. ${ORG_HEADER_NOTE}`,
    auth: 'org',
    permission: 'payments:manage (Owner only)',
    response: CodSettingsDto,
    message: 'Cash on delivery settings retrieved successfully',
  })
  get(@CurrentOrg() org: OrgContext) {
    return this.cod.get(org);
  }

  @Put()
  @Throttle(SENSITIVE)
  @ApiEndpoint({
    summary: 'Save the cash on delivery settings',
    description: `Turns cash on delivery on or off and sets the minimum and maximum order value (items subtotal, in paise) and the extra charge added to COD orders. Applies to new orders only. ${ORG_HEADER_NOTE}`,
    auth: 'org',
    permission: 'payments:manage (Owner only)',
    body: SaveCodSettingsDto,
    response: CodSettingsDto,
    message: 'Cash on delivery settings saved successfully',
    errors: [429],
  })
  async save(@CurrentOrg() org: OrgContext, @Body() dto: SaveCodSettingsDto) {
    const saved = await this.cod.save(org, dto);
    this.events.record({
      actorUserId: org.userId,
      tenantId: org.tenantId,
      action: 'cod_save',
    });
    return saved;
  }
}
