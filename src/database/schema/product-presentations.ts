import {
  index,
  integer,
  jsonb,
  pgTable,
  timestamp,
  uuid,
} from 'drizzle-orm/pg-core';

/**
 * Per-product presentation overrides (migration 0032): a JSON `draft` and the live `published` copy, one row per
 * customised product. Catalogue fields never live here. Check constraints, composite foreign keys, triggers and RLS
 * are in the SQL migration. A product without a row inherits the store's default theme and product page.
 */
export const productPresentations = pgTable(
  'product_presentations',
  {
    productId: uuid('product_id').primaryKey(),
    tenantId: uuid('tenant_id').notNull(),
    storeId: uuid('store_id').notNull(),
    draft: jsonb('draft')
      .$type<Record<string, unknown>>()
      .notNull()
      .default({ schemaVersion: 1 }),
    /** NULL until first published. Public reads use this column only. */
    published: jsonb('published').$type<Record<string, unknown> | null>(),
    /** Bumped by a trigger whenever `draft` changes: the token for optimistic concurrency. */
    revision: integer('revision').notNull().default(1),
    /** Set by a trigger when `published` changes. */
    publishedAt: timestamp('published_at', { withTimezone: true }),
    publishedBy: uuid('published_by'),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [index('product_presentations_store_idx').on(t.tenantId, t.storeId)],
).enableRLS();

export type ProductPresentation = typeof productPresentations.$inferSelect;
