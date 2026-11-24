import {
  Body,
  Controller,
  Get,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
} from '@nestjs/common';
import { ApiExtraModels, ApiParam, ApiTags } from '@nestjs/swagger';
import { ApiEndpoint } from '../../../common/decorators/api-endpoint.decorator.js';
import {
  CurrentUser,
  PlatformAccess,
} from '../../../common/decorators/decorators.js';
import type { AuthUser } from '../../../common/interfaces/request-context.js';
import {
  CreatePlanDto,
  LimitValueDto,
  PlanCatalogDto,
  PlanDto,
  PlanListQueryDto,
  PlanStatusDto,
  UpdatePlanDto,
} from './plans.dto.js';
import { PlansService } from './plans.service.js';

const ID = { name: 'id', format: 'uuid', description: 'Plan id' };

@ApiTags('platform-admin')
@ApiExtraModels(LimitValueDto)
@Controller('platform')
@PlatformAccess({ permission: 'plans:read' })
export class PlansController {
  constructor(private readonly plans: PlansService) {}

  @Get('plan-catalog')
  @ApiEndpoint({
    summary: 'List the features and limits a plan can use',
    description:
      'Get every capability StoreForge can switch on or limit per plan, with a name and a short explanation. Use it to build the plan form. Which plan includes what is not decided here: that is what you set on each plan.',
    auth: 'platform',
    permission: 'plans:read',
    response: PlanCatalogDto,
    message: 'Plan catalog retrieved successfully',
  })
  catalog() {
    return this.plans.catalog();
  }

  @Get('plans')
  @ApiEndpoint({
    summary: 'List subscription plans',
    description:
      'See all plans, a page at a time, with their prices, trial length, features, limits and how many organizations are on each. You can search by name or code and filter by status.',
    auth: 'platform',
    permission: 'plans:read',
    response: [PlanDto],
    paginated: true,
    message: 'Plans retrieved successfully',
  })
  list(@CurrentUser() admin: AuthUser, @Query() query: PlanListQueryDto) {
    return this.plans.list(admin.id, query);
  }

  @Get('plans/:id')
  @ApiParam(ID)
  @ApiEndpoint({
    summary: 'View a subscription plan',
    description: 'Get one plan with all of its features and limits.',
    auth: 'platform',
    permission: 'plans:read',
    response: PlanDto,
    message: 'Plan retrieved successfully',
    errors: [404],
  })
  get(@CurrentUser() admin: AuthUser, @Param('id', ParseUUIDPipe) id: string) {
    return this.plans.get(admin.id, id);
  }

  @Post('plans')
  @PlatformAccess({ permission: 'plans:manage', bucket: 'plan.manage' })
  @ApiEndpoint({
    summary: 'Create a subscription plan',
    description:
      'Add a plan with its prices, trial length, features and limits. Features and limits you leave out start switched off and unlimited. The plan code is permanent. Making a plan the default takes the default from the previous one. Each admin can do this at most 60 times in 10 minutes together with other plan and subscription changes.',
    auth: 'platform',
    permission: 'plans:manage',
    body: CreatePlanDto,
    response: PlanDto,
    status: 201,
    message: 'Plan created successfully',
    errors: [409],
  })
  create(@CurrentUser() admin: AuthUser, @Body() dto: CreatePlanDto) {
    return this.plans.create(admin.id, dto);
  }

  @Patch('plans/:id')
  @PlatformAccess({ permission: 'plans:manage', bucket: 'plan.manage' })
  @ApiParam(ID)
  @ApiEndpoint({
    summary: 'Edit a subscription plan',
    description:
      'Change a plan. Only what you send changes, and nothing is written or logged if nothing differs. Features and limits you send are updated; the rest stay. A limit set to null becomes unlimited. Organizations already on the plan get the new values straight away, because they are read from the plan.',
    auth: 'platform',
    permission: 'plans:manage',
    body: UpdatePlanDto,
    response: PlanDto,
    message: 'Plan updated successfully',
    errors: [404],
  })
  update(
    @CurrentUser() admin: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdatePlanDto,
  ) {
    return this.plans.update(admin.id, id, dto);
  }

  @Patch('plans/:id/status')
  @PlatformAccess({ permission: 'plans:manage', bucket: 'plan.manage' })
  @ApiParam(ID)
  @ApiEndpoint({
    summary: 'Activate or deactivate a plan',
    description:
      'An inactive plan cannot be given to organizations any more, but organizations already on it keep it. The default plan cannot be deactivated.',
    auth: 'platform',
    permission: 'plans:manage',
    body: PlanStatusDto,
    response: PlanDto,
    message: 'Plan status updated successfully',
    errors: [404],
  })
  setStatus(
    @CurrentUser() admin: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: PlanStatusDto,
  ) {
    return this.plans.setStatus(admin.id, id, dto.status);
  }
}
