import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import { Type } from 'class-transformer';
import { IsNotEmpty, ValidateNested } from 'class-validator';
import type { Request } from 'express';
import { PaginationQueryDto } from '../../../src/common/dto/pagination-query.dto.js';
import { conflict } from '../../../src/common/errors/app-exception.js';
import {
  PublicRateLimitGuard,
  ReadyRateLimitGuard,
} from '../../../src/common/rate-limit/index.js';
import {
  NoTenant,
  Public,
  RequireLiveAuth,
  RequirePermission,
  RequirePlatformAdmin,
  RequireSuperAdmin,
} from './probe.decorators.js';

export class NestedProfileDto {
  @IsNotEmpty()
  bio!: string;
}

export class TestValidationDto {
  @IsNotEmpty()
  name!: string;

  @ValidateNested()
  @Type(() => NestedProfileDto)
  profile!: NestedProfileDto;
}

export const probeSpies = {
  defaultHandler: 0,
  liveHandler: 0,
  permissionHandler: 0,
  platformAdminHandler: 0,
  superAdminHandler: 0,
  reset: () => {
    probeSpies.defaultHandler = 0;
    probeSpies.liveHandler = 0;
    probeSpies.permissionHandler = 0;
    probeSpies.platformAdminHandler = 0;
    probeSpies.superAdminHandler = 0;
  },
};

@Controller('probe')
export class ProbeController {
  @Public()
  @Get('public')
  getPublic() {
    return { status: 'public-ok' };
  }

  @Public()
  @UseGuards(PublicRateLimitGuard)
  @Get('public-1')
  getPublic1() {
    return { probe: 1 };
  }

  @Public()
  @UseGuards(PublicRateLimitGuard)
  @Get('public-2')
  getPublic2() {
    return { probe: 2 };
  }

  @Public()
  @UseGuards(PublicRateLimitGuard)
  @Get('public-3')
  getPublic3() {
    return { probe: 3 };
  }

  @Public()
  @UseGuards(PublicRateLimitGuard)
  @Get('public-4')
  getPublic4() {
    return { probe: 4 };
  }

  @Public()
  @UseGuards(PublicRateLimitGuard)
  @Get('public-5')
  getPublic5() {
    return { probe: 5 };
  }

  @Public()
  @UseGuards(ReadyRateLimitGuard)
  @Get('ready-probe')
  getReadyProbe() {
    return { status: 'ready-probe-ok' };
  }

  @Get('default')
  getDefault(@Req() req: Request) {
    probeSpies.defaultHandler++;
    const r = req as unknown as Record<string, unknown>;
    return {
      status: 'authenticated-default',
      auth: r.auth,
      tenant: r.tenant,
    };
  }

  @NoTenant()
  @Get('no-tenant')
  getNoTenant(@Req() req: Request) {
    const r = req as unknown as Record<string, unknown>;
    return {
      status: 'no-tenant',
      auth: r.auth,
    };
  }

  @NoTenant()
  @RequirePlatformAdmin()
  @Get('platform-admin')
  getPlatformAdmin() {
    probeSpies.platformAdminHandler++;
    return { status: 'platform-admin-ok' };
  }

  @NoTenant()
  @RequireSuperAdmin()
  @Get('super-admin')
  getSuperAdmin() {
    probeSpies.superAdminHandler++;
    return { status: 'super-admin-ok' };
  }

  @RequirePermission('catalog:view')
  @Get('permission')
  getPermission() {
    probeSpies.permissionHandler++;
    return { status: 'permission-ok' };
  }

  @RequirePermission('catalog:manage')
  @Post('permission/manage')
  postPermissionManage() {
    return { status: 'catalog-manage-ok' };
  }

  @RequirePermission('members:manage')
  @Post('permission/members')
  postPermissionMembers() {
    return { status: 'members-manage-ok' };
  }

  @NoTenant()
  @RequirePlatformAdmin()
  @RequireLiveAuth()
  @Post('live')
  postLive() {
    probeSpies.liveHandler++;
    return { status: 'live-ok' };
  }

  @Public()
  @Get('error/unexpected')
  getUnexpectedError() {
    throw new Error('database connection exploded');
  }

  @Public()
  @Get('error/conflict')
  getConflictError() {
    throw conflict('Resource already exists');
  }

  @Public()
  @Post('validate')
  postValidate(@Body() _body: TestValidationDto) {
    return { ok: true };
  }

  @Public()
  @Get('items')
  getItems(@Query() query: PaginationQueryDto) {
    return {
      items: [
        {
          id: 'item-1',
          name: 'Item 1',
          createdAt: '2026-11-16T12:00:00.000Z',
        },
      ],
      total: 1,
      page: query.page,
      pageSize: query.pageSize,
    };
  }

  @Public()
  @Post('items')
  @HttpCode(HttpStatus.CREATED)
  createItem() {
    return { id: 'new-item-1', name: 'Created' };
  }

  @Public()
  @Delete('items/:id')
  @HttpCode(HttpStatus.NO_CONTENT)
  deleteItem(@Param('id') _id: string) {
    return;
  }
}
