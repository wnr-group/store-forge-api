import { Injectable } from '@nestjs/common';
import {
  and,
  asc,
  desc,
  eq,
  gte,
  ilike,
  inArray,
  isNull,
  or,
  sql,
  type SQL,
} from 'drizzle-orm';
import {
  AppException,
  conflict,
  invalid,
  notFound,
} from '../../common/app.exception.js';
import { Paginated } from '../../common/dto/api-response.dto.js';
import { likeTerm, offsetOf } from '../../common/dto/pagination-query.dto.js';
import { mapErrors } from '../../common/db-errors.js';
import type { OrgContext } from '../../common/interfaces/request-context.js';
import {
  DatabaseService,
  rowsOf,
  type DbTx,
} from '../../database/database.service.js';
import {
  catalogHierarchies,
  catalogLevels,
  catalogNodes,
  type CatalogHierarchy,
  type CatalogLevel,
} from '../../database/schema/index.js';
import type {
  CatalogBreadcrumbDto,
  CatalogDeletedDto,
  CatalogHierarchyDto,
  CatalogLevelDto,
  CatalogNodeDetailDto,
  CatalogNodeDto,
  CatalogNodeListQueryDto,
  CatalogTreeDto,
  CatalogTreeQueryDto,
  CreateCatalogHierarchyDto,
  CreateCatalogLevelDto,
  CreateCatalogNodeDto,
  MoveCatalogNodeDto,
  ReorderCatalogLevelsDto,
  ReorderCatalogNodesDto,
  UpdateCatalogHierarchyDto,
  UpdateCatalogLevelDto,
  UpdateCatalogNodeDto,
} from './catalog-hierarchy.dto.js';
import {
  MAX_LEVELS,
  MAX_NODES_PER_HIERARCHY,
  MAX_TREE_NODES,
  buildTree,
  freeSlug,
  nodeSlugFromName,
  reorderProblems,
  type LevelRef,
  type LevelUsage,
} from './catalog-hierarchy.rules.js';

export const hierarchyNotFound = () =>
  notFound(
    'Set up your catalog first: it does not exist yet.',
    'CATALOG_HIERARCHY_NOT_FOUND',
  );
export const nodeNotFound = () =>
  notFound('That catalog item no longer exists.', 'CATALOG_NODE_NOT_FOUND');
const levelNotFound = () =>
  notFound('That level no longer exists.', 'CATALOG_LEVEL_NOT_FOUND');

/** The organization's catalog hierarchy (there is at most one for now). */
export async function findHierarchy(
  tx: DbTx,
  tenantId: string,
): Promise<CatalogHierarchy | null> {
  const [h] = await tx
    .select()
    .from(catalogHierarchies)
    .where(eq(catalogHierarchies.tenantId, tenantId))
    .orderBy(asc(catalogHierarchies.createdAt), asc(catalogHierarchies.id))
    .limit(1);
  return h ?? null;
}

export async function requireHierarchy(
  tx: DbTx,
  tenantId: string,
): Promise<CatalogHierarchy> {
  const h = await findHierarchy(tx, tenantId);
  if (!h) throw hierarchyNotFound();
  return h;
}

export const levelsOf = (tx: DbTx, tenantId: string, hierarchyId: string) =>
  tx
    .select()
    .from(catalogLevels)
    .where(
      and(
        eq(catalogLevels.tenantId, tenantId),
        eq(catalogLevels.hierarchyId, hierarchyId),
      ),
    )
    .orderBy(asc(catalogLevels.position));

export async function countNodes(
  tx: DbTx,
  tenantId: string,
  hierarchyId: string,
): Promise<number> {
  const [row] = await tx
    .select({ n: sql<number>`count(*)::int` })
    .from(catalogNodes)
    .where(
      and(
        eq(catalogNodes.tenantId, tenantId),
        eq(catalogNodes.hierarchyId, hierarchyId),
      ),
    );
  return row?.n ?? 0;
}

/** How the existing items depend on the order of the levels (used to decide whether a reorder is safe). */
export async function levelUsage(
  tx: DbTx,
  tenantId: string,
  hierarchyId: string,
): Promise<LevelUsage> {
  const pairs = rowsOf<{ parent_level_id: string; child_level_id: string }>(
    await tx.execute(sql`
      select distinct p.level_id as parent_level_id, c.level_id as child_level_id
      from catalog_nodes c
      join catalog_nodes p on p.id = c.parent_id
      where c.tenant_id = ${tenantId} and c.hierarchy_id = ${hierarchyId}`),
  );
  const roots = rowsOf<{ level_id: string }>(
    await tx.execute(sql`
      select distinct level_id from catalog_nodes
      where tenant_id = ${tenantId} and hierarchy_id = ${hierarchyId} and parent_id is null`),
  );
  return {
    pairs: pairs.map((r) => ({
      parentLevelId: r.parent_level_id,
      childLevelId: r.child_level_id,
    })),
    rootLevelIds: roots.map((r) => r.level_id),
  };
}

const childCountSql = sql<number>`(select count(*)::int from "catalog_nodes" c where c.parent_id = "catalog_nodes"."id")`;
const productCountSql = sql<number>`(select count(*)::int from "catalog_node_products" np where np.node_id = "catalog_nodes"."id")`;

const nodeSelect = {
  node: catalogNodes,
  levelName: catalogLevels.name,
  levelPosition: catalogLevels.position,
  canHoldProducts: catalogLevels.canHoldProducts,
  childCount: childCountSql,
  productCount: productCountSql,
};

type NodeRow = {
  node: typeof catalogNodes.$inferSelect;
  levelName: string;
  levelPosition: number;
  canHoldProducts: boolean;
  childCount: number;
  productCount: number;
};

export const toNodeDto = (r: NodeRow): CatalogNodeDto => ({
  id: r.node.id,
  levelId: r.node.levelId,
  levelName: r.levelName,
  levelPosition: r.levelPosition,
  parentId: r.node.parentId,
  name: r.node.name,
  slug: r.node.slug,
  description: r.node.description,
  position: r.node.position,
  status: r.node.status,
  seoTitle: r.node.seoTitle,
  seoDescription: r.node.seoDescription,
  depth: r.node.depth,
  pathIds: r.node.pathIds,
  childCount: r.childCount,
  productCount: r.productCount,
  createdAt: r.node.createdAt,
  updatedAt: r.node.updatedAt,
});

/** One node of this organization with its level and counts, or null. */
export async function findNodeRow(
  tx: DbTx,
  tenantId: string,
  id: string,
): Promise<NodeRow | null> {
  const [row] = await tx
    .select(nodeSelect)
    .from(catalogNodes)
    .innerJoin(catalogLevels, eq(catalogLevels.id, catalogNodes.levelId))
    .where(and(eq(catalogNodes.id, id), eq(catalogNodes.tenantId, tenantId)));
  return row ?? null;
}

const siblingFilter = (
  tenantId: string,
  hierarchyId: string,
  parentId: string | null,
) =>
  and(
    eq(catalogNodes.tenantId, tenantId),
    eq(catalogNodes.hierarchyId, hierarchyId),
    parentId === null
      ? isNull(catalogNodes.parentId)
      : eq(catalogNodes.parentId, parentId),
  ) as SQL;

/** Position after the last sibling. */
async function nextPosition(
  tx: DbTx,
  tenantId: string,
  hierarchyId: string,
  parentId: string | null,
): Promise<number> {
  const [row] = await tx
    .select({ max: sql<number | null>`max(${catalogNodes.position})` })
    .from(catalogNodes)
    .where(siblingFilter(tenantId, hierarchyId, parentId));
  return row?.max === null || row?.max === undefined ? 0 : row.max + 1;
}

@Injectable()
export class CatalogHierarchyService {
  constructor(private readonly db: DatabaseService) {}

  // -------------------------------------------------------------------------------------------------------------------
  // Hierarchy
  // -------------------------------------------------------------------------------------------------------------------

  private async hierarchyDto(
    tx: DbTx,
    h: CatalogHierarchy,
  ): Promise<CatalogHierarchyDto> {
    const rows = await tx
      .select({
        level: catalogLevels,
        nodeCount: sql<number>`(select count(*)::int from "catalog_nodes" n where n.level_id = "catalog_levels"."id")`,
      })
      .from(catalogLevels)
      .where(eq(catalogLevels.hierarchyId, h.id))
      .orderBy(asc(catalogLevels.position));
    const levels = rows.map((r) => toLevelDto(r.level, r.nodeCount));
    return {
      id: h.id,
      name: h.name,
      status: h.status,
      levels,
      nodeCount: levels.reduce((sum, l) => sum + l.nodeCount, 0),
      createdAt: h.createdAt,
      updatedAt: h.updatedAt,
    };
  }

  async getHierarchy(ctx: OrgContext): Promise<CatalogHierarchyDto> {
    return this.db.withUser(ctx.userId, async (tx) =>
      this.hierarchyDto(tx, await requireHierarchy(tx, ctx.tenantId)),
    );
  }

  async createHierarchy(
    ctx: OrgContext,
    dto: CreateCatalogHierarchyDto,
  ): Promise<CatalogHierarchyDto> {
    return this.db.withUser(ctx.userId, (tx) =>
      mapErrors(async () => {
        const [h] = await tx
          .insert(catalogHierarchies)
          .values({
            tenantId: ctx.tenantId,
            name: dto.name,
            status: dto.status ?? 'draft',
          })
          .returning();
        return this.hierarchyDto(tx, h);
      }),
    );
  }

  async updateHierarchy(
    ctx: OrgContext,
    dto: UpdateCatalogHierarchyDto,
  ): Promise<CatalogHierarchyDto> {
    return this.db.withUser(ctx.userId, (tx) =>
      mapErrors(async () => {
        const h = await requireHierarchy(tx, ctx.tenantId);
        const set: Partial<typeof catalogHierarchies.$inferInsert> = {};
        if (dto.name !== undefined) set.name = dto.name;
        if (dto.status !== undefined) set.status = dto.status;
        if (Object.keys(set).length > 0)
          await tx
            .update(catalogHierarchies)
            .set(set)
            .where(eq(catalogHierarchies.id, h.id));
        return this.hierarchyDto(tx, await requireHierarchy(tx, ctx.tenantId));
      }),
    );
  }

  // -------------------------------------------------------------------------------------------------------------------
  // Levels
  // -------------------------------------------------------------------------------------------------------------------

  async listLevels(ctx: OrgContext): Promise<CatalogLevelDto[]> {
    return (await this.getHierarchy(ctx)).levels;
  }

  /** Refuses (with the reasons) an order that would break parent/child relations of existing items. */
  private async assertOrderSafe(
    tx: DbTx,
    tenantId: string,
    hierarchyId: string,
    order: LevelRef[],
  ) {
    const problems = reorderProblems(
      order,
      await levelUsage(tx, tenantId, hierarchyId),
    );
    if (problems.length > 0)
      throw new AppException(
        'CONFLICT',
        'The levels cannot be put in this order, because existing items depend on the current order.',
        { code: 'CATALOG_LEVEL_ORDER_BLOCKED', details: { problems } },
      );
  }

  async createLevel(
    ctx: OrgContext,
    dto: CreateCatalogLevelDto,
  ): Promise<CatalogLevelDto> {
    return this.db.withUser(ctx.userId, (tx) =>
      mapErrors(async () => {
        const h = await requireHierarchy(tx, ctx.tenantId);
        const levels = await levelsOf(tx, ctx.tenantId, h.id);
        if (levels.length >= MAX_LEVELS)
          throw invalid(
            `A catalog can have at most ${MAX_LEVELS} levels.`,
            undefined,
            'CATALOG_TOO_MANY_LEVELS',
          );
        const position = dto.position ?? levels.length + 1;
        if (position > levels.length + 1)
          throw invalid(
            `The new level can be at most number ${levels.length + 1}.`,
            { position: `Use a number from 1 to ${levels.length + 1}.` },
            'CATALOG_LEVEL_POSITION_INVALID',
          );
        if (position <= levels.length) {
          // Inserting in the middle moves the later levels down: only allowed while that keeps every relation valid.
          const order: LevelRef[] = levels.map((l) => ({
            id: l.id,
            name: l.name,
          }));
          order.splice(position - 1, 0, { id: 'new', name: dto.name });
          await this.assertOrderSafe(tx, ctx.tenantId, h.id, order);
          await tx
            .update(catalogLevels)
            .set({ position: sql`${catalogLevels.position} + 1` })
            .where(
              and(
                eq(catalogLevels.hierarchyId, h.id),
                gte(catalogLevels.position, position),
              ),
            );
        }
        const [level] = await tx
          .insert(catalogLevels)
          .values({
            tenantId: ctx.tenantId,
            hierarchyId: h.id,
            name: dto.name,
            position,
            canHoldProducts: dto.canHoldProducts ?? false,
          })
          .returning();
        return toLevelDto(level, 0);
      }),
    );
  }

  async updateLevel(
    ctx: OrgContext,
    id: string,
    dto: UpdateCatalogLevelDto,
  ): Promise<CatalogLevelDto> {
    return this.db.withUser(ctx.userId, (tx) =>
      mapErrors(async () => {
        const [level] = await tx
          .select()
          .from(catalogLevels)
          .where(
            and(
              eq(catalogLevels.id, id),
              eq(catalogLevels.tenantId, ctx.tenantId),
            ),
          );
        if (!level) throw levelNotFound();
        const set: Partial<typeof catalogLevels.$inferInsert> = {};
        if (dto.name !== undefined) set.name = dto.name;
        if (dto.canHoldProducts !== undefined)
          set.canHoldProducts = dto.canHoldProducts;
        if (Object.keys(set).length > 0)
          await tx
            .update(catalogLevels)
            .set(set)
            .where(eq(catalogLevels.id, id));
        const [row] = await tx
          .select({
            level: catalogLevels,
            nodeCount: sql<number>`(select count(*)::int from "catalog_nodes" n where n.level_id = "catalog_levels"."id")`,
          })
          .from(catalogLevels)
          .where(eq(catalogLevels.id, id));
        return toLevelDto(row.level, row.nodeCount);
      }),
    );
  }

  /**
   * Puts the levels in a new order. Safe by construction: it is refused, with the reasons, when an existing item would no
   * longer sit right below its parent (or a top-level item would leave level 1). Levels that no item uses move freely.
   * The database re-checks the same rule when the transaction commits.
   */
  async reorderLevels(
    ctx: OrgContext,
    dto: ReorderCatalogLevelsDto,
  ): Promise<CatalogLevelDto[]> {
    await this.db.withUser(ctx.userId, (tx) =>
      mapErrors(async () => {
        const h = await requireHierarchy(tx, ctx.tenantId);
        const levels = await levelsOf(tx, ctx.tenantId, h.id);
        const known = new Set(levels.map((l) => l.id));
        if (
          dto.levelIds.length !== levels.length ||
          !dto.levelIds.every((id) => known.has(id))
        )
          throw invalid(
            'Send every level of the catalog exactly once.',
            { levelIds: 'The list must contain all of your levels.' },
            'CATALOG_LEVEL_ORDER_INCOMPLETE',
          );
        const byId = new Map(levels.map((l) => [l.id, l]));
        const order = dto.levelIds.map((id) => ({
          id,
          name: byId.get(id)!.name,
        }));
        const changed = dto.levelIds.some(
          (id, i) => byId.get(id)!.position !== i + 1,
        );
        if (!changed) return;
        await this.assertOrderSafe(tx, ctx.tenantId, h.id, order);
        await tx
          .update(catalogLevels)
          .set({
            position: sql`case ${catalogLevels.id} ${sql.join(
              dto.levelIds.map(
                (id, i) => sql`when ${id}::uuid then ${i + 1}::int`,
              ),
              sql` `,
            )} end`,
          })
          .where(
            and(
              eq(catalogLevels.hierarchyId, h.id),
              inArray(catalogLevels.id, dto.levelIds),
            ),
          );
      }),
    );
    return this.listLevels(ctx);
  }

  async deleteLevel(ctx: OrgContext, id: string): Promise<void> {
    await this.db.withUser(ctx.userId, (tx) =>
      mapErrors(async () => {
        const [level] = await tx
          .select()
          .from(catalogLevels)
          .where(
            and(
              eq(catalogLevels.id, id),
              eq(catalogLevels.tenantId, ctx.tenantId),
            ),
          );
        if (!level) throw levelNotFound();
        const [used] = await tx
          .select({ n: sql<number>`count(*)::int` })
          .from(catalogNodes)
          .where(eq(catalogNodes.levelId, id));
        if (used.n > 0)
          throw conflict(
            `"${level.name}" still has ${used.n} item${used.n === 1 ? '' : 's'}. Delete or move them first.`,
            undefined,
            'CATALOG_LEVEL_IN_USE',
          );
        await tx.delete(catalogLevels).where(eq(catalogLevels.id, id));
        // Close the gap. A level without items has no deeper level with items (they would hang below it).
        await tx
          .update(catalogLevels)
          .set({ position: sql`${catalogLevels.position} - 1` })
          .where(
            and(
              eq(catalogLevels.hierarchyId, level.hierarchyId),
              sql`${catalogLevels.position} > ${level.position}`,
            ),
          );
      }),
    );
  }

  // -------------------------------------------------------------------------------------------------------------------
  // Nodes
  // -------------------------------------------------------------------------------------------------------------------

  async listNodes(
    ctx: OrgContext,
    q: CatalogNodeListQueryDto,
  ): Promise<Paginated<CatalogNodeDto>> {
    return this.db.withUser(ctx.userId, async (tx) => {
      const h = await requireHierarchy(tx, ctx.tenantId);
      const where: (SQL | undefined)[] = [
        eq(catalogNodes.tenantId, ctx.tenantId),
        eq(catalogNodes.hierarchyId, h.id),
      ];
      if (q.parentId === 'root') where.push(isNull(catalogNodes.parentId));
      else if (q.parentId) where.push(eq(catalogNodes.parentId, q.parentId));
      if (q.levelId) where.push(eq(catalogNodes.levelId, q.levelId));
      if (q.status !== 'all') where.push(eq(catalogNodes.status, q.status));
      if (q.search) {
        const term = likeTerm(q.search);
        where.push(
          or(ilike(catalogNodes.name, term), ilike(catalogNodes.slug, term)),
        );
      }
      const filter = and(...where) as SQL;
      const dir = q.sortOrder === 'desc' ? desc : asc;
      const order =
        q.sortBy === 'name'
          ? [dir(catalogNodes.name)]
          : q.sortBy === 'createdAt'
            ? [dir(catalogNodes.createdAt)]
            : [dir(catalogNodes.position), asc(catalogNodes.name)];
      const [rows, [{ total }]] = await Promise.all([
        tx
          .select(nodeSelect)
          .from(catalogNodes)
          .innerJoin(catalogLevels, eq(catalogLevels.id, catalogNodes.levelId))
          .where(filter)
          .orderBy(...order, asc(catalogNodes.id))
          .limit(q.limit)
          .offset(offsetOf(q)),
        tx
          .select({ total: sql<number>`count(*)::int` })
          .from(catalogNodes)
          .where(filter),
      ]);
      return new Paginated(rows.map(toNodeDto), {
        page: q.page,
        limit: q.limit,
        total,
      });
    });
  }

  async tree(ctx: OrgContext, q: CatalogTreeQueryDto): Promise<CatalogTreeDto> {
    return this.db.withUser(ctx.userId, async (tx) => {
      const h = await requireHierarchy(tx, ctx.tenantId);
      const where: (SQL | undefined)[] = [
        eq(catalogNodes.tenantId, ctx.tenantId),
        eq(catalogNodes.hierarchyId, h.id),
      ];
      let rootDepth = 1;
      if (q.parentId) {
        const [root] = await tx
          .select({ depth: catalogNodes.depth })
          .from(catalogNodes)
          .where(
            and(
              eq(catalogNodes.id, q.parentId),
              eq(catalogNodes.tenantId, ctx.tenantId),
            ),
          );
        if (!root) throw nodeNotFound();
        rootDepth = root.depth;
        where.push(sql`${q.parentId}::uuid = any(${catalogNodes.pathIds})`);
      }
      if (q.maxDepth)
        where.push(sql`${catalogNodes.depth} <= ${rootDepth + q.maxDepth - 1}`);
      const rows = await tx
        .select(nodeSelect)
        .from(catalogNodes)
        .innerJoin(catalogLevels, eq(catalogLevels.id, catalogNodes.levelId))
        .where(and(...where))
        .orderBy(
          asc(catalogNodes.depth),
          asc(catalogNodes.position),
          asc(catalogNodes.name),
          asc(catalogNodes.id),
        )
        .limit(MAX_TREE_NODES + 1);
      const truncated = rows.length > MAX_TREE_NODES;
      const nodes = rows.slice(0, MAX_TREE_NODES).map(toNodeDto);
      // With a parent given, that node is the root of the result: it must not hang under a parent we did not load.
      const flat = nodes.map((n) =>
        n.id === q.parentId ? Object.assign({}, n, { parentId: null }) : n,
      );
      return { nodes: buildTree(flat) as never, truncated };
    });
  }

  async getNode(ctx: OrgContext, id: string): Promise<CatalogNodeDetailDto> {
    return this.db.withUser(ctx.userId, (tx) =>
      this.nodeDetail(tx, ctx.tenantId, id),
    );
  }

  private async nodeDetail(
    tx: DbTx,
    tenantId: string,
    id: string,
  ): Promise<CatalogNodeDetailDto> {
    const row = await findNodeRow(tx, tenantId, id);
    if (!row) throw nodeNotFound();
    const breadcrumbs = await breadcrumbsOf(tx, tenantId, row.node.pathIds);
    return Object.assign(toNodeDto(row), {
      breadcrumbs,
      path: breadcrumbs.at(-1)?.path ?? row.node.slug,
      canHoldProducts: row.canHoldProducts,
    });
  }

  async createNode(
    ctx: OrgContext,
    dto: CreateCatalogNodeDto,
  ): Promise<CatalogNodeDetailDto> {
    return this.db.withUser(ctx.userId, (tx) =>
      mapErrors(async () => {
        const h = await requireHierarchy(tx, ctx.tenantId);
        const levels = await levelsOf(tx, ctx.tenantId, h.id);
        if (levels.length === 0)
          throw invalid(
            'Add at least one level before adding items.',
            undefined,
            'CATALOG_NO_LEVELS',
          );
        const parentId = dto.parentId ?? null;
        let targetPosition = 1;
        if (parentId) {
          const parent = await findNodeRow(tx, ctx.tenantId, parentId);
          if (!parent)
            throw invalid(
              'The parent item no longer exists.',
              { parentId: 'Choose another parent.' },
              'CATALOG_PARENT_NOT_FOUND',
            );
          targetPosition = parent.levelPosition + 1;
        }
        const level = levels.find((l) => l.position === targetPosition);
        if (!level)
          throw invalid(
            'The parent is on the last level. Add a level below it first.',
            { parentId: 'This item cannot have children yet.' },
            'CATALOG_LEVEL_MISSING',
          );
        if (
          (await countNodes(tx, ctx.tenantId, h.id)) >= MAX_NODES_PER_HIERARCHY
        )
          throw invalid(
            `A catalog can have at most ${MAX_NODES_PER_HIERARCHY} items.`,
            undefined,
            'CATALOG_TOO_MANY_NODES',
          );
        const slug =
          dto.slug ??
          (await this.freeSiblingSlug(
            tx,
            ctx.tenantId,
            h.id,
            parentId,
            nodeSlugFromName(dto.name),
          ));
        const [created] = await tx
          .insert(catalogNodes)
          .values({
            tenantId: ctx.tenantId,
            hierarchyId: h.id,
            levelId: level.id,
            parentId,
            name: dto.name,
            slug,
            description: dto.description ?? null,
            status: dto.status ?? 'draft',
            position:
              dto.position ??
              (await nextPosition(tx, ctx.tenantId, h.id, parentId)),
            seoTitle: dto.seoTitle ?? null,
            seoDescription: dto.seoDescription ?? null,
          })
          .returning({ id: catalogNodes.id });
        return this.nodeDetail(tx, ctx.tenantId, created.id);
      }),
    );
  }

  private async freeSiblingSlug(
    tx: DbTx,
    tenantId: string,
    hierarchyId: string,
    parentId: string | null,
    base: string,
  ): Promise<string> {
    const like = `${base.replace(/[%_\\]/g, '\\$&')}-%`;
    const rows = await tx
      .select({ slug: catalogNodes.slug })
      .from(catalogNodes)
      .where(
        and(
          siblingFilter(tenantId, hierarchyId, parentId),
          or(
            eq(catalogNodes.slug, base),
            sql`${catalogNodes.slug} like ${like}`,
          ),
        ),
      );
    return freeSlug(base, new Set(rows.map((r) => r.slug)));
  }

  async updateNode(
    ctx: OrgContext,
    id: string,
    dto: UpdateCatalogNodeDto,
  ): Promise<CatalogNodeDetailDto> {
    return this.db.withUser(ctx.userId, (tx) =>
      mapErrors(async () => {
        const row = await findNodeRow(tx, ctx.tenantId, id);
        if (!row) throw nodeNotFound();
        const set: Partial<typeof catalogNodes.$inferInsert> = {};
        if (dto.name !== undefined) set.name = dto.name;
        if (dto.slug !== undefined) set.slug = dto.slug;
        if (dto.description !== undefined) set.description = dto.description;
        if (dto.status !== undefined) set.status = dto.status;
        if (dto.position !== undefined) set.position = dto.position;
        if (dto.seoTitle !== undefined) set.seoTitle = dto.seoTitle;
        if (dto.seoDescription !== undefined)
          set.seoDescription = dto.seoDescription;
        if (Object.keys(set).length > 0)
          await tx.update(catalogNodes).set(set).where(eq(catalogNodes.id, id));
        return this.nodeDetail(tx, ctx.tenantId, id);
      }),
    );
  }

  /** Moves an item (with everything below it) under another parent of the level above, or to the top level. */
  async moveNode(
    ctx: OrgContext,
    id: string,
    dto: MoveCatalogNodeDto,
  ): Promise<CatalogNodeDetailDto> {
    return this.db.withUser(ctx.userId, (tx) =>
      mapErrors(async () => {
        const node = await findNodeRow(tx, ctx.tenantId, id);
        if (!node) throw nodeNotFound();
        const parentId = dto.parentId ?? null;
        if (parentId === null) {
          if (node.levelPosition !== 1)
            throw invalid(
              `A "${node.levelName}" item cannot be a top-level item. It has to sit under an item of the level above.`,
              { parentId: 'Choose a parent.' },
              'CATALOG_NODE_LEVEL_MISMATCH',
            );
        } else {
          if (parentId === id || (await isDescendant(tx, id, parentId)))
            throw invalid(
              'An item cannot be moved under itself or under one of its own descendants.',
              { parentId: 'Choose another parent.' },
              'CATALOG_NODE_CYCLE',
            );
          const parent = await findNodeRow(tx, ctx.tenantId, parentId);
          if (!parent)
            throw invalid(
              'The new parent no longer exists.',
              { parentId: 'Choose another parent.' },
              'CATALOG_PARENT_NOT_FOUND',
            );
          if (parent.levelPosition + 1 !== node.levelPosition)
            throw invalid(
              `A "${node.levelName}" item can only sit under an item of the level just above it, not under a "${parent.levelName}" item.`,
              { parentId: 'Choose a parent on the level above.' },
              'CATALOG_NODE_LEVEL_MISMATCH',
            );
        }
        const position =
          dto.position ??
          (await nextPosition(
            tx,
            ctx.tenantId,
            node.node.hierarchyId,
            parentId,
          ));
        await tx
          .update(catalogNodes)
          .set({ parentId, position })
          .where(eq(catalogNodes.id, id));
        return this.nodeDetail(tx, ctx.tenantId, id);
      }),
    );
  }

  /** Sets the order of all children of one parent. */
  async reorderNodes(
    ctx: OrgContext,
    dto: ReorderCatalogNodesDto,
  ): Promise<{ count: number }> {
    return this.db.withUser(ctx.userId, (tx) =>
      mapErrors(async () => {
        const h = await requireHierarchy(tx, ctx.tenantId);
        const parentId = dto.parentId ?? null;
        const siblings = await tx
          .select({ id: catalogNodes.id })
          .from(catalogNodes)
          .where(siblingFilter(ctx.tenantId, h.id, parentId));
        const known = new Set(siblings.map((s) => s.id));
        if (
          known.size !== dto.nodeIds.length ||
          !dto.nodeIds.every((nodeId) => known.has(nodeId))
        )
          throw invalid(
            'Send every item of this parent exactly once.',
            { nodeIds: 'The list must contain all items of the parent.' },
            'CATALOG_NODE_ORDER_INCOMPLETE',
          );
        await tx
          .update(catalogNodes)
          .set({
            position: sql`case ${catalogNodes.id} ${sql.join(
              dto.nodeIds.map(
                (nodeId, i) => sql`when ${nodeId}::uuid then ${i}::int`,
              ),
              sql` `,
            )} end`,
          })
          .where(
            and(
              eq(catalogNodes.tenantId, ctx.tenantId),
              inArray(catalogNodes.id, dto.nodeIds),
            ),
          );
        return { count: dto.nodeIds.length };
      }),
    );
  }

  async deleteNode(
    ctx: OrgContext,
    id: string,
    cascade: boolean,
  ): Promise<CatalogDeletedDto> {
    return this.db.withUser(ctx.userId, (tx) =>
      mapErrors(async () => {
        const node = await findNodeRow(tx, ctx.tenantId, id);
        if (!node) throw nodeNotFound();
        if (node.childCount > 0 && !cascade) {
          const [d] = await tx
            .select({ n: sql<number>`count(*)::int` })
            .from(catalogNodes)
            .where(
              and(
                eq(catalogNodes.tenantId, ctx.tenantId),
                sql`${id}::uuid = any(${catalogNodes.pathIds})`,
                sql`${catalogNodes.id} <> ${id}::uuid`,
              ),
            );
          throw new AppException(
            'CONFLICT',
            `"${node.node.name}" has ${d.n} item${d.n === 1 ? '' : 's'} below it. Delete it with everything below it, or move them first.`,
            {
              code: 'CATALOG_NODE_HAS_CHILDREN',
              details: { descendants: d.n },
            },
          );
        }
        // The whole subtree in ONE statement (the parent foreign key is checked at the end of it). Placed products are
        // only unlinked: the products themselves stay.
        const gone = await tx
          .delete(catalogNodes)
          .where(
            and(
              eq(catalogNodes.tenantId, ctx.tenantId),
              sql`${id}::uuid = any(${catalogNodes.pathIds})`,
            ),
          )
          .returning({ id: catalogNodes.id });
        return { deleted: gone.length };
      }),
    );
  }
}

const toLevelDto = (l: CatalogLevel, nodeCount: number): CatalogLevelDto => ({
  id: l.id,
  name: l.name,
  position: l.position,
  canHoldProducts: l.canHoldProducts,
  nodeCount,
  createdAt: l.createdAt,
  updatedAt: l.updatedAt,
});

/** True when `candidateId` is below `nodeId`. */
async function isDescendant(
  tx: DbTx,
  nodeId: string,
  candidateId: string,
): Promise<boolean> {
  const [row] = await tx
    .select({ id: catalogNodes.id })
    .from(catalogNodes)
    .where(
      and(
        eq(catalogNodes.id, candidateId),
        sql`${nodeId}::uuid = any(${catalogNodes.pathIds})`,
      ),
    );
  return Boolean(row);
}

/** The ancestors (and the node) in order from the top, with the slug path of each. */
export async function breadcrumbsOf(
  tx: DbTx,
  tenantId: string,
  pathIds: string[],
): Promise<CatalogBreadcrumbDto[]> {
  if (pathIds.length === 0) return [];
  const rows = await tx
    .select({
      id: catalogNodes.id,
      name: catalogNodes.name,
      slug: catalogNodes.slug,
      levelName: catalogLevels.name,
    })
    .from(catalogNodes)
    .innerJoin(catalogLevels, eq(catalogLevels.id, catalogNodes.levelId))
    .where(
      and(
        eq(catalogNodes.tenantId, tenantId),
        inArray(catalogNodes.id, pathIds),
      ),
    );
  const byId = new Map(rows.map((r) => [r.id, r]));
  const out: CatalogBreadcrumbDto[] = [];
  let path = '';
  for (const id of pathIds) {
    const r = byId.get(id);
    if (!r) continue;
    path = path ? `${path}/${r.slug}` : r.slug;
    out.push({ id, name: r.name, slug: r.slug, path, levelName: r.levelName });
  }
  return out;
}
