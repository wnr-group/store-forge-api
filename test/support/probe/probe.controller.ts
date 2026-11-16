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
import { ApiProperty, ApiTags } from '@nestjs/swagger';
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
  ApiAuth,
  ApiPagedResponse,
  ApiPublic,
  ApiStandardErrors,
  ApiTenantAuth,
} from '../../../src/common/swagger/index.js';
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

export class ProbeItemDto {
  @ApiProperty({ example: 'item-1' })
  id!: string;

  @ApiProperty({ example: 'Item 1' })
  name!: string;

  @ApiProperty({ example: '2026-11-16T12:00:00.000Z' })
  createdAt!: string;
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

@ApiTags('probe')
@Controller('probe')
export class ProbeController {
  @Public()
  @ApiPublic()
  @Get('public')
  getPublic() {
    return { status: 'public-ok' };
  }

  @Public()
  @ApiPublic()
  @UseGuards(PublicRateLimitGuard)
  @Get('public-1')
  getPublic1() {
    return { probe: 1 };
  }

  @Public()
  @ApiPublic()
  @UseGuards(PublicRateLimitGuard)
  @Get('public-2')
  getPublic2() {
    return { probe: 2 };
  }

  @Public()
  @ApiPublic()
  @UseGuards(PublicRateLimitGuard)
  @Get('public-3')
  getPublic3() {
    return { probe: 3 };
  }

  @Public()
  @ApiPublic()
  @UseGuards(PublicRateLimitGuard)
  @Get('public-4')
  getPublic4() {
    return { probe: 4 };
  }

  @Public()
  @ApiPublic()
  @UseGuards(PublicRateLimitGuard)
  @Get('public-5')
  getPublic5() {
    return { probe: 5 };
  }

  @Public()
  @ApiPublic()
  @UseGuards(ReadyRateLimitGuard)
  @Get('ready-probe')
  getReadyProbe() {
    return { status: 'ready-probe-ok' };
  }

  @ApiTenantAuth()
  @ApiStandardErrors()
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
  @ApiAuth()
  @ApiStandardErrors()
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
  @ApiAuth()
  @ApiStandardErrors()
  @Get('platform-admin')
  getPlatformAdmin() {
    probeSpies.platformAdminHandler++;
    return { status: 'platform-admin-ok' };
  }

  @NoTenant()
  @RequireSuperAdmin()
  @ApiAuth()
  @ApiStandardErrors()
  @Get('super-admin')
  getSuperAdmin() {
    probeSpies.superAdminHandler++;
    return { status: 'super-admin-ok' };
  }

  @RequirePermission('catalog:view')
  @ApiTenantAuth('catalog:view')
  @ApiStandardErrors()
  @Get('permission')
  getPermission() {
    probeSpies.permissionHandler++;
    return { status: 'permission-ok' };
  }

  @RequirePermission('catalog:manage')
  @ApiTenantAuth('catalog:manage')
  @ApiStandardErrors()
  @Post('permission/manage')
  postPermissionManage() {
    return { status: 'catalog-manage-ok' };
  }

  @RequirePermission('members:manage')
  @ApiTenantAuth('members:manage')
  @ApiStandardErrors()
  @Post('permission/members')
  postPermissionMembers() {
    return { status: 'members-manage-ok' };
  }

  @NoTenant()
  @RequirePlatformAdmin()
  @RequireLiveAuth()
  @ApiAuth()
  @ApiStandardErrors()
  @Post('live')
  postLive() {
    probeSpies.liveHandler++;
    return { status: 'live-ok' };
  }

  @Public()
  @ApiPublic()
  @Get('error/unexpected')
  getUnexpectedError() {
    throw new Error('database connection exploded');
  }

  @Public()
  @ApiPublic()
  @Get('error/conflict')
  getConflictError() {
    throw conflict('Resource already exists');
  }

  @Public()
  @ApiPublic()
  @Post('validate')
  postValidate(@Body() _body: TestValidationDto) {
    return { ok: true };
  }

  @Public()
  @ApiPublic()
  @ApiPagedResponse(ProbeItemDto)
  @ApiStandardErrors()
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
  @ApiPublic()
  @Post('items')
  @HttpCode(HttpStatus.CREATED)
  createItem() {
    return { id: 'new-item-1', name: 'Created' };
  }

  @Public()
  @ApiPublic()
  @Delete('items/:id')
  @HttpCode(HttpStatus.NO_CONTENT)
  deleteItem(@Param('id') _id: string) {
    return;
  }
}
