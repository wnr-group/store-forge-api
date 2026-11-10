import { sql } from 'drizzle-orm';
import {
  bigint,
  boolean,
  check,
  foreignKey,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  text,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
  type AnyPgColumn,
} from 'drizzle-orm/pg-core';
import { authUsers } from 'drizzle-orm/supabase';
import {
  CATALOG_SLUG_PATTERN,
  COLLECTION_STATUSES,
  INVENTORY_REASONS,
  PRODUCT_STATUSES,
} from './enums.js';
import { tenants } from './tenants.js';

/**
 * Catalog tables. Conventions:
 *  - every row carries tenant_id (RLS key);
 *  - children reference their parent through (tenant_id, id) composite foreign
 *    keys, so a child can never point at another tenant's parent - even for a
 *    privileged writer;
 *  - money is stored as integer minor units (e.g. paise/cents) in the store's currency;
 *  - policies, grants, triggers and the storage bucket live in custom SQL migrations.
 */

const tenantId = () =>
  uuid('tenant_id')
    .notNull()
    .references(() => tenants.id, { onDelete: 'cascade' });
const createdAt = () =>
  timestamp('created_at', { withTimezone: true }).notNull().defaultNow();
const updatedAt = () =>
  timestamp('updated_at', { withTimezone: true }).notNull().defaultNow();
const minor = (name: string) => bigint(name, { mode: 'number' });
const slugCheck = (name: string, col: AnyPgColumn) =>
  check(
    name,
    sql`char_length(${col}) between 2 and 80 and ${col} ~ ${sql.raw(`'${CATALOG_SLUG_PATTERN}'`)}`,
  );

export const categories = pgTable(
  'categories',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: tenantId(),
    parentId: uuid('parent_id').references((): AnyPgColumn => categories.id, {
      onDelete: 'set null',
    }),
    name: text('name').notNull(),
    slug: text('slug').notNull(),
    description: text('description'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    unique('categories_tenant_id_id_key').on(t.tenantId, t.id),
    unique('categories_tenant_id_slug_key').on(t.tenantId, t.slug),
    check(
      'categories_name_check',
      sql`char_length(btrim(${t.name})) between 1 and 80`,
    ),
    slugCheck('categories_slug_check', t.slug),
    check(
      'categories_description_check',
      sql`${t.description} is null or char_length(${t.description}) <= 1000`,
    ),
    check(
      'categories_parent_check',
      sql`${t.parentId} is null or ${t.parentId} <> ${t.id}`,
    ),
    index('categories_parent_id_idx').on(t.parentId),
  ],
).enableRLS();

export const collections = pgTable(
  'collections',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: tenantId(),
    name: text('name').notNull(),
    slug: text('slug').notNull(),
    description: text('description'),
    /** Object path in the `products` bucket: `{tenant_id}/collections/{id}/...` */
    imagePath: text('image_path'),
    status: text('status', { enum: COLLECTION_STATUSES })
      .notNull()
      .default('draft'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    unique('collections_tenant_id_id_key').on(t.tenantId, t.id),
    unique('collections_tenant_id_slug_key').on(t.tenantId, t.slug),
    check(
      'collections_name_check',
      sql`char_length(btrim(${t.name})) between 1 and 80`,
    ),
    slugCheck('collections_slug_check', t.slug),
    check(
      'collections_description_check',
      sql`${t.description} is null or char_length(${t.description}) <= 1000`,
    ),
    check('collections_status_check', sql`${t.status} in ('draft', 'active')`),
    check(
      'collections_image_path_check',
      sql`${t.imagePath} is null or ${t.imagePath} like ${t.tenantId}::text || '/collections/' || ${t.id}::text || '/%'`,
    ),
  ],
).enableRLS();

export const products = pgTable(
  'products',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: tenantId(),
    categoryId: uuid('category_id').references(() => categories.id, {
      onDelete: 'set null',
    }),
    name: text('name').notNull(),
    slug: text('slug').notNull(),
    description: text('description'),
    shortDescription: text('short_description'),
    productType: text('product_type'),
    /** Used when the product has no variants. With variants, SKU/price/stock live on the variants. */
    sku: text('sku'),
    priceMinor: minor('price_minor').notNull().default(0),
    compareAtPriceMinor: minor('compare_at_price_minor'),
    costMinor: minor('cost_minor'),
    hasVariants: boolean('has_variants').notNull().default(false),
    trackInventory: boolean('track_inventory').notNull().default(true),
    quantity: integer('quantity').notNull().default(0),
    lowStockThreshold: integer('low_stock_threshold').notNull().default(5),
    status: text('status', { enum: PRODUCT_STATUSES })
      .notNull()
      .default('draft'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    unique('products_tenant_id_id_key').on(t.tenantId, t.id),
    unique('products_tenant_id_slug_key').on(t.tenantId, t.slug),
    uniqueIndex('products_tenant_id_sku_key')
      .on(t.tenantId, t.sku)
      .where(sql`${t.sku} is not null`),
    check(
      'products_name_check',
      sql`char_length(btrim(${t.name})) between 1 and 200`,
    ),
    slugCheck('products_slug_check', t.slug),
    check(
      'products_description_check',
      sql`${t.description} is null or char_length(${t.description}) <= 20000`,
    ),
    check(
      'products_short_description_check',
      sql`${t.shortDescription} is null or char_length(${t.shortDescription}) <= 300`,
    ),
    check(
      'products_product_type_check',
      sql`${t.productType} is null or char_length(${t.productType}) <= 80`,
    ),
    check(
      'products_sku_check',
      sql`${t.sku} is null or char_length(${t.sku}) between 1 and 64`,
    ),
    check(
      'products_price_check',
      sql`${t.priceMinor} between 0 and 100000000000`,
    ),
    check(
      'products_compare_at_check',
      sql`${t.compareAtPriceMinor} is null or ${t.compareAtPriceMinor} between 0 and 100000000000`,
    ),
    check(
      'products_cost_check',
      sql`${t.costMinor} is null or ${t.costMinor} between 0 and 100000000000`,
    ),
    check('products_quantity_check', sql`${t.quantity} >= 0`),
    check('products_low_stock_check', sql`${t.lowStockThreshold} >= 0`),
    check('products_status_check', sql`${t.status} in ('draft', 'active')`),
    index('products_tenant_status_idx').on(t.tenantId, t.status),
    index('products_tenant_created_idx').on(t.tenantId, t.createdAt.desc()),
    index('products_category_id_idx').on(t.categoryId),
  ],
).enableRLS();

export const productImages = pgTable(
  'product_images',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: tenantId(),
    productId: uuid('product_id').notNull(),
    /** Object path in the `products` bucket: `{tenant_id}/{product_id}/{file}` (enforced below). */
    storagePath: text('storage_path').notNull(),
    altText: text('alt_text'),
    position: integer('position').notNull().default(0),
    isPrimary: boolean('is_primary').notNull().default(false),
    mimeType: text('mime_type').notNull(),
    sizeBytes: integer('size_bytes').notNull(),
    createdAt: createdAt(),
  },
  (t) => [
    foreignKey({
      columns: [t.tenantId, t.productId],
      foreignColumns: [products.tenantId, products.id],
      name: 'product_images_product_fk',
    }).onDelete('cascade'),
    unique('product_images_storage_path_key').on(t.storagePath),
    unique('product_images_tenant_id_id_key').on(t.tenantId, t.id),
    uniqueIndex('product_images_one_primary_idx')
      .on(t.productId)
      .where(sql`${t.isPrimary}`),
    check(
      'product_images_path_check',
      sql`${t.storagePath} like ${t.tenantId}::text || '/' || ${t.productId}::text || '/%' and ${t.storagePath} !~ '\\.\\.'`,
    ),
    check(
      'product_images_mime_check',
      sql`${t.mimeType} in ('image/jpeg', 'image/png', 'image/webp')`,
    ),
    check(
      'product_images_size_check',
      sql`${t.sizeBytes} between 1 and 10485760`,
    ),
    check(
      'product_images_alt_check',
      sql`${t.altText} is null or char_length(${t.altText}) <= 300`,
    ),
    index('product_images_product_id_idx').on(t.productId, t.position),
  ],
).enableRLS();

export const productOptions = pgTable(
  'product_options',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: tenantId(),
    productId: uuid('product_id').notNull(),
    name: text('name').notNull(),
    position: integer('position').notNull().default(0),
    values: text('values').array().notNull(),
  },
  (t) => [
    foreignKey({
      columns: [t.tenantId, t.productId],
      foreignColumns: [products.tenantId, products.id],
      name: 'product_options_product_fk',
    }).onDelete('cascade'),
    unique('product_options_product_id_name_key').on(t.productId, t.name),
    check(
      'product_options_name_check',
      sql`char_length(btrim(${t.name})) between 1 and 40`,
    ),
    check(
      'product_options_values_check',
      sql`cardinality(${t.values}) between 1 and 50`,
    ),
    index('product_options_product_id_idx').on(t.productId),
  ],
).enableRLS();

export const productVariants = pgTable(
  'product_variants',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: tenantId(),
    productId: uuid('product_id').notNull(),
    title: text('title').notNull(),
    /** e.g. {"Size":"M","Color":"Black"} */
    options: jsonb('options').$type<Record<string, string>>().notNull(),
    sku: text('sku'),
    priceMinor: minor('price_minor').notNull().default(0),
    compareAtPriceMinor: minor('compare_at_price_minor'),
    quantity: integer('quantity').notNull().default(0),
    imageId: uuid('image_id').references(() => productImages.id, {
      onDelete: 'set null',
    }),
    isActive: boolean('is_active').notNull().default(true),
    position: integer('position').notNull().default(0),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    foreignKey({
      columns: [t.tenantId, t.productId],
      foreignColumns: [products.tenantId, products.id],
      name: 'product_variants_product_fk',
    }).onDelete('cascade'),
    unique('product_variants_tenant_id_id_key').on(t.tenantId, t.id),
    unique('product_variants_product_id_options_key').on(
      t.productId,
      t.options,
    ),
    uniqueIndex('product_variants_tenant_id_sku_key')
      .on(t.tenantId, t.sku)
      .where(sql`${t.sku} is not null`),
    check(
      'product_variants_title_check',
      sql`char_length(btrim(${t.title})) between 1 and 200`,
    ),
    check(
      'product_variants_sku_check',
      sql`${t.sku} is null or char_length(${t.sku}) between 1 and 64`,
    ),
    check(
      'product_variants_price_check',
      sql`${t.priceMinor} between 0 and 100000000000`,
    ),
    check(
      'product_variants_compare_at_check',
      sql`${t.compareAtPriceMinor} is null or ${t.compareAtPriceMinor} between 0 and 100000000000`,
    ),
    check('product_variants_quantity_check', sql`${t.quantity} >= 0`),
    index('product_variants_product_id_idx').on(t.productId, t.position),
  ],
).enableRLS();

export const collectionProducts = pgTable(
  'collection_products',
  {
    tenantId: tenantId(),
    collectionId: uuid('collection_id').notNull(),
    productId: uuid('product_id').notNull(),
    position: integer('position').notNull().default(0),
    createdAt: createdAt(),
  },
  (t) => [
    primaryKey({
      name: 'collection_products_pkey',
      columns: [t.collectionId, t.productId],
    }),
    foreignKey({
      columns: [t.tenantId, t.collectionId],
      foreignColumns: [collections.tenantId, collections.id],
      name: 'collection_products_collection_fk',
    }).onDelete('cascade'),
    foreignKey({
      columns: [t.tenantId, t.productId],
      foreignColumns: [products.tenantId, products.id],
      name: 'collection_products_product_fk',
    }).onDelete('cascade'),
    index('collection_products_product_id_idx').on(t.productId),
  ],
).enableRLS();

/** Append-only stock ledger. Rows are written together with the quantity change in one transaction. */
export const inventoryAdjustments = pgTable(
  'inventory_adjustments',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: tenantId(),
    productId: uuid('product_id').notNull(),
    variantId: uuid('variant_id'),
    delta: integer('delta').notNull(),
    quantityAfter: integer('quantity_after').notNull(),
    reason: text('reason', { enum: INVENTORY_REASONS }).notNull(),
    note: text('note'),
    createdBy: uuid('created_by').references(() => authUsers.id, {
      onDelete: 'set null',
    }),
    createdAt: createdAt(),
  },
  (t) => [
    foreignKey({
      columns: [t.tenantId, t.productId],
      foreignColumns: [products.tenantId, products.id],
      name: 'inventory_adjustments_product_fk',
    }).onDelete('cascade'),
    foreignKey({
      columns: [t.tenantId, t.variantId],
      foreignColumns: [productVariants.tenantId, productVariants.id],
      name: 'inventory_adjustments_variant_fk',
    }).onDelete('cascade'),
    check('inventory_adjustments_delta_check', sql`${t.delta} <> 0`),
    check(
      'inventory_adjustments_quantity_after_check',
      sql`${t.quantityAfter} >= 0`,
    ),
    check(
      'inventory_adjustments_reason_check',
      sql`${t.reason} in ('restock', 'correction', 'return', 'damage', 'sale', 'other')`,
    ),
    check(
      'inventory_adjustments_note_check',
      sql`${t.note} is null or char_length(${t.note}) <= 500`,
    ),
    index('inventory_adjustments_product_idx').on(
      t.productId,
      t.createdAt.desc(),
    ),
    index('inventory_adjustments_tenant_created_idx').on(
      t.tenantId,
      t.createdAt.desc(),
    ),
  ],
).enableRLS();

export type Category = typeof categories.$inferSelect;
export type Collection = typeof collections.$inferSelect;
export type Product = typeof products.$inferSelect;
export type ProductImage = typeof productImages.$inferSelect;
export type ProductOption = typeof productOptions.$inferSelect;
export type ProductVariant = typeof productVariants.$inferSelect;
export type InventoryAdjustment = typeof inventoryAdjustments.$inferSelect;
