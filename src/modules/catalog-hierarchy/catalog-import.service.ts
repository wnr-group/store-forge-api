import { Injectable } from '@nestjs/common';
import { and, asc, eq, inArray, isNull, sql, type SQL } from 'drizzle-orm';
import { AppException, invalid } from '../../common/app.exception.js';
import { mapErrors } from '../../common/db-errors.js';
import type { OrgContext } from '../../common/interfaces/request-context.js';
import { escapeCell } from '../../common/utils/spreadsheet.js';
import { DatabaseService, type DbTx } from '../../database/database.service.js';
import {
  catalogHierarchies,
  catalogLevels,
  catalogNodeProducts,
  catalogNodes,
  products,
  type CatalogHierarchy,
} from '../../database/schema/index.js';
import { capErrors, type RowError } from '../products/product-import.rules.js';
import type {
  CatalogExportQueryDto,
  CatalogExportDto,
} from './catalog-export.dto.js';
import type {
  CatalogImportResultDto,
  ImportCatalogDto,
} from './catalog-import.dto.js';
import {
  MAX_NODES_PER_HIERARCHY,
  freeSlug,
  nodeSlugFromName,
} from './catalog-hierarchy.rules.js';
import {
  STATUSES,
  cellOf,
  emptySummary,
  mergeAttributes,
  parseLevels,
  parseRow,
  pathKey,
  reconcileLevels,
  type ItemAttributes,
  type ItemStatus,
  type ParsedRow,
} from './catalog-import.rules.js';
import {
  findHierarchy,
  hierarchyNotFound,
  levelsOf,
} from './catalog-hierarchy.service.js';

const CHUNK = 1000;
const chunks = <T>(list: readonly T[], size = CHUNK): T[][] =>
  Array.from({ length: Math.ceil(list.length / size) }, (_, i) =>
    list.slice(i * size, (i + 1) * size),
  );

interface ExistingChild {
  id: string;
  parentId: string | null;
  name: string;
  slug: string;
  status: string;
  description: string | null;
  position: number;
}

interface PlannedNode {
  key: string;
  depth: number;
  parentKey: string | null;
  name: string;
  nameKey: string;
  attrs: ItemAttributes;
  existing: ExistingChild | null;
  id: string;
  slug: string;
  status: ItemStatus;
  description: string | null;
  position: number;
  /** For an existing item: what the file changes. */
  update: {
    status?: ItemStatus;
    description?: string;
    position?: number;
  } | null;
}

interface PlannedLink {
  nodeKey: string;
  productId: string;
  position?: number;
  row: number;
}

interface Plan {
  errors: RowError[];
  summary: ReturnType<typeof emptySummary>;
  hierarchy: CatalogHierarchy | null;
  levelIds: string[];
  levelsToCreate: {
    id: string;
    name: string;
    position: number;
    canHoldProducts: boolean;
  }[];
  levelsToUpdate: { id: string; canHoldProducts: boolean }[];
  nodes: PlannedNode[];
  links: PlannedLink[];
  /** Links that do not exist yet. */
  newLinks: (PlannedLink & { position: number })[];
}

/**
 * Catalog import (levels, items and product placements) and export, from and to JSON rows: the file is read by the
 * frontend. Same approach as the product import: validate everything first, change nothing when anything is wrong, and
 * write everything in one transaction otherwise. Importing the same file again changes nothing (items are matched by
 * parent and name, placements by item and product).
 */
@Injectable()
export class CatalogImportService {
  constructor(private readonly db: DatabaseService) {}

  async import(
    ctx: OrgContext,
    dto: ImportCatalogDto,
  ): Promise<CatalogImportResultDto> {
    const dryRun = dto.dryRun === true;
    const defaultStatus = (cellOf(dto.defaultStatus) ?? 'draft').toLowerCase();
    if (!(STATUSES as readonly string[]).includes(defaultStatus))
      throw invalid(
        'defaultStatus must be draft or active.',
        { defaultStatus: 'Use draft or active.' },
        'CATALOG_IMPORT_STATUS_INVALID',
      );
    const plan = await this.db.withUser(ctx.userId, (tx) =>
      mapErrors(async () => {
        const planned = await this.plan(
          tx,
          ctx.tenantId,
          dto,
          defaultStatus as ItemStatus,
        );
        if (!dryRun && planned.errors.length === 0)
          await this.apply(
            tx,
            ctx.tenantId,
            planned,
            cellOf(dto.hierarchyName) ?? 'Catalog',
          );
        return planned;
      }),
    );
    const capped = capErrors(plan.errors);
    if (!dryRun && plan.errors.length > 0)
      throw new AppException(
        'VALIDATION',
        'Nothing was imported. Fix the rows below and send the file again.',
        { code: 'CATALOG_IMPORT_INVALID', details: capped },
      );
    return {
      dryRun,
      valid: plan.errors.length === 0,
      summary: plan.summary,
      errors: capped.errors,
      totalErrors: capped.total,
    };
  }

  // -------------------------------------------------------------------------------------------------------------------
  // Plan: read everything, decide what would happen, collect every problem. Writes nothing.
  // -------------------------------------------------------------------------------------------------------------------

  private async plan(
    tx: DbTx,
    tenantId: string,
    dto: ImportCatalogDto,
    defaultStatus: ItemStatus,
  ): Promise<Plan> {
    const errors: RowError[] = [];
    const summary = emptySummary();

    // Levels
    const wanted = parseLevels(dto.levels);
    errors.push(...wanted.errors);
    const hierarchy = await findHierarchy(tx, tenantId);
    const existingLevels = hierarchy
      ? await levelsOf(tx, tenantId, hierarchy.id)
      : [];
    const recon = reconcileLevels(
      existingLevels.map((l) => ({
        id: l.id,
        name: l.name,
        position: l.position,
        canHoldProducts: l.canHoldProducts,
      })),
      wanted.levels,
    );
    errors.push(...recon.errors);
    const levelIds = recon.final.map((l) => l.id ?? crypto.randomUUID());
    const levelsToCreate = recon.create.map((l) => ({
      id: levelIds[l.position - 1],
      ...l,
    }));
    summary.hierarchyCreated = !hierarchy;
    summary.levelsCreated = recon.create.length;
    summary.levelsUpdated = recon.update.length;

    // Rows
    const parsed: ParsedRow[] = [];
    for (const row of dto.rows) {
      const r = parseRow(row);
      errors.push(...r.errors);
      if (r.parsed) parsed.push(r.parsed);
    }
    const levelCount = recon.final.length;
    const usable: ParsedRow[] = [];
    for (const row of parsed) {
      if (levelCount === 0) continue;
      if (row.depth > levelCount) {
        errors.push({
          row: row.row,
          column: `level_${row.depth}`,
          message: `Your catalog has ${levelCount} level${levelCount === 1 ? '' : 's'}, but this row uses level ${row.depth}. Add the level in the "levels" section first.`,
          value: row.names[row.depth - 1].slice(0, 100),
        });
        continue;
      }
      usable.push(row);
    }
    if (levelCount === 0 && parsed.length > 0)
      errors.push({
        row: parsed[0].row,
        column: 'level_1',
        message:
          'Your catalog has no levels yet. Send them in the "levels" section, top level first.',
        value: '',
      });

    const merged = mergeAttributes(usable);
    errors.push(...merged.errors);
    const nodes = await this.planNodes(
      tx,
      tenantId,
      hierarchy,
      usable,
      merged.attributes,
      defaultStatus,
    );

    // Total size
    const created = nodes.filter((n) => !n.existing).length;
    if (created > 0) {
      const [row] = hierarchy
        ? await tx
            .select({ n: sql<number>`count(*)::int` })
            .from(catalogNodes)
            .where(eq(catalogNodes.hierarchyId, hierarchy.id))
        : [{ n: 0 }];
      if (row.n + created > MAX_NODES_PER_HIERARCHY)
        errors.push({
          row: usable[0]?.row ?? 0,
          column: 'level_1',
          message: `A catalog can have at most ${MAX_NODES_PER_HIERARCHY} items; this file would make ${row.n + created}.`,
          value: '',
        });
    }
    summary.nodesCreated = created;
    summary.nodesUpdated = nodes.filter((n) => n.existing && n.update).length;
    summary.nodesUnchanged = nodes.filter(
      (n) => n.existing && !n.update,
    ).length;

    // Products
    const nodeByKey = new Map(nodes.map((n) => [n.key, n]));
    const links = await this.planLinks(
      tx,
      tenantId,
      usable,
      (depth) => recon.final[depth - 1],
      errors,
    );
    const newLinks = await this.newLinks(tx, links, nodeByKey);
    summary.assignmentsCreated = newLinks.length;
    summary.assignmentsExisting = links.length - newLinks.length;

    return {
      errors,
      summary,
      hierarchy,
      levelIds,
      levelsToCreate,
      levelsToUpdate: recon.update,
      nodes,
      links,
      newLinks,
    };
  }

  /** The distinct items of the file, matched with the existing items level by level, with their slugs and positions. */
  private async planNodes(
    tx: DbTx,
    tenantId: string,
    hierarchy: CatalogHierarchy | null,
    rows: readonly ParsedRow[],
    attributes: Map<string, ItemAttributes>,
    defaultStatus: ItemStatus,
  ): Promise<PlannedNode[]> {
    const nodes = new Map<string, PlannedNode>();
    for (const r of rows)
      for (let d = 1; d <= r.depth; d++) {
        const key = pathKey(r.keys.slice(0, d));
        if (nodes.has(key)) continue;
        nodes.set(key, {
          key,
          depth: d,
          parentKey: d > 1 ? pathKey(r.keys.slice(0, d - 1)) : null,
          name: r.names[d - 1],
          nameKey: r.keys[d - 1],
          attrs: attributes.get(key) ?? {},
          existing: null,
          id: crypto.randomUUID(),
          slug: '',
          status: defaultStatus,
          description: null,
          position: 0,
          update: null,
        });
      }
    if (nodes.size === 0) return [];

    const ordered = [...nodes.values()];
    const maxDepth = Math.max(...ordered.map((n) => n.depth));
    for (let depth = 1; depth <= maxDepth; depth++) {
      const level = ordered.filter((n) => n.depth === depth);
      // Which parents do we have to look at? (A parent that is new has no children yet.)
      const lookup = new Set<string>();
      for (const n of level) {
        const parent = n.parentKey ? nodes.get(n.parentKey)! : null;
        if (!parent) {
          if (hierarchy) lookup.add('root');
        } else if (parent.existing) lookup.add(parent.existing.id);
      }
      const children = await this.childrenOf(tx, tenantId, hierarchy, lookup);
      const taken = new Map<string, Set<string>>();
      const next = new Map<string, number>();
      for (const [group, list] of children) {
        taken.set(group, new Set(list.map((c) => c.slug)));
        next.set(
          group,
          list.reduce((m, c) => Math.max(m, c.position + 1), 0),
        );
      }
      for (const n of level) {
        const parent = n.parentKey ? nodes.get(n.parentKey)! : null;
        const group = !parent ? 'root' : (parent.existing?.id ?? parent.id);
        const siblings = children.get(group) ?? [];
        const baseSlug = nodeSlugFromName(n.name);
        const match =
          siblings.find(
            (c) =>
              c.name.trim().replace(/\s+/g, ' ').toLowerCase() === n.nameKey,
          ) ?? siblings.find((c) => c.slug === baseSlug);
        if (match) {
          n.existing = match;
          n.id = match.id;
          n.slug = match.slug;
          const update: NonNullable<PlannedNode['update']> = {};
          if (n.attrs.status && n.attrs.status !== match.status)
            update.status = n.attrs.status;
          if (
            n.attrs.description !== undefined &&
            n.attrs.description !== (match.description ?? '')
          )
            update.description = n.attrs.description;
          if (
            n.attrs.position !== undefined &&
            n.attrs.position !== match.position
          )
            update.position = n.attrs.position;
          n.update = Object.keys(update).length > 0 ? update : null;
          continue;
        }
        const used = taken.get(group) ?? new Set<string>();
        n.slug = freeSlug(baseSlug, used);
        used.add(n.slug);
        taken.set(group, used);
        n.status = n.attrs.status ?? defaultStatus;
        n.description = n.attrs.description ?? null;
        if (n.attrs.position !== undefined) n.position = n.attrs.position;
        else {
          const at = next.get(group) ?? 0;
          n.position = at;
          next.set(group, at + 1);
        }
      }
    }
    return ordered;
  }

  /** The existing children of the given parents ('root' = the top level), grouped by parent. */
  private async childrenOf(
    tx: DbTx,
    tenantId: string,
    hierarchy: CatalogHierarchy | null,
    parents: ReadonlySet<string>,
  ): Promise<Map<string, ExistingChild[]>> {
    const out = new Map<string, ExistingChild[]>();
    if (!hierarchy) return out;
    const select = {
      id: catalogNodes.id,
      parentId: catalogNodes.parentId,
      name: catalogNodes.name,
      slug: catalogNodes.slug,
      status: catalogNodes.status,
      description: catalogNodes.description,
      position: catalogNodes.position,
    };
    const base = and(
      eq(catalogNodes.tenantId, tenantId),
      eq(catalogNodes.hierarchyId, hierarchy.id),
    ) as SQL;
    const add = (rows: ExistingChild[]) => {
      for (const c of rows) {
        const group = c.parentId ?? 'root';
        out.set(group, [...(out.get(group) ?? []), c]);
      }
    };
    if (parents.has('root'))
      add(
        await tx
          .select(select)
          .from(catalogNodes)
          .where(and(base, isNull(catalogNodes.parentId)))
          .orderBy(asc(catalogNodes.position), asc(catalogNodes.id)),
      );
    const ids = [...parents].filter((p) => p !== 'root');
    for (const part of chunks(ids))
      add(
        await tx
          .select(select)
          .from(catalogNodes)
          .where(and(base, inArray(catalogNodes.parentId, part)))
          .orderBy(asc(catalogNodes.position), asc(catalogNodes.id)),
      );
    return out;
  }

  /** Finds the product of every row that names one (by id, SKU or slug; never by part number), and checks the level allows products. */
  private async planLinks(
    tx: DbTx,
    tenantId: string,
    rows: readonly ParsedRow[],
    levelAt: (
      depth: number,
    ) => { name: string; canHoldProducts: boolean } | undefined,
    errors: RowError[],
  ): Promise<PlannedLink[]> {
    const withProduct = rows.filter((r) => r.product);
    if (withProduct.length === 0) return [];
    const wantIds = new Set<string>();
    const wantSkus = new Set<string>();
    const wantSlugs = new Set<string>();
    for (const r of withProduct) {
      if (r.product!.id) wantIds.add(r.product!.id);
      if (r.product!.sku) wantSkus.add(r.product!.sku);
      if (r.product!.slug) wantSlugs.add(r.product!.slug);
    }
    const byId = new Map<string, string>();
    const bySku = new Map<string, string>();
    const bySlug = new Map<string, string>();
    const select = {
      id: products.id,
      sku: products.sku,
      slug: products.slug,
    };
    const scope = eq(products.tenantId, tenantId);
    const remember = (p: { id: string; sku: string | null; slug: string }) => {
      byId.set(p.id, p.id);
      if (p.sku) bySku.set(p.sku, p.id);
      bySlug.set(p.slug, p.id);
    };
    for (const part of chunks([...wantIds]))
      (
        await tx
          .select(select)
          .from(products)
          .where(and(scope, inArray(products.id, part)))
      ).forEach(remember);
    for (const part of chunks([...wantSkus]))
      (
        await tx
          .select(select)
          .from(products)
          .where(and(scope, inArray(products.sku, part)))
      ).forEach(remember);
    for (const part of chunks([...wantSlugs]))
      (
        await tx
          .select(select)
          .from(products)
          .where(and(scope, inArray(products.slug, part)))
      ).forEach(remember);

    const links: PlannedLink[] = [];
    const seen = new Set<string>();
    for (const r of withProduct) {
      const ref = r.product!;
      const found = new Set<string>();
      let failed = false;
      const fail = (column: string, message: string, value: string) => {
        failed = true;
        errors.push({
          row: r.row,
          column,
          message,
          value: value.slice(0, 100),
        });
      };
      if (ref.id) {
        const id = byId.get(ref.id);
        if (id) found.add(id);
        else
          fail('product_id', 'No product of your store has this id.', ref.id);
      }
      if (ref.sku) {
        const id = bySku.get(ref.sku);
        if (id) found.add(id);
        else
          fail(
            'product_sku',
            'No product of your store has this SKU.',
            ref.sku,
          );
      }
      if (ref.slug) {
        const id = bySlug.get(ref.slug);
        if (id) found.add(id);
        else
          fail(
            'product_slug',
            'No product of your store has this slug.',
            ref.slug,
          );
      }
      if (failed) continue;
      if (found.size > 1) {
        fail(
          ref.id ? 'product_id' : ref.sku ? 'product_sku' : 'product_slug',
          'The product id, SKU and slug on this row name different products.',
          ref.id ?? ref.sku ?? ref.slug ?? '',
        );
        continue;
      }
      const level = levelAt(r.depth);
      if (level && !level.canHoldProducts) {
        fail(
          ref.id ? 'product_id' : ref.sku ? 'product_sku' : 'product_slug',
          `Items of the level "${level.name}" cannot carry products. Turn on can_hold_products for that level.`,
          ref.id ?? ref.sku ?? ref.slug ?? '',
        );
        continue;
      }
      const productId = [...found][0];
      const nodeKey = pathKey(r.keys);
      const dedupe = `${nodeKey}|${productId}`;
      if (seen.has(dedupe)) continue;
      seen.add(dedupe);
      links.push({
        nodeKey,
        productId,
        position: r.productPosition,
        row: r.row,
      });
    }
    return links;
  }

  /** The links that do not exist yet, with the position they will get. */
  private async newLinks(
    tx: DbTx,
    links: readonly PlannedLink[],
    nodeByKey: Map<string, PlannedNode>,
  ): Promise<(PlannedLink & { position: number })[]> {
    if (links.length === 0) return [];
    const existingNodeIds = [
      ...new Set(
        links
          .map((l) => nodeByKey.get(l.nodeKey)!)
          .filter((n) => n.existing)
          .map((n) => n.id),
      ),
    ];
    const productIds = [...new Set(links.map((l) => l.productId))];
    const have = new Set<string>();
    const next = new Map<string, number>();
    for (const nodePart of chunks(existingNodeIds, 200)) {
      for (const productPart of chunks(productIds)) {
        const rows = await tx
          .select({
            nodeId: catalogNodeProducts.nodeId,
            productId: catalogNodeProducts.productId,
          })
          .from(catalogNodeProducts)
          .where(
            and(
              inArray(catalogNodeProducts.nodeId, nodePart),
              inArray(catalogNodeProducts.productId, productPart),
            ),
          );
        for (const r of rows) have.add(`${r.nodeId}|${r.productId}`);
      }
      const max = await tx
        .select({
          nodeId: catalogNodeProducts.nodeId,
          max: sql<number>`max(${catalogNodeProducts.position})`,
        })
        .from(catalogNodeProducts)
        .where(inArray(catalogNodeProducts.nodeId, nodePart))
        .groupBy(catalogNodeProducts.nodeId);
      for (const m of max) next.set(m.nodeId, m.max + 1);
    }
    const out: (PlannedLink & { position: number })[] = [];
    for (const l of links) {
      const node = nodeByKey.get(l.nodeKey)!;
      if (node.existing && have.has(`${node.id}|${l.productId}`)) continue;
      const at = next.get(node.id) ?? 0;
      next.set(node.id, at + 1);
      out.push({ ...l, position: l.position ?? at });
    }
    return out;
  }

  // -------------------------------------------------------------------------------------------------------------------
  // Apply: the writes, inside the same transaction as the plan.
  // -------------------------------------------------------------------------------------------------------------------

  private async apply(
    tx: DbTx,
    tenantId: string,
    plan: Plan,
    hierarchyName: string,
  ) {
    let hierarchyId = plan.hierarchy?.id;
    if (!hierarchyId) {
      const [h] = await tx
        .insert(catalogHierarchies)
        .values({ tenantId, name: hierarchyName.slice(0, 80), status: 'draft' })
        .returning({ id: catalogHierarchies.id });
      hierarchyId = h.id;
    }
    for (const u of plan.levelsToUpdate)
      await tx
        .update(catalogLevels)
        .set({ canHoldProducts: u.canHoldProducts })
        .where(eq(catalogLevels.id, u.id));
    if (plan.levelsToCreate.length > 0)
      await tx.insert(catalogLevels).values(
        plan.levelsToCreate.map((l) => ({
          id: l.id,
          tenantId,
          hierarchyId: hierarchyId!,
          name: l.name,
          position: l.position,
          canHoldProducts: l.canHoldProducts,
        })),
      );

    const idOf = new Map(plan.nodes.map((n) => [n.key, n.id]));
    const maxDepth = Math.max(0, ...plan.nodes.map((n) => n.depth));
    for (let depth = 1; depth <= maxDepth; depth++) {
      const level = plan.nodes.filter((n) => n.depth === depth);
      const fresh = level.filter((n) => !n.existing);
      for (const part of chunks(fresh, 500))
        await tx.insert(catalogNodes).values(
          part.map((n) => ({
            id: n.id,
            tenantId,
            hierarchyId: hierarchyId!,
            levelId: plan.levelIds[depth - 1],
            parentId: n.parentKey ? idOf.get(n.parentKey)! : null,
            name: n.name,
            slug: n.slug,
            description: n.description,
            status: n.status,
            position: n.position,
          })),
        );
      for (const n of level)
        if (n.existing && n.update)
          await tx
            .update(catalogNodes)
            .set(n.update)
            .where(eq(catalogNodes.id, n.id));
    }

    const nodeId = (key: string) => idOf.get(key)!;
    for (const part of chunks(plan.newLinks, 2000))
      await tx
        .insert(catalogNodeProducts)
        .values(
          part.map((l) => ({
            tenantId,
            nodeId: nodeId(l.nodeKey),
            productId: l.productId,
            position: l.position,
          })),
        )
        .onConflictDoNothing();
  }

  // -------------------------------------------------------------------------------------------------------------------
  // Export
  // -------------------------------------------------------------------------------------------------------------------

  /**
   * The catalog as rows in the import format (export -> import changes nothing): one row per item and placed product, or
   * one row for an item without products, parents before children. Paged, because a catalog can be large. Text cells that a
   * spreadsheet could read as a formula carry a leading apostrophe, which the import removes again.
   */
  async export(
    ctx: OrgContext,
    q: CatalogExportQueryDto,
  ): Promise<CatalogExportDto> {
    return this.db.withUser(ctx.userId, async (tx) => {
      const h = await findHierarchy(tx, ctx.tenantId);
      if (!h) throw hierarchyNotFound();
      const levels = await levelsOf(tx, ctx.tenantId, h.id);
      const join = (t: typeof tx) =>
        t
          .select({
            nodeId: catalogNodes.id,
            pathIds: catalogNodes.pathIds,
            status: catalogNodes.status,
            description: catalogNodes.description,
            position: catalogNodes.position,
            productId: products.id,
            sku: products.sku,
            productSlug: products.slug,
            partNumber: products.partNumber,
            productName: products.name,
            productPosition: catalogNodeProducts.position,
          })
          .from(catalogNodes)
          .leftJoin(
            catalogNodeProducts,
            eq(catalogNodeProducts.nodeId, catalogNodes.id),
          )
          .leftJoin(products, eq(products.id, catalogNodeProducts.productId))
          .where(
            and(
              eq(catalogNodes.tenantId, ctx.tenantId),
              eq(catalogNodes.hierarchyId, h.id),
            ),
          );
      const [page, [{ total }]] = await Promise.all([
        join(tx)
          .orderBy(
            asc(catalogNodes.depth),
            asc(catalogNodes.position),
            asc(catalogNodes.name),
            asc(catalogNodes.id),
            asc(catalogNodeProducts.position),
            asc(products.id),
          )
          .limit(q.limit)
          .offset((q.page - 1) * q.limit),
        tx
          .select({ total: sql<number>`count(*)::int` })
          .from(catalogNodes)
          .leftJoin(
            catalogNodeProducts,
            eq(catalogNodeProducts.nodeId, catalogNodes.id),
          )
          .where(
            and(
              eq(catalogNodes.tenantId, ctx.tenantId),
              eq(catalogNodes.hierarchyId, h.id),
            ),
          ),
      ]);
      const ancestorIds = [...new Set(page.flatMap((r) => r.pathIds))];
      const names = new Map<string, string>();
      for (const part of chunks(ancestorIds))
        for (const r of await tx
          .select({ id: catalogNodes.id, name: catalogNodes.name })
          .from(catalogNodes)
          .where(inArray(catalogNodes.id, part)))
          names.set(r.id, r.name);

      const levelColumns = levels.map((_, i) => `level_${i + 1}`);
      const columns = [
        ...levelColumns,
        'status',
        'description',
        'position',
        'product_id',
        'product_sku',
        'product_slug',
        'product_position',
        'part_number',
        'product_name',
      ];
      const text = (v: string | null | undefined) =>
        v === null || v === undefined ? '' : escapeCell(v);
      const rows = page.map((r) => {
        const row: Record<string, string> = {};
        levelColumns.forEach((column, i) => {
          row[column] = text(names.get(r.pathIds[i]));
        });
        row.status = r.status;
        row.description = text(r.description);
        row.position = String(r.position);
        row.product_id = r.productId ?? '';
        row.product_sku = text(r.sku);
        row.product_slug = text(r.productSlug);
        row.product_position =
          r.productId === null ? '' : String(r.productPosition);
        row.part_number = text(r.partNumber);
        row.product_name = text(r.productName);
        return row;
      });
      return {
        hierarchy: { id: h.id, name: h.name, status: h.status },
        levels: levels.map((l) => ({
          name: escapeCell(l.name),
          can_hold_products: String(l.canHoldProducts),
        })),
        columns,
        rows,
        page: q.page,
        limit: q.limit,
        total,
        totalPages: Math.max(1, Math.ceil(total / q.limit)),
      };
    });
  }
}
