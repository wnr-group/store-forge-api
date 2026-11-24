import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
} from '@nestjs/common';
import { ApiParam, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { ApiEndpoint } from '../../common/decorators/api-endpoint.decorator.js';
import {
  CurrentOrg,
  OrgScoped,
  RequirePermission,
} from '../../common/decorators/decorators.js';
import type { OrgContext } from '../../common/interfaces/request-context.js';
import {
  CampaignDetailDto,
  CampaignDto,
  CampaignListQueryDto,
  CampaignStatusDto,
  CreateCampaignDto,
  UpdateCampaignDto,
} from './campaigns.dto.js';
import { CampaignsService } from './campaigns.service.js';

const WRITE_LIMIT = { default: { limit: 60, ttl: 60_000 } };

@ApiTags('marketing')
@Controller('marketing/campaigns')
@OrgScoped()
export class CampaignsController {
  constructor(private readonly campaigns: CampaignsService) {}

  @Get()
  @RequirePermission('marketing:view')
  @ApiEndpoint({
    summary: 'List promotional campaigns',
    description:
      'Your campaigns, a page at a time, with what each is doing now (`phase`) and its performance: the orders that used its discount codes, the total discounted and the resulting sales.',
    auth: 'org',
    permission: 'marketing:view',
    response: [CampaignDto],
    paginated: true,
    message: 'Campaigns retrieved successfully',
  })
  list(@CurrentOrg() org: OrgContext, @Query() q: CampaignListQueryDto) {
    return this.campaigns.list(org, q);
  }

  @Get(':id')
  @RequirePermission('marketing:view')
  @ApiParam({ name: 'id', format: 'uuid' })
  @ApiEndpoint({
    summary: 'View one campaign',
    description:
      'A campaign with its dates, the products and collections it covers and the discount codes that belong to it.',
    auth: 'org',
    permission: 'marketing:view',
    response: CampaignDetailDto,
    message: 'Campaign retrieved successfully',
    errors: [404],
  })
  get(@CurrentOrg() org: OrgContext, @Param('id', ParseUUIDPipe) id: string) {
    return this.campaigns.get(org, id);
  }

  @Post()
  @Throttle(WRITE_LIMIT)
  @RequirePermission('marketing:manage')
  @ApiEndpoint({
    summary: 'Create a campaign',
    description:
      'Creates a campaign as a draft. Its discount codes work only while the campaign is live (active, and between its start and end). Nothing is ever sent to customers from a campaign: email and SMS are future integrations.',
    auth: 'org',
    permission: 'marketing:manage',
    body: CreateCampaignDto,
    response: CampaignDetailDto,
    status: 201,
    message: 'Campaign created successfully',
    errors: [409, 429],
  })
  create(@CurrentOrg() org: OrgContext, @Body() dto: CreateCampaignDto) {
    return this.campaigns.create(org, dto);
  }

  @Patch(':id')
  @Throttle(WRITE_LIMIT)
  @RequirePermission('marketing:manage')
  @ApiParam({ name: 'id', format: 'uuid' })
  @ApiEndpoint({
    summary: 'Change a campaign',
    description:
      'Changes its name, description, dates, products, collections or discount codes. A completed campaign cannot be changed.',
    auth: 'org',
    permission: 'marketing:manage',
    body: UpdateCampaignDto,
    response: CampaignDetailDto,
    message: 'Campaign updated successfully',
    errors: [404, 409, 429],
  })
  update(
    @CurrentOrg() org: OrgContext,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateCampaignDto,
  ) {
    return this.campaigns.update(org, id, dto);
  }

  @Post(':id/status')
  @HttpCode(200)
  @Throttle(WRITE_LIMIT)
  @RequirePermission('marketing:manage')
  @ApiParam({ name: 'id', format: 'uuid' })
  @ApiEndpoint({
    summary: 'Activate, pause or complete a campaign',
    description:
      'Moves a campaign between `draft`, `active`, `paused` and `completed`. A completed campaign never restarts (409 `CAMPAIGN_STATUS_INVALID`), and one past its end date cannot be activated.',
    auth: 'org',
    permission: 'marketing:manage',
    body: CampaignStatusDto,
    response: CampaignDetailDto,
    message: 'Campaign status updated successfully',
    errors: [400, 404, 409, 429],
  })
  setStatus(
    @CurrentOrg() org: OrgContext,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: CampaignStatusDto,
  ) {
    return this.campaigns.setStatus(org, id, dto.status);
  }

  @Delete(':id')
  @HttpCode(200)
  @Throttle(WRITE_LIMIT)
  @RequirePermission('marketing:manage')
  @ApiParam({ name: 'id', format: 'uuid' })
  @ApiEndpoint({
    summary: 'Delete a campaign',
    description:
      'Deletes the campaign. Its discount codes are kept; they simply no longer belong to a campaign.',
    auth: 'org',
    permission: 'marketing:manage',
    response: null,
    message: 'Campaign deleted successfully',
    errors: [404, 429],
  })
  async remove(
    @CurrentOrg() org: OrgContext,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    await this.campaigns.remove(org, id);
  }
}
