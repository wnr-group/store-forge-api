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
    summary: 'Audit log',
    description:
      'Append-only record of Platform Admin actions, newest first. Filter by action, administrator, organization, text (organization name) and date range (UTC days). Rows cannot be edited or deleted; passwords and tokens are stripped from stored data.',
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
    summary: 'Administrators who appear in the audit log',
    description: 'For a filter dropdown.',
    auth: 'platform',
    response: [AuditAdminDto],
    message: 'Administrators retrieved successfully',
  })
  admins(@CurrentUser() admin: AuthUser) {
    return this.audit.admins(admin.id);
  }
}
