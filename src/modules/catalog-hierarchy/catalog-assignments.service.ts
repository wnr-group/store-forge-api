import { Injectable } from '@nestjs/common';
import {
  and,
  asc,
  desc,
  eq,
  ilike,
  inArray,
  or,
  sql,
  type SQL,
} from 'drizzle-orm';
import { invalid, notFound } from '../../common/app.exception.js';
import { Paginated } from '../../common/dto/api-response.dto.js';
import { likeTerm, offsetOf } from '../../common/dto/pagination-query.dto.js';
import { mapErrors } from '../../common/db-errors.js';
import type { OrgContext } from '../../common/interfaces/request-context.js';
import { DatabaseService, type DbTx } from '../../database/database.service.js';
import {
  catalogLevels,
  catalogNodeProducts,
  catalogNodes,
  products,
} from '../../database/schema/index.js';
import type {
  BulkAssignmentDto,
  CatalogAssignResultDto,
  CatalogNodeProductDto,
  CatalogProductPlacementDto,
  CatalogUnassignResultDto,
  NodeProductsQueryDto,
  ReorderNodeProductsDto,
  SetProductNodesDto,
} from './catalog-hierarchy.dto.js';
import { MAX_ASSIGNMENT_PAIRS } from './catalog-hierarchy.rules.js';
import {
  breadcrumbsOf,
  findNodeRow,
  nodeNotFound,
} from './catalog-hierarchy.service.js';

const productNotFound = (ids: string[] = []) =>
  invalid(
    'A selected product no longer exists.',
    ids.length
      ? { productIds: `Unknown: ${ids.slice(0, 5).join(', ')}` }
      : undefined,
    'PRODUCT_NOT_FOUND',
  );

const cannotHold = (levelName: string) =>
  invalid(
    `Products cannot be placed on "${levelName}" items. Turn on "can hold products" for that level first.`,
    undefined,
    'CATALOG_LEVEL_CANNOT_HOLD_PRODUCTS',
  );

const CHUNK = 2000;
const chunks = <T>(list: T[], size = CHUNK): T[][] =>
  Array.from({ length: Math.ceil(list.length / size) }, (_, i) =>
    list.slice(i * size, (i + 1) * size),
  );

/** Placing products on items of the catalog hierarchy (many products per item, many items per product). */
@Injectable()
export class CatalogAssignmentsService {
  constructor(private readonly db: DatabaseService) {}

  private async assertProducts(tx: DbTx, tenantId: string, ids: string[]) {
    const found = new Set<string>();
    for (const part of chunks(ids)) {
      const rows = await tx
        .select({ id: products.id })
        .from(products)
        .where(
          and(eq(products.tenantId, tenantId), inArray(products.id, part)),
        );
      for (const r of rows) found.add(r.id);
    }
    const missing = ids.filter((id) => !found.has(id));
    if (missing.length > 0) throw productNotFound(missing);
  }

  /** The next free position on each of the given items. */
  private async basePositions(
    tx: DbTx,
    nodeIds: string[],
  ): Promise<Map<string, number>> {
    const rows = await tx
      .select({
        nodeId: catalogNodeProducts.nodeId,
        max: sql<number>`max(${catalogNodeProducts.position})`,
      })
      .from(catalogNodeProducts)
      .where(inArray(catalogNodeProducts.nodeId, nodeIds))
      .groupBy(catalogNodeProducts.nodeId);
    return new Map(rows.map((r) => [r.nodeId, r.max + 1]));
  }

  /** Inserts the links that do not exist yet; returns how many were new. */
  private async link(
    tx: DbTx,
    tenantId: string,
    pairs: { nodeId: string; productId: string; position: number }[],
  ): Promise<number> {
    let added = 0;
    for (const part of chunks(pairs)) {
      const rows = await tx
        .insert(catalogNodeProducts)
        .values(part.map((p) => ({ tenantId, ...p })))
        .onConflictDoNothing()
        .returning({ productId: catalogNodeProducts.productId });
      added += rows.length;
    }
    return added;
  }

  // -------------------------------------------------------------------------------------------------------------------

  async listNodeProducts(
    ctx: OrgContext,
    nodeId: string,
    q: NodeProductsQueryDto,
  ): Promise<Paginated<CatalogNodeProductDto>> {
    return this.db.withUser(ctx.userId, async (tx) => {
      if (!(await findNodeRow(tx, ctx.tenantId, nodeId))) throw nodeNotFound();
      const where: (SQL | undefined)[] = [
        eq(catalogNodeProducts.tenantId, ctx.tenantId),
        q.includeDescendants
          ? sql`${nodeId}::uuid = any(${catalogNodes.pathIds})`
          : eq(catalogNodeProducts.nodeId, nodeId),
      ];
      if (q.search) {
        const term = likeTerm(q.search);
        where.push(
          or(
            ilike(products.name, term),
            ilike(products.sku, term),
            ilike(products.partNumber, term),
          ),
        );
      }
      const filter = and(...where) as SQL;
      const position = sql<number>`min(${catalogNodeProducts.position})`;
      const dir = q.sortOrder === 'desc' ? desc : asc;
      const order =
        q.sortBy === 'name'
          ? dir(products.name)
          : q.sortBy === 'createdAt'
            ? dir(products.createdAt)
            : dir(position);
      const from = (t: typeof tx) =>
        t
          .select({
            id: products.id,
            name: products.name,
            slug: products.slug,
            sku: products.sku,
            partNumber: products.partNumber,
            status: products.status,
            priceMinor: products.priceMinor,
            imagePath: sql<
              string | null
            >`(select i.storage_path from "product_images" i where i.product_id = "products"."id" order by i.is_primary desc, i.position asc limit 1)`,
            position,
          })
          .from(catalogNodeProducts)
          .innerJoin(
            catalogNodes,
            eq(catalogNodes.id, catalogNodeProducts.nodeId),
          )
          .innerJoin(products, eq(products.id, catalogNodeProducts.productId))
          .where(filter)
          .groupBy(products.id);
      const [rows, [{ total }]] = await Promise.all([
        from(tx)
          .orderBy(order, asc(products.id))
          .limit(q.limit)
          .offset(offsetOf(q)),
        tx
          .select({ total: sql<number>`count(distinct ${products.id})::int` })
          .from(catalogNodeProducts)
          .innerJoin(
            catalogNodes,
            eq(catalogNodes.id, catalogNodeProducts.nodeId),
          )
          .innerJoin(products, eq(products.id, catalogNodeProducts.productId))
          .where(filter),
      ]);
      return new Paginated(rows, { page: q.page, limit: q.limit, total });
    });
  }

  async assign(
    ctx: OrgContext,
    nodeId: string,
    productIds: string[],
  ): Promise<CatalogAssignResultDto> {
    return this.db.withUser(ctx.userId, (tx) =>
      mapErrors(async () => {
        const node = await findNodeRow(tx, ctx.tenantId, nodeId);
        if (!node) throw nodeNotFound();
        if (!node.canHoldProducts) throw cannotHold(node.levelName);
        await this.assertProducts(tx, ctx.tenantId, productIds);
        const base = (await this.basePositions(tx, [nodeId])).get(nodeId) ?? 0;
        const assigned = await this.link(
          tx,
          ctx.tenantId,
          productIds.map((productId, i) => ({
            nodeId,
            productId,
            position: base + i,
          })),
        );
        return { assigned, alreadyAssigned: productIds.length - assigned };
      }),
    );
  }

  async unassign(
    ctx: OrgContext,
    nodeId: string,
    productIds: string[],
  ): Promise<CatalogUnassignResultDto> {
    return this.db.withUser(ctx.userId, (tx) =>
      mapErrors(async () => {
        if (!(await findNodeRow(tx, ctx.tenantId, nodeId)))
          throw nodeNotFound();
        const rows = await tx
          .delete(catalogNodeProducts)
          .where(
            and(
              eq(catalogNodeProducts.tenantId, ctx.tenantId),
              eq(catalogNodeProducts.nodeId, nodeId),
              inArray(catalogNodeProducts.productId, productIds),
            ),
          )
          .returning({ productId: catalogNodeProducts.productId });
        return { removed: rows.length };
      }),
    );
  }

  /** Sets the order of the products on an item (all of them must be listed). */
  async reorder(
    ctx: OrgContext,
    nodeId: string,
    dto: ReorderNodeProductsDto,
  ): Promise<{ count: number }> {
    return this.db.withUser(ctx.userId, (tx) =>
      mapErrors(async () => {
        if (!(await findNodeRow(tx, ctx.tenantId, nodeId)))
          throw nodeNotFound();
        const current = await tx
          .select({ id: catalogNodeProducts.productId })
          .from(catalogNodeProducts)
          .where(eq(catalogNodeProducts.nodeId, nodeId));
        const known = new Set(current.map((c) => c.id));
        if (
          known.size !== dto.productIds.length ||
          !dto.productIds.every((id) => known.has(id))
        )
          throw invalid(
            'Send every product of this item exactly once.',
            { productIds: 'The list must contain all products of the item.' },
            'CATALOG_PRODUCT_ORDER_INCOMPLETE',
          );
        await tx
          .update(catalogNodeProducts)
          .set({
            position: sql`case ${catalogNodeProducts.productId} ${sql.join(
              dto.productIds.map(
                (id, i) => sql`when ${id}::uuid then ${i}::int`,
              ),
              sql` `,
            )} end`,
          })
          .where(eq(catalogNodeProducts.nodeId, nodeId));
        return { count: dto.productIds.length };
      }),
    );
  }

  /** Many items x many products in one go (assign or unassign). */
  async bulk(
    ctx: OrgContext,
    dto: BulkAssignmentDto,
  ): Promise<CatalogAssignResultDto & CatalogUnassignResultDto> {
    if (dto.nodeIds.length * dto.productIds.length > MAX_ASSIGNMENT_PAIRS)
      throw invalid(
        `Items times products may not be more than ${MAX_ASSIGNMENT_PAIRS} at once. Send smaller batches.`,
        undefined,
        'CATALOG_BULK_TOO_LARGE',
      );
    return this.db.withUser(ctx.userId, (tx) =>
      mapErrors(async () => {
        const nodes = await tx
          .select({
            id: catalogNodes.id,
            levelName: catalogLevels.name,
            canHold: catalogLevels.canHoldProducts,
          })
          .from(catalogNodes)
          .innerJoin(catalogLevels, eq(catalogLevels.id, catalogNodes.levelId))
          .where(
            and(
              eq(catalogNodes.tenantId, ctx.tenantId),
              inArray(catalogNodes.id, dto.nodeIds),
            ),
          );
        if (nodes.length !== dto.nodeIds.length) throw nodeNotFound();
        if (dto.action === 'unassign') {
          const rows = await tx
            .delete(catalogNodeProducts)
            .where(
              and(
                eq(catalogNodeProducts.tenantId, ctx.tenantId),
                inArray(catalogNodeProducts.nodeId, dto.nodeIds),
                inArray(catalogNodeProducts.productId, dto.productIds),
              ),
            )
            .returning({ productId: catalogNodeProducts.productId });
          return { assigned: 0, alreadyAssigned: 0, removed: rows.length };
        }
        const blocked = nodes.find((n) => !n.canHold);
        if (blocked) throw cannotHold(blocked.levelName);
        await this.assertProducts(tx, ctx.tenantId, dto.productIds);
        const base = await this.basePositions(tx, dto.nodeIds);
        const pairs = dto.nodeIds.flatMap((nodeId) =>
          dto.productIds.map((productId, i) => ({
            nodeId,
            productId,
            position: (base.get(nodeId) ?? 0) + i,
          })),
        );
        const assigned = await this.link(tx, ctx.tenantId, pairs);
        return {
          assigned,
          alreadyAssigned: pairs.length - assigned,
          removed: 0,
        };
      }),
    );
  }

  // -------------------------------------------------------------------------------------------------------------------
  // From the product's side
  // -------------------------------------------------------------------------------------------------------------------

  async productPlacements(
    ctx: OrgContext,
    productId: string,
  ): Promise<CatalogProductPlacementDto[]> {
    return this.db.withUser(ctx.userId, async (tx) => {
      await this.assertProductExists(tx, ctx.tenantId, productId);
      return this.placementsInTx(tx, ctx.tenantId, productId);
    });
  }

  private async assertProductExists(tx: DbTx, tenantId: string, id: string) {
    const [p] = await tx
      .select({ id: products.id })
      .from(products)
      .where(and(eq(products.id, id), eq(products.tenantId, tenantId)));
    if (!p)
      throw notFound('That product no longer exists.', 'PRODUCT_NOT_FOUND');
  }

  private async placementsInTx(
    tx: DbTx,
    tenantId: string,
    productId: string,
  ): Promise<CatalogProductPlacementDto[]> {
    const rows = await tx
      .select({
        nodeId: catalogNodes.id,
        name: catalogNodes.name,
        status: catalogNodes.status,
        pathIds: catalogNodes.pathIds,
        levelName: catalogLevels.name,
        position: catalogNodeProducts.position,
      })
      .from(catalogNodeProducts)
      .innerJoin(catalogNodes, eq(catalogNodes.id, catalogNodeProducts.nodeId))
      .innerJoin(catalogLevels, eq(catalogLevels.id, catalogNodes.levelId))
      .where(
        and(
          eq(catalogNodeProducts.tenantId, tenantId),
          eq(catalogNodeProducts.productId, productId),
        ),
      )
      .orderBy(asc(catalogNodes.name), asc(catalogNodes.id));
    const allIds = [...new Set(rows.flatMap((r) => r.pathIds))];
    const crumbs = new Map(
      (await breadcrumbsOf(tx, tenantId, allIds)).map((c) => [c.id, c]),
    );
    return rows.map((r) => ({
      nodeId: r.nodeId,
      name: r.name,
      levelName: r.levelName,
      status: r.status,
      position: r.position,
      names: r.pathIds.map((id) => crumbs.get(id)?.name ?? ''),
      path: r.pathIds.map((id) => crumbs.get(id)?.slug ?? '').join('/'),
    }));
  }

  /** Makes the product sit on exactly these items: removes the other placements, adds the new ones. */
  async setProductNodes(
    ctx: OrgContext,
    productId: string,
    dto: SetProductNodesDto,
  ): Promise<CatalogProductPlacementDto[]> {
    return this.db.withUser(ctx.userId, (tx) =>
      mapErrors(async () => {
        await this.assertProductExists(tx, ctx.tenantId, productId);
        if (dto.nodeIds.length > 0) {
          const nodes = await tx
            .select({
              id: catalogNodes.id,
              levelName: catalogLevels.name,
              canHold: catalogLevels.canHoldProducts,
            })
            .from(catalogNodes)
            .innerJoin(
              catalogLevels,
              eq(catalogLevels.id, catalogNodes.levelId),
            )
            .where(
              and(
                eq(catalogNodes.tenantId, ctx.tenantId),
                inArray(catalogNodes.id, dto.nodeIds),
              ),
            );
          if (nodes.length !== dto.nodeIds.length) throw nodeNotFound();
          const blocked = nodes.find((n) => !n.canHold);
          if (blocked) throw cannotHold(blocked.levelName);
        }
        const current = await tx
          .select({ nodeId: catalogNodeProducts.nodeId })
          .from(catalogNodeProducts)
          .where(eq(catalogNodeProducts.productId, productId));
        const have = new Set(current.map((c) => c.nodeId));
        const want = new Set(dto.nodeIds);
        const remove = [...have].filter((id) => !want.has(id));
        const add = dto.nodeIds.filter((id) => !have.has(id));
        if (remove.length > 0)
          await tx
            .delete(catalogNodeProducts)
            .where(
              and(
                eq(catalogNodeProducts.productId, productId),
                inArray(catalogNodeProducts.nodeId, remove),
              ),
            );
        if (add.length > 0) {
          const base = await this.basePositions(tx, add);
          await this.link(
            tx,
            ctx.tenantId,
            add.map((nodeId) => ({
              nodeId,
              productId,
              position: base.get(nodeId) ?? 0,
            })),
          );
        }
        return this.placementsInTx(tx, ctx.tenantId, productId);
      }),
    );
  }
}
