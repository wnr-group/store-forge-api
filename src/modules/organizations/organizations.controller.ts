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
      'See every organization you belong to, starting with the one you joined first. Organizations where your access has been disabled, and organizations that have been suspended, are not shown.',
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
    summary: 'View my current organization',
    description:
      'Get the organization you are working in right now (the one named in the `X-Organization-Id` header, or your first one if none is given), your role in it, what you are allowed to do there, and its main store.',
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
