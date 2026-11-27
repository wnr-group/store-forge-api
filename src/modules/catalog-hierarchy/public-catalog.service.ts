import { Injectable } from '@nestjs/common';
import { sql } from 'drizzle-orm';
import { notFound } from '../../common/app.exception.js';
import { DatabaseService, rowsOf } from '../../database/database.service.js';
import type {
  PublicCatalogNodeDetailDto,
  PublicCatalogNodeDto,
  PublicCatalogNodePageDto,
  PublicCatalogNodeQueryDto,
  PublicCatalogTreeDto,
} from './public-catalog.dto.js';

interface RawStore {
  name: string;
  slug: string;
  currency: string;
  description?: string | null;
  logo_path?: string | null;
}
interface RawNode {
  id: string;
  parent_id: string | null;
  level_id: string;
  name: string;
  slug: string;
  path: string;
  description: string | null;
  position: number;
  depth: number;
  seo_title?: string | null;
  seo_description?: string | null;
  image_path?: string | null;
  image_alt?: string | null;
  has_children: boolean;
  product_count: number;
}
interface RawLevel {
  id: string;
  name: string;
  position: number;
  can_hold_products: boolean;
}
interface RawTree {
  store: RawStore;
  hierarchy: { id: string; name: string } | null;
  levels: RawLevel[];
  nodes: RawNode[];
  truncated: boolean;
}
interface RawNodePage {
  store: RawStore;
  hierarchy: { id: string; name: string };
  node: {
    id: string;
    parent_id: string | null;
    level_id: string;
    name: string;
    slug: string;
    description: string | null;
    position: number;
    path: string;
    depth: number;
    seo_title: string | null;
    seo_description: string | null;
    image_path?: string | null;
    image_alt?: string | null;
    has_children: boolean;
    product_count: number;
    level: RawLevel;
  };
  breadcrumbs: {
    id: string;
    name: string;
    slug: string;
    path: string;
    depth: number;
    level_id: string;
    level_name: string;
  }[];
  children: RawNode[];
  products: {
    items: {
      name: string;
      slug: string;
      part_number: string | null;
      short_description: string | null;
      price_minor: number;
      compare_at_price_minor: number | null;
      image_path: string | null;
      available: boolean;
    }[];
    page: number;
    limit: number;
    total: number;
    include_descendants: boolean;
  };
}

const SEGMENT = /^[a-z0-9]+(-[a-z0-9]+)*$/;

const parse = <T>(raw: unknown): T =>
  (typeof raw === 'string' ? JSON.parse(raw) : raw) as T;

const level = (l: RawLevel) => ({
  id: l.id,
  name: l.name,
  position: l.position,
  canHoldProducts: l.can_hold_products,
});

const node = (n: RawNode): PublicCatalogNodeDto => ({
  id: n.id,
  parentId: n.parent_id,
  levelId: n.level_id,
  name: n.name,
  slug: n.slug,
  path: n.path,
  description: n.description,
  position: n.position,
  depth: n.depth,
  seoTitle: n.seo_title ?? null,
  seoDescription: n.seo_description ?? null,
  imagePath: n.image_path ?? null,
  imageAlt: n.image_alt ?? null,
  hasChildren: n.has_children,
  productCount: Number(n.product_count),
});

const store = (s: RawStore) => ({
  name: s.name,
  slug: s.slug,
  currency: s.currency,
  description: s.description ?? null,
  logoPath: s.logo_path ?? null,
});

/**
 * Anonymous reads of the catalog hierarchy. Like every public read they go through narrow SECURITY DEFINER functions
 * (migration 0073): they only ever return ACTIVE data of an active store, and nothing is read from the tables directly.
 */
@Injectable()
export class PublicCatalogService {
  constructor(private readonly db: DatabaseService) {}

  async tree(slug: string, maxDepth?: number): Promise<PublicCatalogTreeDto> {
    const raw = await this.db.withPublic(
      async (tx) =>
        rowsOf<{ t: unknown }>(
          await tx.execute(
            sql`select public.get_public_catalog_tree(${slug}, ${maxDepth ?? null}::integer) as t`,
          ),
        )[0]?.t,
    );
    if (raw === null || raw === undefined)
      throw notFound('Store not found.', 'STORE_NOT_FOUND');
    const t = parse<RawTree>(raw);
    return {
      store: store(t.store),
      hierarchy: t.hierarchy,
      levels: t.levels.map(level),
      nodes: t.nodes.map(node),
      truncated: t.truncated,
    };
  }

  /** `segments` are the slugs from the top level down. Anything that is not a valid slug path is simply "not found". */
  async node(
    slug: string,
    segments: string[],
    q: PublicCatalogNodeQueryDto,
  ): Promise<PublicCatalogNodePageDto> {
    const missing = () =>
      notFound('Catalog item not found.', 'CATALOG_NODE_NOT_FOUND');
    if (
      segments.length < 1 ||
      segments.length > 20 ||
      !segments.every((s) => s.length <= 80 && SEGMENT.test(s))
    )
      throw missing();
    const raw = await this.db.withPublic(
      async (tx) =>
        rowsOf<{ n: unknown }>(
          await tx.execute(
            sql`select public.get_public_catalog_node(${slug}, ${segments.join('/')}, ${q.page}::integer, ${q.limit}::integer, ${q.includeDescendants}::boolean, ${q.sort}) as n`,
          ),
        )[0]?.n,
    );
    if (raw === null || raw === undefined) throw missing();
    const p = parse<RawNodePage>(raw);
    const detail: PublicCatalogNodeDetailDto = {
      id: p.node.id,
      parentId: p.node.parent_id,
      levelId: p.node.level_id,
      name: p.node.name,
      slug: p.node.slug,
      path: p.node.path,
      description: p.node.description,
      position: p.node.position,
      depth: p.node.depth,
      seoTitle: p.node.seo_title,
      seoDescription: p.node.seo_description,
      imagePath: p.node.image_path ?? null,
      imageAlt: p.node.image_alt ?? null,
      hasChildren: p.node.has_children,
      productCount: Number(p.node.product_count),
      level: level(p.node.level),
    };
    return {
      store: store(p.store),
      hierarchy: p.hierarchy,
      node: detail,
      breadcrumbs: p.breadcrumbs.map((b) => ({
        id: b.id,
        name: b.name,
        slug: b.slug,
        path: b.path,
        depth: b.depth,
        levelId: b.level_id,
        levelName: b.level_name,
      })),
      children: p.children.map(node),
      products: {
        items: p.products.items.map((x) => ({
          name: x.name,
          slug: x.slug,
          partNumber: x.part_number,
          shortDescription: x.short_description,
          priceMinor: x.price_minor,
          compareAtPriceMinor: x.compare_at_price_minor,
          imagePath: x.image_path,
          available: x.available,
        })),
        page: p.products.page,
        limit: p.products.limit,
        total: Number(p.products.total),
        includeDescendants: p.products.include_descendants,
      },
    };
  }
}
