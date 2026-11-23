import { Body, Controller, Get, Put, Query } from '@nestjs/common';
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
import {
  SaveTaxSettingsDto,
  TaxReportDto,
  TaxReportQueryDto,
  TaxSettingsDto,
} from './tax.dto.js';
import { TaxService } from './tax.service.js';

const ORG_HEADER_NOTE =
  'This route REQUIRES the `X-Organization-Id` header (a missing or blank header is a 400 `ORGANIZATION_REQUIRED`).';

@ApiTags('tax')
@Controller('tax')
@OrgScoped()
@RequireExplicitOrganization()
export class TaxController {
  constructor(private readonly tax: TaxService) {}

  @Get('settings')
  @RequirePermission('tax:view')
  @ApiEndpoint({
    summary: 'View GST settings',
    description: `Your GSTIN, whether prices include GST, and the default rates. \`configured: false\` until saved; until GST is turned on no tax is charged. ${ORG_HEADER_NOTE}`,
    auth: 'org',
    permission: 'tax:view',
    response: TaxSettingsDto,
    message: 'Tax settings retrieved successfully',
  })
  settings(@CurrentOrg() org: OrgContext) {
    return this.tax.settings(org);
  }

  @Put('settings')
  @Throttle({ default: { limit: 30, ttl: 60_000 } })
  @RequirePermission('tax:manage')
  @ApiEndpoint({
    summary: 'Save GST settings',
    description: `Turns GST on or off and sets the rates. The GSTIN is checked (shape and check character); its first two digits are your state, which decides CGST+SGST (delivery in your state) or IGST (anywhere else). Applies to orders placed from now on: orders already placed keep the tax they were charged. ${ORG_HEADER_NOTE}`,
    auth: 'org',
    permission: 'tax:manage',
    body: SaveTaxSettingsDto,
    response: TaxSettingsDto,
    message: 'Tax settings saved successfully',
    errors: [429],
  })
  save(@CurrentOrg() org: OrgContext, @Body() dto: SaveTaxSettingsDto) {
    return this.tax.save(org, dto);
  }

  @Get('report')
  @RequirePermission('tax:report')
  @ApiEndpoint({
    summary: 'GST collected in a period',
    description: `The GST charged on orders placed in a period (not cancelled, failed or unpaid), by rate, split into CGST, SGST and IGST, as each order recorded it. Days are India dates; at most 366 days. ${ORG_HEADER_NOTE}`,
    auth: 'org',
    permission: 'tax:report',
    response: TaxReportDto,
    message: 'Tax report retrieved successfully',
    errors: [400],
  })
  report(@CurrentOrg() org: OrgContext, @Query() query: TaxReportQueryDto) {
    return this.tax.report(org, query);
  }
}
