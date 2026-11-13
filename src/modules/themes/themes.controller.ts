import { Body, Controller, Get, Param, Post, Query } from '@nestjs/common';
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
  ApplyThemeDto,
  ApplyThemeResultDto,
  CurrentThemeDto,
  PublishResultDto,
  PublishThemeDto,
  ThemeDetailDto,
  ThemeListQueryDto,
  ThemeSummaryDto,
} from './themes.dto.js';
import { TemplatesService } from './templates.service.js';
import { ThemesService } from './themes.service.js';

@ApiTags('themes')
@Controller('themes')
@OrgScoped()
export class ThemesController {
  constructor(private readonly themes: ThemesService) {}

  @Get()
  @RequirePermission('dashboard:view')
  @ApiEndpoint({
    summary: 'Browse the theme store',
    description:
      'List the ready-made storefront themes you can use, one page at a time. Search by name or description and filter by the kind of store. The list is the same for every organization; only `isCurrent` differs, which marks the theme your store uses now.',
    auth: 'org',
    permission: 'dashboard:view',
    response: [ThemeSummaryDto],
    paginated: true,
    message: 'Themes retrieved successfully',
  })
  list(@CurrentOrg() org: OrgContext, @Query() query: ThemeListQueryDto) {
    return this.themes.list(org, query);
  }

  @Get(':slug')
  @RequirePermission('dashboard:view')
  @ApiParam({ name: 'slug', example: 'atelier' })
  @ApiEndpoint({
    summary: 'View one theme',
    description:
      'Get a theme with all of its starting documents (home page, product page, collection page, header, footer and settings). Render them with your own products to preview the theme before you apply it. Nothing about your store changes.',
    auth: 'org',
    permission: 'dashboard:view',
    response: ThemeDetailDto,
    message: 'Theme retrieved successfully',
    errors: [404],
  })
  detail(@CurrentOrg() org: OrgContext, @Param('slug') slug: string) {
    return this.themes.detail(org, slug);
  }
}

@ApiTags('themes')
@Controller('store/theme')
@OrgScoped()
export class StoreThemeController {
  constructor(
    private readonly themes: ThemesService,
    private readonly templates: TemplatesService,
  ) {}

  @Get()
  @RequirePermission('dashboard:view')
  @ApiEndpoint({
    summary: 'See the theme your store uses',
    description:
      'Get the theme your store started from and whether the catalogue has a newer version. If you have not chosen a theme yet, `theme` is null.',
    auth: 'org',
    permission: 'dashboard:view',
    response: CurrentThemeDto,
    message: 'Current theme retrieved successfully',
  })
  current(@CurrentOrg() org: OrgContext) {
    return this.themes.current(org);
  }

  @Post()
  @RequirePermission('store:manage')
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @ApiEndpoint({
    summary: 'Apply a theme',
    description:
      'Start from a theme. Its pages are copied into your drafts, replacing any drafts you had. Nothing goes live until you publish, your published pages stay as they are, and your products, collections, customers and orders are not touched.',
    auth: 'org',
    permission: 'store:manage',
    body: ApplyThemeDto,
    response: ApplyThemeResultDto,
    message: 'Theme applied as a draft',
    errors: [404, 409],
  })
  apply(@CurrentOrg() org: OrgContext, @Body() dto: ApplyThemeDto) {
    return this.themes.apply(org, dto);
  }

  @Post('publish')
  @RequirePermission('store:manage')
  @Throttle({ default: { limit: 20, ttl: 60_000 } })
  @ApiEndpoint({
    summary: 'Publish the whole theme',
    description:
      'Make every changed page, header, footer and setting live in one step. If any of them has a problem, nothing is published and the problems are listed. Each published page becomes a new numbered version you can restore later.',
    auth: 'org',
    permission: 'store:manage',
    body: PublishThemeDto,
    response: PublishResultDto,
    message: 'Theme published successfully',
    errors: [400],
  })
  publish(@CurrentOrg() org: OrgContext, @Body() dto: PublishThemeDto) {
    return this.templates.publishTheme(org, dto);
  }
}
