import {
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  Query,
  Req,
} from '@nestjs/common';
import type { Request } from 'express';
import {
  NoTenant,
  Public,
  RequireLiveAuth,
  RequirePermission,
  RequirePlatformAdmin,
  RequireSuperAdmin,
} from './probe.decorators.js';

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
  @Get('public-1')
  getPublic1() {
    return { probe: 1 };
  }

  @Public()
  @Get('public-2')
  getPublic2() {
    return { probe: 2 };
  }

  @Public()
  @Get('public-3')
  getPublic3() {
    return { probe: 3 };
  }

  @Public()
  @Get('public-4')
  getPublic4() {
    return { probe: 4 };
  }

  @Public()
  @Get('public-5')
  getPublic5() {
    return { probe: 5 };
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

  @RequirePermission('products:read')
  @Get('permission')
  getPermission() {
    probeSpies.permissionHandler++;
    return { status: 'permission-ok' };
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

  @Get('items')
  getItems(@Query('page') page = '1', @Query('pageSize') pageSize = '20') {
    return {
      items: [{ id: 'item-1', name: 'Item 1' }],
      total: 1,
      page: Number(page),
      pageSize: Number(pageSize),
    };
  }

  @Post('items')
  @HttpCode(HttpStatus.CREATED)
  createItem() {
    return { id: 'new-item-1', name: 'Created' };
  }

  @Delete('items/:id')
  @HttpCode(HttpStatus.NO_CONTENT)
  deleteItem(@Param('id') _id: string) {
    return;
  }
}
