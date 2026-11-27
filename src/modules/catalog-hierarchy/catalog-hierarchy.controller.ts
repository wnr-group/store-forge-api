import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Put,
  Query,
} from '@nestjs/common';
import { ApiParam, ApiTags } from '@nestjs/swagger';
import { ApiEndpoint } from '../../common/decorators/api-endpoint.decorator.js';
import {
  CurrentOrg,
  CurrentUser,
  OrgScoped,
  RequirePermission,
} from '../../common/decorators/decorators.js';
import type {
  AuthUser,
  OrgContext,
} from '../../common/interfaces/request-context.js';
import { CatalogAssignmentsService } from './catalog-assignments.service.js';
import {
  CatalogExportDto,
  CatalogExportQueryDto,
} from './catalog-export.dto.js';
import {
  CatalogImportResultDto,
  ImportCatalogDto,
} from './catalog-import.dto.js';
import { CatalogImportService } from './catalog-import.service.js';
import {
  AssignProductsDto,
  BulkAssignmentDto,
  CatalogAssignResultDto,
  CatalogDeletedDto,
  CatalogHierarchyDto,
  CatalogLevelDto,
  CatalogNodeDetailDto,
  CatalogNodeDto,
  CatalogNodeListQueryDto,
  CatalogNodeProductDto,
  CatalogProductPlacementDto,
  CatalogTreeDto,
  CatalogTreeQueryDto,
  CatalogUnassignResultDto,
  CreateCatalogHierarchyDto,
  CreateCatalogLevelDto,
  CreateCatalogNodeDto,
  DeleteCatalogNodeQueryDto,
  MoveCatalogNodeDto,
  NodeProductsQueryDto,
  ReorderCatalogLevelsDto,
  ReorderCatalogNodesDto,
  ReorderNodeProductsDto,
  SetProductNodesDto,
  UnassignProductsDto,
  UpdateCatalogHierarchyDto,
  UpdateCatalogLevelDto,
  UpdateCatalogNodeDto,
} from './catalog-hierarchy.dto.js';
import { CatalogHierarchyService } from './catalog-hierarchy.service.js';

/**
 * The configurable catalog hierarchy (for example Brand > Vehicle > Variant > Part category): its levels, its items and
 * the products placed on them. Separate from categories and collections, which are unchanged.
 */
@ApiTags('catalog-hierarchy')
@Controller('catalog')
@OrgScoped()
export class CatalogHierarchyController {
  constructor(
    private readonly hierarchy: CatalogHierarchyService,
    private readonly assignments: CatalogAssignmentsService,
    private readonly importer: CatalogImportService,
  ) {}

  // ------------------------------------------------------------------------------------------------------ hierarchy

  @Get('hierarchy')
  @RequirePermission('catalog:view')
  @ApiEndpoint({
    summary: 'View the catalog hierarchy',
    description:
      'Get your catalog hierarchy with its levels in order (top level first) and how many items each level has. If you have not set it up yet you get a 404 with the code CATALOG_HIERARCHY_NOT_FOUND. For now an organization has one hierarchy.',
    auth: 'org',
    permission: 'catalog:view',
    response: CatalogHierarchyDto,
    message: 'Catalog hierarchy retrieved successfully',
    errors: [404],
  })
  get(@CurrentOrg() org: OrgContext) {
    return this.hierarchy.getHierarchy(org);
  }

  @Post('hierarchy')
  @RequirePermission('catalog:manage')
  @ApiEndpoint({
    summary: 'Set up the catalog hierarchy',
    description:
      'Create your catalog hierarchy. It starts as a draft: shoppers see nothing of it until you set its status to active. You can add as many levels as you need afterwards (for example Brand, Vehicle, Variant, Part category). An organization has one hierarchy for now, so a second call gives a 409.',
    auth: 'org',
    permission: 'catalog:manage',
    body: CreateCatalogHierarchyDto,
    response: CatalogHierarchyDto,
    status: 201,
    message: 'Catalog hierarchy created successfully',
    errors: [409],
  })
  create(
    @CurrentOrg() org: OrgContext,
    @Body() dto: CreateCatalogHierarchyDto,
  ) {
    return this.hierarchy.createHierarchy(org, dto);
  }

  @Patch('hierarchy')
  @RequirePermission('catalog:manage')
  @ApiEndpoint({
    summary: 'Rename or publish the catalog hierarchy',
    description:
      'Change the name of the hierarchy, or its status. Only an active hierarchy is visible to shoppers.',
    auth: 'org',
    permission: 'catalog:manage',
    body: UpdateCatalogHierarchyDto,
    response: CatalogHierarchyDto,
    message: 'Catalog hierarchy updated successfully',
    errors: [404],
  })
  update(
    @CurrentOrg() org: OrgContext,
    @Body() dto: UpdateCatalogHierarchyDto,
  ) {
    return this.hierarchy.updateHierarchy(org, dto);
  }

  // ------------------------------------------------------------------------------------------------ import / export

  @Post('import')
  @RequirePermission('catalog:manage')
  @ApiEndpoint({
    summary: 'Import the catalog from rows',
    description:
      'Create or update levels, items and product placements from rows read from a CSV or Excel file (the file is read by the app; this takes the rows as JSON, up to 2000 per request). Each row is an item: fill level_1 (top level), level_2 ... down to the item of the row; optionally add status, description, position, and one product to place on it by product_id, product_sku or product_slug (never by part number, which is not unique). Items are matched by parent and name, so sending the same file again changes nothing. Send dryRun=true to see what would happen and every problem (row, column, message, value) without changing anything. A real import with any problem changes nothing and answers 400 (CATALOG_IMPORT_INVALID); otherwise everything is saved in one go. Levels are never renamed, reordered or deleted by an import. For a bigger file send several requests, parents before children.',
    auth: 'org',
    permission: 'catalog:manage',
    body: ImportCatalogDto,
    response: CatalogImportResultDto,
    message: 'Catalog import processed successfully',
    errors: [400, 409],
  })
  importCatalog(@CurrentOrg() org: OrgContext, @Body() dto: ImportCatalogDto) {
    return this.importer.import(org, dto);
  }

  @Get('export')
  @RequirePermission('catalog:view')
  @ApiEndpoint({
    summary: 'Export the catalog as rows',
    description:
      'The whole catalog in the import format, a page of up to 1000 rows at a time: the levels, and one row per item and placed product (an item without products has one row), parents before children. Ask for page 1, 2, ... until totalPages. Write the columns and rows into a CSV or Excel file; importing that file again changes nothing. Text that a spreadsheet could read as a formula starts with an apostrophe, which the import removes.',
    auth: 'org',
    permission: 'catalog:view',
    response: CatalogExportDto,
    message: 'Catalog exported successfully',
    errors: [404],
  })
  exportCatalog(
    @CurrentOrg() org: OrgContext,
    @Query() query: CatalogExportQueryDto,
  ) {
    return this.importer.export(org, query);
  }

  // ---------------------------------------------------------------------------------------------------------- levels

  @Get('levels')
  @RequirePermission('catalog:view')
  @ApiEndpoint({
    summary: 'List the levels',
    description:
      'The levels of the hierarchy in order, top level first, each with the number of items on it and whether it may carry products.',
    auth: 'org',
    permission: 'catalog:view',
    response: [CatalogLevelDto],
    message: 'Levels retrieved successfully',
    errors: [404],
  })
  levels(@CurrentOrg() org: OrgContext) {
    return this.hierarchy.listLevels(org);
  }

  @Post('levels')
  @RequirePermission('catalog:manage')
  @ApiEndpoint({
    summary: 'Add a level',
    description:
      'Add a named level (for example "Vehicle"). It goes at the end unless you give a position. Putting it before levels that already have items is refused when that would break the relations of those items. Switch `canHoldProducts` on for the levels whose items may carry products. At most 20 levels.',
    auth: 'org',
    permission: 'catalog:manage',
    body: CreateCatalogLevelDto,
    response: CatalogLevelDto,
    status: 201,
    message: 'Level created successfully',
    errors: [404, 409],
  })
  createLevel(
    @CurrentOrg() org: OrgContext,
    @Body() dto: CreateCatalogLevelDto,
  ) {
    return this.hierarchy.createLevel(org, dto);
  }

  // Declared before `levels/:id` so "reorder" is never read as an id.
  @Post('levels/reorder')
  @RequirePermission('catalog:manage')
  @ApiEndpoint({
    summary: 'Reorder the levels',
    description:
      'Send every level id in the new order (first = top level). The new order is accepted only when it keeps every existing relation valid: an item must stay on the level right below its parent, and top-level items on level 1. Otherwise nothing changes and the 409 response (CATALOG_LEVEL_ORDER_BLOCKED) lists the reasons. Levels without items can always be moved.',
    auth: 'org',
    permission: 'catalog:manage',
    body: ReorderCatalogLevelsDto,
    response: [CatalogLevelDto],
    message: 'Levels reordered successfully',
    errors: [404, 409],
  })
  reorderLevels(
    @CurrentOrg() org: OrgContext,
    @Body() dto: ReorderCatalogLevelsDto,
  ) {
    return this.hierarchy.reorderLevels(org, dto);
  }

  @Patch('levels/:id')
  @RequirePermission('catalog:manage')
  @ApiParam({ name: 'id', format: 'uuid' })
  @ApiEndpoint({
    summary: 'Rename a level or change what it may hold',
    description:
      'Renaming is always safe: items keep their place. `canHoldProducts` cannot be switched off while products are placed on items of the level.',
    auth: 'org',
    permission: 'catalog:manage',
    body: UpdateCatalogLevelDto,
    response: CatalogLevelDto,
    message: 'Level updated successfully',
    errors: [404, 409],
  })
  updateLevel(
    @CurrentOrg() org: OrgContext,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateCatalogLevelDto,
  ) {
    return this.hierarchy.updateLevel(org, id, dto);
  }

  @Delete('levels/:id')
  @RequirePermission('catalog:delete')
  @ApiParam({ name: 'id', format: 'uuid' })
  @ApiEndpoint({
    summary: 'Delete a level',
    description:
      'Delete a level that has no items. The levels below it move up one place.',
    auth: 'org',
    permission: 'catalog:delete',
    response: null,
    message: 'Level deleted successfully',
    errors: [404, 409],
  })
  async deleteLevel(
    @CurrentOrg() org: OrgContext,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    await this.hierarchy.deleteLevel(org, id);
  }

  // ----------------------------------------------------------------------------------------------------------- nodes

  @Get('tree')
  @RequirePermission('catalog:view')
  @ApiEndpoint({
    summary: 'Get the tree',
    description:
      'The items as a nested tree (children inside their parent, in order), each with its level, how many children it has and how many products sit directly on it. Use `parentId` for just one subtree and `maxDepth` to limit the depth. Very large trees are cut at 5000 items (`truncated` says so): read those subtree by subtree.',
    auth: 'org',
    permission: 'catalog:view',
    response: CatalogTreeDto,
    message: 'Catalog tree retrieved successfully',
    errors: [404],
  })
  tree(@CurrentOrg() org: OrgContext, @Query() query: CatalogTreeQueryDto) {
    return this.hierarchy.tree(org, query);
  }

  @Get('nodes')
  @RequirePermission('catalog:view')
  @ApiEndpoint({
    summary: 'List items',
    description:
      'A page of items as a flat list. Search by name or address, and filter by parent (`root` for the top level), level or status.',
    auth: 'org',
    permission: 'catalog:view',
    response: [CatalogNodeDto],
    paginated: true,
    message: 'Catalog items retrieved successfully',
    errors: [404],
  })
  listNodes(
    @CurrentOrg() org: OrgContext,
    @Query() query: CatalogNodeListQueryDto,
  ) {
    return this.hierarchy.listNodes(org, query);
  }

  @Post('nodes')
  @RequirePermission('catalog:manage')
  @ApiEndpoint({
    summary: 'Add an item',
    description:
      'Add an item under a parent, or at the top level when you send no `parentId`. It goes on the level right after its parent (or level 1), so that level has to exist. Without a slug one is made from the name, unique among its siblings. New items are drafts: a draft hides itself and everything below it from shoppers. To give the item an image, choose an `id` (a UUID), upload the file with `POST /uploads/signed-urls` (scope `catalog`, `ownerId` = that id), then send the same `id`, the returned `imagePath` and an optional `imageAlt` here.',
    auth: 'org',
    permission: 'catalog:manage',
    body: CreateCatalogNodeDto,
    response: CatalogNodeDetailDto,
    status: 201,
    message: 'Catalog item created successfully',
    errors: [404, 409],
  })
  createNode(
    @CurrentOrg() org: OrgContext,
    @CurrentUser() user: AuthUser,
    @Body() dto: CreateCatalogNodeDto,
  ) {
    return this.hierarchy.createNode(org, user, dto);
  }

  @Post('nodes/reorder')
  @RequirePermission('catalog:manage')
  @ApiEndpoint({
    summary: 'Reorder the children of an item',
    description:
      'Send every child of one parent (or of the top level, with no `parentId`) in the new order.',
    auth: 'org',
    permission: 'catalog:manage',
    body: ReorderCatalogNodesDto,
    response: null,
    message: 'Catalog items reordered successfully',
    errors: [404],
  })
  async reorderNodes(
    @CurrentOrg() org: OrgContext,
    @Body() dto: ReorderCatalogNodesDto,
  ) {
    await this.hierarchy.reorderNodes(org, dto);
  }

  @Get('nodes/:id')
  @RequirePermission('catalog:view')
  @ApiParam({ name: 'id', format: 'uuid' })
  @ApiEndpoint({
    summary: 'View one item',
    description:
      'An item with its level, its breadcrumbs from the top level, and how many children and products it has.',
    auth: 'org',
    permission: 'catalog:view',
    response: CatalogNodeDetailDto,
    message: 'Catalog item retrieved successfully',
    errors: [404],
  })
  getNode(
    @CurrentOrg() org: OrgContext,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return this.hierarchy.getNode(org, id);
  }

  @Patch('nodes/:id')
  @RequirePermission('catalog:manage')
  @ApiParam({ name: 'id', format: 'uuid' })
  @ApiEndpoint({
    summary: 'Edit an item',
    description:
      "Change the name, address, description, status, position, SEO texts or image. Send only what you want to change. To replace the image upload a new file (scope `catalog`, `ownerId` = this item's id) and send its `imagePath`; send `imagePath: null` to remove the image and its description. The old file is deleted after the change is saved, unless something else still uses it. To move an item under another parent use the move route.",
    auth: 'org',
    permission: 'catalog:manage',
    body: UpdateCatalogNodeDto,
    response: CatalogNodeDetailDto,
    message: 'Catalog item updated successfully',
    errors: [404, 409],
  })
  updateNode(
    @CurrentOrg() org: OrgContext,
    @CurrentUser() user: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateCatalogNodeDto,
  ) {
    return this.hierarchy.updateNode(org, user, id, dto);
  }

  @Post('nodes/:id/move')
  @RequirePermission('catalog:manage')
  @ApiParam({ name: 'id', format: 'uuid' })
  @ApiEndpoint({
    summary: 'Move an item',
    description:
      'Put an item (with everything below it) under another parent. The new parent has to be on the level just above the item (or null for the top level), and cannot be the item itself or one of its descendants.',
    auth: 'org',
    permission: 'catalog:manage',
    body: MoveCatalogNodeDto,
    response: CatalogNodeDetailDto,
    message: 'Catalog item moved successfully',
    errors: [404, 409],
  })
  moveNode(
    @CurrentOrg() org: OrgContext,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: MoveCatalogNodeDto,
  ) {
    return this.hierarchy.moveNode(org, id, dto);
  }

  @Delete('nodes/:id')
  @RequirePermission('catalog:delete')
  @ApiParam({ name: 'id', format: 'uuid' })
  @ApiEndpoint({
    summary: 'Delete an item',
    description:
      'Delete an item. If it has children the request is refused (409, CATALOG_NODE_HAS_CHILDREN) unless you send `cascade=true`, which deletes everything below it too. Products are never deleted, only taken off the deleted items. The images of the deleted items are removed from storage afterwards (unless something else still uses them).',
    auth: 'org',
    permission: 'catalog:delete',
    response: CatalogDeletedDto,
    message: 'Catalog item deleted successfully',
    errors: [404, 409],
  })
  deleteNode(
    @CurrentOrg() org: OrgContext,
    @CurrentUser() user: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Query() query: DeleteCatalogNodeQueryDto,
  ) {
    return this.hierarchy.deleteNode(org, user, id, query.cascade === true);
  }

  // ------------------------------------------------------------------------------------------------------ products

  @Get('nodes/:id/products')
  @RequirePermission('catalog:view')
  @ApiParam({ name: 'id', format: 'uuid' })
  @ApiEndpoint({
    summary: 'List the products on an item',
    description:
      'A page of the products placed on an item (search by name, SKU or part number). With `includeDescendants=true` the products of every item below it are included, each product once.',
    auth: 'org',
    permission: 'catalog:view',
    response: [CatalogNodeProductDto],
    paginated: true,
    message: 'Products retrieved successfully',
    errors: [404],
  })
  nodeProducts(
    @CurrentOrg() org: OrgContext,
    @Param('id', ParseUUIDPipe) id: string,
    @Query() query: NodeProductsQueryDto,
  ) {
    return this.assignments.listNodeProducts(org, id, query);
  }

  @Post('nodes/:id/products')
  @RequirePermission('catalog:manage')
  @ApiParam({ name: 'id', format: 'uuid' })
  @ApiEndpoint({
    summary: 'Place products on an item',
    description:
      "Place up to 500 products on an item. A product can be on any number of items; it is never copied. Placing a product that is already there changes nothing. The item's level must allow products.",
    auth: 'org',
    permission: 'catalog:manage',
    body: AssignProductsDto,
    response: CatalogAssignResultDto,
    status: 201,
    message: 'Products placed successfully',
    errors: [400, 404],
  })
  assign(
    @CurrentOrg() org: OrgContext,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: AssignProductsDto,
  ) {
    return this.assignments.assign(org, id, dto.productIds);
  }

  @Post('nodes/:id/products/unassign')
  @RequirePermission('catalog:manage')
  @ApiParam({ name: 'id', format: 'uuid' })
  @ApiEndpoint({
    summary: 'Take products off an item',
    description:
      'Take up to 500 products off an item. The products themselves are not deleted, and they stay on their other items.',
    auth: 'org',
    permission: 'catalog:manage',
    body: UnassignProductsDto,
    response: CatalogUnassignResultDto,
    message: 'Products removed successfully',
    errors: [404],
  })
  unassign(
    @CurrentOrg() org: OrgContext,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UnassignProductsDto,
  ) {
    return this.assignments.unassign(org, id, dto.productIds);
  }

  @Post('nodes/:id/products/reorder')
  @RequirePermission('catalog:manage')
  @ApiParam({ name: 'id', format: 'uuid' })
  @ApiEndpoint({
    summary: 'Reorder the products of an item',
    description:
      'Send every product of the item in the order shoppers should see them.',
    auth: 'org',
    permission: 'catalog:manage',
    body: ReorderNodeProductsDto,
    response: null,
    message: 'Products reordered successfully',
    errors: [400, 404],
  })
  async reorderProducts(
    @CurrentOrg() org: OrgContext,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: ReorderNodeProductsDto,
  ) {
    await this.assignments.reorder(org, id, dto);
  }

  @Delete('nodes/:id/products/:productId')
  @RequirePermission('catalog:manage')
  @ApiParam({ name: 'id', format: 'uuid' })
  @ApiParam({ name: 'productId', format: 'uuid' })
  @ApiEndpoint({
    summary: 'Take one product off an item',
    description:
      'Take a single product off an item. Nothing happens if it was not there.',
    auth: 'org',
    permission: 'catalog:manage',
    response: CatalogUnassignResultDto,
    message: 'Product removed successfully',
    errors: [404],
  })
  removeProduct(
    @CurrentOrg() org: OrgContext,
    @Param('id', ParseUUIDPipe) id: string,
    @Param('productId', ParseUUIDPipe) productId: string,
  ) {
    return this.assignments.unassign(org, id, [productId]);
  }

  @Post('assignments/bulk')
  @RequirePermission('catalog:manage')
  @ApiEndpoint({
    summary: 'Place or remove many products on many items',
    description:
      'Place (or take off) every one of up to 500 products on every one of up to 100 items in one request; items times products may not exceed 20000. All or nothing: if one item cannot hold products or one product does not exist, nothing is changed.',
    auth: 'org',
    permission: 'catalog:manage',
    body: BulkAssignmentDto,
    response: CatalogAssignResultDto,
    message: 'Placements updated successfully',
    errors: [400, 404],
  })
  bulk(@CurrentOrg() org: OrgContext, @Body() dto: BulkAssignmentDto) {
    return this.assignments.bulk(org, dto);
  }

  @Get('products/:productId/nodes')
  @RequirePermission('catalog:view')
  @ApiParam({ name: 'productId', format: 'uuid' })
  @ApiEndpoint({
    summary: 'Where a product is placed',
    description:
      'Every item the product sits on, with the names of the items from the top level down.',
    auth: 'org',
    permission: 'catalog:view',
    response: [CatalogProductPlacementDto],
    message: 'Placements retrieved successfully',
    errors: [404],
  })
  productPlacements(
    @CurrentOrg() org: OrgContext,
    @Param('productId', ParseUUIDPipe) productId: string,
  ) {
    return this.assignments.productPlacements(org, productId);
  }

  @Put('products/:productId/nodes')
  @RequirePermission('catalog:manage')
  @ApiParam({ name: 'productId', format: 'uuid' })
  @ApiEndpoint({
    summary: 'Set where a product is placed',
    description:
      'Make the product sit on exactly these items: the others are removed, the new ones added. Send an empty list to take it off the catalog.',
    auth: 'org',
    permission: 'catalog:manage',
    body: SetProductNodesDto,
    response: [CatalogProductPlacementDto],
    message: 'Placements updated successfully',
    errors: [400, 404],
  })
  setProductNodes(
    @CurrentOrg() org: OrgContext,
    @Param('productId', ParseUUIDPipe) productId: string,
    @Body() dto: SetProductNodesDto,
  ) {
    return this.assignments.setProductNodes(org, productId, dto);
  }
}
