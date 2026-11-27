import { Controller, Get, Param, Query } from '@nestjs/common';
import { ApiParam, ApiTags } from '@nestjs/swagger';
import { ApiEndpoint } from '../../common/decorators/api-endpoint.decorator.js';
import { Public } from '../../common/decorators/decorators.js';
import {
  PublicCatalogNodePageDto,
  PublicCatalogNodeQueryDto,
  PublicCatalogTreeDto,
  PublicCatalogTreeQueryDto,
} from './public-catalog.dto.js';
import { PublicCatalogService } from './public-catalog.service.js';

/** The same two reads feed every storefront template: the tree for menus and navigation, one item for its page. */
@ApiTags('public')
@Controller('public/storefronts/:slug/catalog')
@Public()
export class PublicCatalogController {
  constructor(private readonly catalog: PublicCatalogService) {}

  @Get('tree')
  @ApiParam({ name: 'slug', example: 'acme-store' })
  @ApiEndpoint({
    summary: "Get a public store's catalog tree",
    description:
      'The levels of the catalog and every active item, as a flat list in display order (build the tree from `parentId`, or use `depth` and `path`). An item below a draft item is not shown. A store without a published catalog answers with `hierarchy: null` and empty lists. Use `maxDepth=1` for a top-level menu. Anyone can call it without signing in. Unknown, inactive or suspended stores give a 404.',
    auth: 'public',
    response: PublicCatalogTreeDto,
    message: 'Catalog retrieved successfully',
    errors: [404],
  })
  tree(@Param('slug') slug: string, @Query() query: PublicCatalogTreeQueryDto) {
    return this.catalog.tree(slug.toLowerCase(), query.maxDepth);
  }

  // Express 5 hands a wildcard back as the list of its segments.
  @Get('nodes/*path')
  @ApiParam({ name: 'slug', example: 'acme-store' })
  @ApiParam({
    name: 'path',
    example: 'toyota/camry',
    description:
      'The slugs from the top level down to the item, separated by "/" (the `path` of an item in the tree).',
  })
  @ApiEndpoint({
    summary: 'View one catalog item of a public store',
    description:
      'An active item with its breadcrumbs, its active children and a page of its active products (name, address, part number, short description, price, picture and availability). With `includeDescendants=true` the products of all active items below it are included, each once. Sort by position (default), newest, name, price_asc or price_desc. Anyone can call it without signing in. An unknown store, an item that does not exist, an item that is not active or has a draft ancestor, and an inactive or suspended store all give a 404.',
    auth: 'public',
    response: PublicCatalogNodePageDto,
    message: 'Catalog item retrieved successfully',
    errors: [404],
  })
  node(
    @Param('slug') slug: string,
    @Param('path') path: string | string[],
    @Query() query: PublicCatalogNodeQueryDto,
  ) {
    const segments = (Array.isArray(path) ? path : String(path).split('/'))
      .map((s) => s.toLowerCase())
      .filter((s) => s.length > 0);
    return this.catalog.node(slug.toLowerCase(), segments, query);
  }
}
