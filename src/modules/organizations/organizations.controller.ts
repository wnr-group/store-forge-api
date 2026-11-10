import { Controller, Get } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { ApiEndpoint } from '../../common/decorators/api-endpoint.decorator.js';
import {
  CurrentOrg,
  CurrentUser,
  RequirePermission,
} from '../../common/decorators/decorators.js';
import type {
  AuthUser,
  OrgContext,
} from '../../common/interfaces/request-context.js';
import {
  CurrentOrganizationDto,
  OrganizationSummaryDto,
} from './organizations.dto.js';
import { OrganizationsService } from './organizations.service.js';

@ApiTags('organizations')
@Controller('organizations')
export class OrganizationsController {
  constructor(private readonly organizations: OrganizationsService) {}

  @Get()
  @ApiEndpoint({
    summary: 'List my organizations',
    description:
      'Active memberships of the verified user, oldest first. Disabled memberships and suspended organizations are not listed.',
    auth: 'jwt',
    response: [OrganizationSummaryDto],
    message: 'Organizations retrieved successfully',
  })
  listMine(@CurrentUser() user: AuthUser) {
    return this.organizations.listMine(user.id);
  }

  // Declared after the list route and under its own path, so `current` is never read as an id.
  @Get('current')
  @RequirePermission('dashboard:view')
  @ApiEndpoint({
    summary: 'Current organization, access and store',
    description:
      "The organization selected by `X-Organization-Id` (or the first one), the caller's role and effective module access, and the organization's primary store.",
    auth: 'org',
    permission: 'dashboard:view (any member)',
    response: CurrentOrganizationDto,
    message: 'Organization retrieved successfully',
    errors: [404],
  })
  current(@CurrentOrg() org: OrgContext) {
    return this.organizations.current(org);
  }
}
