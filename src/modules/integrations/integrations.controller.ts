import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  Post,
  Put,
} from '@nestjs/common';
import { ApiParam, ApiTags } from '@nestjs/swagger';
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
  IntegrationDetailDto,
  IntegrationDto,
  IntegrationTestResultDto,
  SaveIntegrationDto,
} from './integrations.dto.js';
import { IntegrationsService } from './integrations.service.js';

const WRITE_LIMIT = { default: { limit: 30, ttl: 60_000 } };
/** The test reaches an outside service. */
const TEST_LIMIT = { default: { limit: 10, ttl: 60_000 } };
const ORG_NOTE =
  'This route REQUIRES the `X-Organization-Id` header (a missing or blank header is a 400 `ORGANIZATION_REQUIRED`).';

@ApiTags('integrations')
@Controller('integrations')
@OrgScoped()
@RequireExplicitOrganization()
export class IntegrationsController {
  constructor(private readonly integrations: IntegrationsService) {}

  @Get()
  @RequirePermission('integrations:view')
  @ApiEndpoint({
    summary: 'List integrations',
    description: `Every integration the platform supports (Google Analytics 4 today) with whether it is configured, validated and switched on, the public identifiers saved, and when it last changed. Private credentials are never part of any response. ${ORG_NOTE}`,
    auth: 'org',
    permission: 'integrations:view',
    response: [IntegrationDto],
    message: 'Integrations retrieved successfully',
  })
  list(@CurrentOrg() org: OrgContext) {
    return this.integrations.list(org);
  }

  @Get(':provider')
  @RequirePermission('integrations:view')
  @ApiParam({ name: 'provider', example: 'ga4' })
  @ApiEndpoint({
    summary: 'View one integration',
    description: `One integration with its form fields and the 20 latest changes (who did what and when, never a value). 404 \`INTEGRATION_NOT_FOUND\` for a provider the platform does not support. ${ORG_NOTE}`,
    auth: 'org',
    permission: 'integrations:view',
    response: IntegrationDetailDto,
    message: 'Integration retrieved successfully',
    errors: [404],
  })
  get(@CurrentOrg() org: OrgContext, @Param('provider') provider: string) {
    return this.integrations.get(org, provider);
  }

  @Put(':provider')
  @Throttle(WRITE_LIMIT)
  @RequirePermission('integrations:manage')
  @ApiParam({ name: 'provider', example: 'ga4' })
  @ApiEndpoint({
    summary: 'Save and validate an integration',
    description: `Saves the settings (for Google Analytics 4 the \`measurementId\`, G- and 10 letters or digits) after checking them with the provider's own rules; a bad value is a 400 \`INTEGRATION_CONFIG_INVALID\` with the field named. A new or changed configuration is saved switched off: enable it next. The change is recorded in the audit history. ${ORG_NOTE}`,
    auth: 'org',
    permission: 'integrations:manage',
    body: SaveIntegrationDto,
    response: IntegrationDetailDto,
    message: 'Integration saved successfully',
    errors: [404, 429],
  })
  save(
    @CurrentOrg() org: OrgContext,
    @Param('provider') provider: string,
    @Body() dto: SaveIntegrationDto,
  ) {
    return this.integrations.save(org, provider, dto.config);
  }

  @Post(':provider/enable')
  @HttpCode(200)
  @Throttle(WRITE_LIMIT)
  @RequirePermission('integrations:manage')
  @ApiParam({ name: 'provider', example: 'ga4' })
  @ApiEndpoint({
    summary: 'Switch an integration on',
    description: `Storefronts of this store start loading it, for shoppers who agree to analytics. Only a validated configuration can be switched on (409 \`INTEGRATION_NOT_VALID\`). ${ORG_NOTE}`,
    auth: 'org',
    permission: 'integrations:manage',
    response: IntegrationDetailDto,
    message: 'Integration enabled successfully',
    errors: [404, 409, 429],
  })
  enable(@CurrentOrg() org: OrgContext, @Param('provider') provider: string) {
    return this.integrations.setEnabled(org, provider, true);
  }

  @Post(':provider/disable')
  @HttpCode(200)
  @Throttle(WRITE_LIMIT)
  @RequirePermission('integrations:manage')
  @ApiParam({ name: 'provider', example: 'ga4' })
  @ApiEndpoint({
    summary: 'Switch an integration off',
    description: `Storefronts stop loading it right away (pages already open keep what they loaded until they are reloaded). The settings stay saved. ${ORG_NOTE}`,
    auth: 'org',
    permission: 'integrations:manage',
    response: IntegrationDetailDto,
    message: 'Integration disabled successfully',
    errors: [404, 429],
  })
  disable(@CurrentOrg() org: OrgContext, @Param('provider') provider: string) {
    return this.integrations.setEnabled(org, provider, false);
  }

  @Post(':provider/test')
  @HttpCode(200)
  @Throttle(TEST_LIMIT)
  @RequirePermission('integrations:manage')
  @ApiParam({ name: 'provider', example: 'ga4' })
  @ApiEndpoint({
    summary: 'Test an integration',
    description: `Checks the saved settings against the outside world and lists each check with its result. A failed test is reported and recorded, but never switches a working integration off. ${ORG_NOTE}`,
    auth: 'org',
    permission: 'integrations:manage',
    response: IntegrationTestResultDto,
    message: 'Integration tested successfully',
    errors: [404, 429],
  })
  test(@CurrentOrg() org: OrgContext, @Param('provider') provider: string) {
    return this.integrations.test(org, provider);
  }

  @Delete(':provider')
  @HttpCode(200)
  @Throttle(WRITE_LIMIT)
  @RequirePermission('integrations:manage')
  @ApiParam({ name: 'provider', example: 'ga4' })
  @ApiEndpoint({
    summary: 'Remove an integration',
    description: `Deletes the saved settings; storefronts stop loading it. The history of changes is kept. ${ORG_NOTE}`,
    auth: 'org',
    permission: 'integrations:manage',
    response: null,
    message: 'Integration removed successfully',
    errors: [404, 429],
  })
  async remove(
    @CurrentOrg() org: OrgContext,
    @Param('provider') provider: string,
  ) {
    await this.integrations.remove(org, provider);
  }
}
