import {
  Body,
  Controller,
  Get,
  Param,
  ParseUUIDPipe,
  Put,
} from '@nestjs/common';
import { ApiParam, ApiTags } from '@nestjs/swagger';
import { ApiEndpoint } from '../../../common/decorators/api-endpoint.decorator.js';
import {
  CurrentUser,
  PlatformAccess,
} from '../../../common/decorators/decorators.js';
import type { AuthUser } from '../../../common/interfaces/request-context.js';
import { AssignPlanDto, SubscriptionDto } from './subscriptions.dto.js';
import { SubscriptionsService } from './subscriptions.service.js';

const ID = { name: 'id', format: 'uuid', description: 'Organization id' };

@ApiTags('platform-admin')
@Controller('platform/organizations/:id/subscription')
@PlatformAccess({ permission: 'subscriptions:read' })
export class SubscriptionsController {
  constructor(private readonly subscriptions: SubscriptionsService) {}

  @Get()
  @ApiParam(ID)
  @ApiEndpoint({
    summary: "View an organization's subscription",
    description:
      'See which plan the organization is on, its billing interval, status, trial end and renewal date.',
    auth: 'platform',
    permission: 'subscriptions:read',
    response: SubscriptionDto,
    message: 'Subscription retrieved successfully',
    errors: [404],
  })
  get(@CurrentUser() admin: AuthUser, @Param('id', ParseUUIDPipe) id: string) {
    return this.subscriptions.get(admin.id, id);
  }

  @Put()
  @PlatformAccess({
    permission: 'subscriptions:manage',
    bucket: 'subscription.manage',
  })
  @ApiParam(ID)
  @ApiEndpoint({
    summary: 'Put an organization on a plan',
    description:
      'Move the organization to an active plan, for upgrades and downgrades alike. What it may use changes straight away, because features and limits are read from the plan. Sending the plan and interval it already has changes nothing. A trial starts only if you ask for it or the organization had no subscription.',
    auth: 'platform',
    permission: 'subscriptions:manage',
    body: AssignPlanDto,
    response: SubscriptionDto,
    message: 'Subscription updated successfully',
    errors: [404],
  })
  assign(
    @CurrentUser() admin: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: AssignPlanDto,
  ) {
    return this.subscriptions.assign(admin.id, id, dto);
  }
}
