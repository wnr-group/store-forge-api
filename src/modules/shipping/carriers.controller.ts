import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  Post,
  Put,
  Query,
} from '@nestjs/common';
import { ApiParam, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { ApiEndpoint } from '../../common/decorators/api-endpoint.decorator.js';
import {
  CurrentOrg,
  OrgScoped,
  RequireExplicitOrganization,
  RequirePermission,
  RequireFeature,
} from '../../common/decorators/decorators.js';
import type { OrgContext } from '../../common/interfaces/request-context.js';
import {
  CarrierCheckDto,
  CarrierDto,
  CarrierEventDto,
  CarrierEventsQueryDto,
  SaveCarrierDto,
  SavePreferencesDto,
  SetCarrierDefaultDto,
  SetCarrierEnabledDto,
  ShippingPreferencesDto,
} from './carriers.dto.js';
import { CarriersService } from './carriers.service.js';

const SENSITIVE = { default: { limit: 10, ttl: 60_000 } };
const CODE = {
  name: 'code',
  example: 'shiprocket',
  description: 'The carrier code from the carrier list.',
};
const ORG_HEADER_NOTE =
  'This route REQUIRES the `X-Organization-Id` header (a missing or blank header is a 400 `ORGANIZATION_REQUIRED`).';

@ApiTags('shipping')
@Controller('shipping')
@OrgScoped()
@RequirePermission('carriers:manage')
@RequireExplicitOrganization()
export class CarriersController {
  constructor(private readonly carriers: CarriersService) {}

  @Get('carriers')
  @ApiEndpoint({
    summary: 'List shipping carriers and their connection status',
    description: `Every carrier the platform supports, what each can do (price quotes, labels, tracking, ...), how far its integration has been checked (\`integrationStatus\`), the settings it needs, and this organization's connection to it: connected, turned on, default, last check result and the settings saved. Secret values are never returned, only which ones are saved. ${ORG_HEADER_NOTE}`,
    auth: 'org',
    permission: 'carriers:manage (Owner only)',
    response: [CarrierDto],
    message: 'Carriers retrieved successfully',
  })
  list(@CurrentOrg() org: OrgContext) {
    return this.carriers.list(org);
  }

  @Put('carriers/:code')
  @RequireFeature('shipping_integrations')
  @Throttle(SENSITIVE)
  @ApiParam(CODE)
  @ApiEndpoint({
    summary: 'Connect a carrier or update its settings',
    description: `Saves this organization's own account details for a carrier. Secrets are encrypted before they are stored and are never shown again: leave a secret out to keep it, send a new value to replace it. Changing anything turns the carrier off until it passes a connection check again. Problems are listed per field (400 \`CARRIER_SETTINGS_INVALID\`). Nothing is sent to the carrier. ${ORG_HEADER_NOTE}`,
    auth: 'org',
    permission: 'carriers:manage (Owner only)',
    body: SaveCarrierDto,
    response: CarrierDto,
    message: 'Carrier settings saved successfully',
    errors: [404, 429, 503],
  })
  save(
    @CurrentOrg() org: OrgContext,
    @Param('code') code: string,
    @Body() dto: SaveCarrierDto,
  ) {
    return this.carriers.save(org, code, dto.values);
  }

  @Post('carriers/:code/test')
  @RequireFeature('shipping_integrations')
  @HttpCode(200)
  @Throttle(SENSITIVE)
  @ApiParam(CODE)
  @ApiEndpoint({
    summary: 'Try carrier settings without saving them',
    description: `Sends the settings to the carrier to see whether it accepts them, so you can check before committing. Settings you leave out are taken from what is saved. Nothing is stored. If the carrier cannot be reached you get 503 \`CARRIER_UNAVAILABLE\`. ${ORG_HEADER_NOTE}`,
    auth: 'org',
    permission: 'carriers:manage (Owner only)',
    body: SaveCarrierDto,
    response: CarrierCheckDto,
    message: 'Carrier settings checked',
    errors: [400, 404, 429, 503],
  })
  test(
    @CurrentOrg() org: OrgContext,
    @Param('code') code: string,
    @Body() dto: SaveCarrierDto,
  ) {
    return this.carriers.test(org, code, dto.values);
  }

  @Post('carriers/:code/verify')
  @RequireFeature('shipping_integrations')
  @HttpCode(200)
  @Throttle(SENSITIVE)
  @ApiParam(CODE)
  @ApiEndpoint({
    summary: 'Check the saved connection to a carrier',
    description: `Checks the saved settings with the carrier and records the result. A failed check also turns the carrier off. If the carrier cannot be reached the saved state is left unchanged (503 \`CARRIER_UNAVAILABLE\`). ${ORG_HEADER_NOTE}`,
    auth: 'org',
    permission: 'carriers:manage (Owner only)',
    response: CarrierDto,
    message: 'Carrier connection checked',
    errors: [404, 429, 503],
  })
  verify(@CurrentOrg() org: OrgContext, @Param('code') code: string) {
    return this.carriers.verify(org, code);
  }

  @Put('carriers/:code/enabled')
  @RequireFeature('shipping_integrations')
  @Throttle(SENSITIVE)
  @ApiParam(CODE)
  @ApiEndpoint({
    summary: 'Turn a carrier on or off',
    description: `Controls whether new shipments can use this carrier. Turning it on needs a successful connection check (409 \`CARRIER_NOT_VERIFIED\`). A carrier whose integration is marked \`unverified\` also needs \`acknowledgeUnverifiedIntegration: true\` (409 \`INTEGRATION_UNVERIFIED\` otherwise). Turning a carrier off also removes it as the default. ${ORG_HEADER_NOTE}`,
    auth: 'org',
    permission: 'carriers:manage (Owner only)',
    body: SetCarrierEnabledDto,
    response: CarrierDto,
    message: 'Carrier updated successfully',
    errors: [404, 409, 429],
  })
  setEnabled(
    @CurrentOrg() org: OrgContext,
    @Param('code') code: string,
    @Body() dto: SetCarrierEnabledDto,
  ) {
    return this.carriers.setEnabled(org, code, dto);
  }

  @Put('carriers/:code/default')
  @RequireFeature('shipping_integrations')
  @Throttle(SENSITIVE)
  @ApiParam(CODE)
  @ApiEndpoint({
    summary: 'Make a carrier the default',
    description: `Marks one carrier as the default, which replaces the previous default. The carrier must be turned on (409 \`CARRIER_NOT_ENABLED\`). The default is used first by the "preferred carrier" strategy. ${ORG_HEADER_NOTE}`,
    auth: 'org',
    permission: 'carriers:manage (Owner only)',
    body: SetCarrierDefaultDto,
    response: CarrierDto,
    message: 'Default carrier updated successfully',
    errors: [404, 409, 429],
  })
  setDefault(
    @CurrentOrg() org: OrgContext,
    @Param('code') code: string,
    @Body() dto: SetCarrierDefaultDto,
  ) {
    return this.carriers.setDefault(org, code, dto);
  }

  @Delete('carriers/:code')
  @Throttle(SENSITIVE)
  @ApiParam(CODE)
  @ApiEndpoint({
    summary: 'Disconnect a carrier',
    description: `Permanently deletes this organization's saved settings and credentials for the carrier. Shipments already booked are not affected. ${ORG_HEADER_NOTE}`,
    auth: 'org',
    permission: 'carriers:manage (Owner only)',
    response: null,
    message: 'Carrier disconnected successfully',
    errors: [404, 429],
  })
  async disconnect(@CurrentOrg() org: OrgContext, @Param('code') code: string) {
    await this.carriers.disconnect(org, code);
  }

  @Get('carrier-events')
  @ApiEndpoint({
    summary: 'Carrier change history',
    description: `Who connected, changed, checked, turned on or off, set as default or disconnected a carrier, and when, newest first. It names the settings that changed, never their values. ${ORG_HEADER_NOTE}`,
    auth: 'org',
    permission: 'carriers:manage (Owner only)',
    response: [CarrierEventDto],
    paginated: true,
    message: 'Carrier history retrieved successfully',
  })
  events(@CurrentOrg() org: OrgContext, @Query() query: CarrierEventsQueryDto) {
    return this.carriers.events(org, query);
  }

  @Get('preferences')
  @ApiEndpoint({
    summary: 'See how carriers are chosen',
    description: `Whether the carrier is picked by hand for each shipment or automatically, the strategy used (lowest cost, fastest, or your default carrier first), how many carriers are turned on and which one is the default. ${ORG_HEADER_NOTE}`,
    auth: 'org',
    permission: 'carriers:manage (Owner only)',
    response: ShippingPreferencesDto,
    message: 'Shipping preferences retrieved successfully',
  })
  preferences(@CurrentOrg() org: OrgContext) {
    return this.carriers.preferences(org);
  }

  @Put('preferences')
  @Throttle(SENSITIVE)
  @ApiEndpoint({
    summary: 'Choose how carriers are selected',
    description: `Sets manual or automatic carrier selection and the strategy automatic selection follows. Applies to new shipments only. ${ORG_HEADER_NOTE}`,
    auth: 'org',
    permission: 'carriers:manage (Owner only)',
    body: SavePreferencesDto,
    response: ShippingPreferencesDto,
    message: 'Shipping preferences saved successfully',
    errors: [429],
  })
  savePreferences(
    @CurrentOrg() org: OrgContext,
    @Body() dto: SavePreferencesDto,
  ) {
    return this.carriers.savePreferences(org, dto);
  }
}
