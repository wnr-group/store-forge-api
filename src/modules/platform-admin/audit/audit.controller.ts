import { Controller, Get, Query } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { ApiEndpoint } from '../../../common/decorators/api-endpoint.decorator.js';
import {
  CurrentUser,
  PlatformAccess,
} from '../../../common/decorators/decorators.js';
import type { AuthUser } from '../../../common/interfaces/request-context.js';
import { AuditAdminDto, AuditLogDto, AuditQueryDto } from './audit.dto.js';
import { AuditService } from './audit.service.js';

@ApiTags('platform-admin')
@Controller('platform/audit-logs')
@PlatformAccess()
export class AuditController {
  constructor(private readonly audit: AuditService) {}

  @Get()
  @ApiEndpoint({
    summary: 'View the activity log',
    description:
      'See a history of what Platform Admins have done, newest first, a page at a time. You can filter it by the type of action, the admin who did it, the organization it affected, a search word (matched against the organization name) and a date range (counted in whole UTC days). Entries can never be edited or deleted, and passwords and tokens are removed before anything is saved.',
    auth: 'platform',
    response: [AuditLogDto],
    paginated: true,
    message: 'Audit log retrieved successfully',
  })
  list(@CurrentUser() admin: AuthUser, @Query() query: AuditQueryDto) {
    return this.audit.list(admin.id, query);
  }

  @Get('admins')
  @ApiEndpoint({
    summary: 'List admins in the activity log',
    description:
      'Get the admins who appear in the activity log, so you can offer them in a filter dropdown.',
    auth: 'platform',
    response: [AuditAdminDto],
    message: 'Administrators retrieved successfully',
  })
  admins(@CurrentUser() admin: AuthUser) {
    return this.audit.admins(admin.id);
  }
}
