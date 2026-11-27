import { sql } from 'drizzle-orm';
import {
  boolean,
  check,
  foreignKey,
  index,
  integer,
  pgTable,
  primaryKey,
  text,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { CATALOG_STATUSES } from './enums.js';
import { products } from './catalog.js';
import { tenants } from './tenants.js';

/**
 * Catalog hierarchy (migrations 0072 / 0073): a configurable tree (Brand > Vehicle > Variant > ...) that products can be
 * placed on, separate from categories and collections. The same conventions as catalog.ts apply (tenant_id on every row,
 * composite foreign keys). The integrity rules (level order, cycles, path and depth, products only on levels that allow
 * them) are database triggers in the migration, so they hold for every writer, not only this API.
 */

const tenantId = () =>
  uuid('tenant_id')
    .notNull()
    .references(() => tenants.id, { onDelete: 'cascade' });
const createdAt = () =>
  timestamp('created_at', { withTimezone: true }).notNull().defaultNow();
const updatedAt = () =>
  timestamp('updated_at', { withTimezone: true }).notNull().defaultNow();

/** One per organization for now (the unique index on tenant_id); every other table carries hierarchy_id so that can change. */
export const catalogHierarchies = pgTable(
  'catalog_hierarchies',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: tenantId(),
    name: text('name').notNull(),
    status: text('status', { enum: CATALOG_STATUSES })
      .notNull()
      .default('draft'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    unique('catalog_hierarchies_tenant_id_id_key').on(t.tenantId, t.id),
    uniqueIndex('catalog_hierarchies_one_per_tenant_idx').on(t.tenantId),
    check(
      'catalog_hierarchies_name_check',
      sql`char_length(btrim(${t.name})) between 1 and 80`,
    ),
    check(
      'catalog_hierarchies_status_check',
      sql`${t.status} in ('draft', 'active')`,
    ),
  ],
).enableRLS();

/** The named levels of a hierarchy, numbered 1..n without gaps (enforced by a deferred constraint trigger). */
export const catalogLevels = pgTable(
  'catalog_levels',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: tenantId(),
    hierarchyId: uuid('hierarchy_id').notNull(),
    name: text('name').notNull(),
    position: integer('position').notNull(),
    canHoldProducts: boolean('can_hold_products').notNull().default(false),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    unique('catalog_levels_tenant_id_id_key').on(t.tenantId, t.id),
    unique('catalog_levels_tenant_hierarchy_id_key').on(
      t.tenantId,
      t.hierarchyId,
      t.id,
    ),
    foreignKey({
      columns: [t.tenantId, t.hierarchyId],
      foreignColumns: [catalogHierarchies.tenantId, catalogHierarchies.id],
      name: 'catalog_levels_hierarchy_fk',
    }).onDelete('cascade'),
    check(
      'catalog_levels_name_check',
      sql`char_length(btrim(${t.name})) between 1 and 60`,
    ),
    check('catalog_levels_position_check', sql`${t.position} between 1 and 20`),
  ],
).enableRLS();

/**
 * The tree. `pathIds` (ids from the root down to this node) and `depth` are filled in by a trigger; the client can never
 * write them. A root is on level 1 and a child is on the level right after its parent's.
 */
export const catalogNodes = pgTable(
  'catalog_nodes',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: tenantId(),
    hierarchyId: uuid('hierarchy_id').notNull(),
    levelId: uuid('level_id').notNull(),
    parentId: uuid('parent_id'),
    name: text('name').notNull(),
    slug: text('slug').notNull(),
    description: text('description'),
    position: integer('position').notNull().default(0),
    status: text('status', { enum: CATALOG_STATUSES })
      .notNull()
      .default('draft'),
    seoTitle: text('seo_title'),
    seoDescription: text('seo_description'),
    /** One optional image: `{tenant_id}/catalog/{id}/{file}` in the `products` bucket (migration 0074). */
    imagePath: text('image_path'),
    imageAlt: text('image_alt'),
    pathIds: uuid('path_ids')
      .array()
      .notNull()
      .default(sql`'{}'::uuid[]`),
    depth: integer('depth').notNull().default(1),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    unique('catalog_nodes_tenant_id_id_key').on(t.tenantId, t.id),
    unique('catalog_nodes_tenant_hierarchy_id_key').on(
      t.tenantId,
      t.hierarchyId,
      t.id,
    ),
    foreignKey({
      columns: [t.tenantId, t.hierarchyId],
      foreignColumns: [catalogHierarchies.tenantId, catalogHierarchies.id],
      name: 'catalog_nodes_hierarchy_fk',
    }).onDelete('cascade'),
    foreignKey({
      columns: [t.tenantId, t.hierarchyId, t.levelId],
      foreignColumns: [
        catalogLevels.tenantId,
        catalogLevels.hierarchyId,
        catalogLevels.id,
      ],
      name: 'catalog_nodes_level_fk',
    }),
    foreignKey({
      columns: [t.tenantId, t.hierarchyId, t.parentId],
      foreignColumns: [t.tenantId, t.hierarchyId, t.id],
      name: 'catalog_nodes_parent_fk',
    }),
    uniqueIndex('catalog_nodes_root_slug_key')
      .on(t.hierarchyId, t.slug)
      .where(sql`${t.parentId} is null`),
    uniqueIndex('catalog_nodes_child_slug_key')
      .on(t.parentId, t.slug)
      .where(sql`${t.parentId} is not null`),
    index('catalog_nodes_children_idx').on(
      t.tenantId,
      t.hierarchyId,
      t.parentId,
      t.position,
      t.name,
    ),
    index('catalog_nodes_level_idx').on(t.levelId),
    index('catalog_nodes_path_ids_idx').using('gin', t.pathIds),
    index('catalog_nodes_image_path_idx')
      .on(t.tenantId, t.imagePath)
      .where(sql`${t.imagePath} is not null`),
    check(
      'catalog_nodes_image_path_check',
      sql`${t.imagePath} is null or (${t.imagePath} like ${t.tenantId}::text || '/catalog/' || ${t.id}::text || '/%' and ${t.imagePath} !~ '\\.\\.' and char_length(${t.imagePath}) <= 300)`,
    ),
    check(
      'catalog_nodes_image_alt_check',
      sql`${t.imageAlt} is null or (${t.imagePath} is not null and char_length(btrim(${t.imageAlt})) between 1 and 200)`,
    ),
    check(
      'catalog_nodes_name_check',
      sql`char_length(btrim(${t.name})) between 1 and 120`,
    ),
    check(
      'catalog_nodes_slug_check',
      sql`char_length(${t.slug}) between 1 and 80 and ${t.slug} ~ '^[a-z0-9]+(-[a-z0-9]+)*$'`,
    ),
    check(
      'catalog_nodes_description_check',
      sql`${t.description} is null or char_length(${t.description}) <= 2000`,
    ),
    check(
      'catalog_nodes_position_check',
      sql`${t.position} between 0 and 1000000`,
    ),
    check(
      'catalog_nodes_status_check',
      sql`${t.status} in ('draft', 'active')`,
    ),
    check(
      'catalog_nodes_parent_check',
      sql`${t.parentId} is null or ${t.parentId} <> ${t.id}`,
    ),
  ],
).enableRLS();

/** The many-to-many link: a product can sit on any number of nodes without being copied. */
export const catalogNodeProducts = pgTable(
  'catalog_node_products',
  {
    tenantId: tenantId(),
    nodeId: uuid('node_id').notNull(),
    productId: uuid('product_id').notNull(),
    position: integer('position').notNull().default(0),
    createdAt: createdAt(),
  },
  (t) => [
    primaryKey({
      name: 'catalog_node_products_pkey',
      columns: [t.nodeId, t.productId],
    }),
    foreignKey({
      columns: [t.tenantId, t.nodeId],
      foreignColumns: [catalogNodes.tenantId, catalogNodes.id],
      name: 'catalog_node_products_node_fk',
    }).onDelete('cascade'),
    foreignKey({
      columns: [t.tenantId, t.productId],
      foreignColumns: [products.tenantId, products.id],
      name: 'catalog_node_products_product_fk',
    }).onDelete('cascade'),
    index('catalog_node_products_node_idx').on(
      t.tenantId,
      t.nodeId,
      t.position,
    ),
    index('catalog_node_products_product_idx').on(t.productId),
  ],
).enableRLS();

export type CatalogHierarchy = typeof catalogHierarchies.$inferSelect;
export type CatalogLevel = typeof catalogLevels.$inferSelect;
export type CatalogNode = typeof catalogNodes.$inferSelect;
export type CatalogNodeProduct = typeof catalogNodeProducts.$inferSelect;
