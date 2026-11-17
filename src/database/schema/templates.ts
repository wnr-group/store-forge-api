import {
  boolean,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uuid,
} from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';

/**
 * The template engine (migrations 0010-0016) and the Theme Store catalogue (0025).
 *
 * A `templates` row is one editable page layout of one store: a JSON `draft` plus the id of its latest published
 * version. `template_versions` is the immutable publish/rollback history. `themes` is the GLOBAL catalogue shared by
 * every tenant (read-only for the app role); `store_themes` records which theme a store applied.
 * Check constraints, composite foreign keys, triggers and RLS live in the SQL migrations.
 */
export const TEMPLATE_KINDS = [
  'index',
  'product',
  'collection',
  'theme_settings',
  'group_header',
  'group_footer',
  'group_announcement',
] as const;
export type TemplateKind = (typeof TEMPLATE_KINDS)[number];

/** Page kinds render a storefront page; the others are one-per-store shared documents. */
export const PAGE_TEMPLATE_KINDS = ['index', 'product', 'collection'] as const;

export const THEME_INDUSTRIES = [
  'fashion',
  'electronics',
  'beauty',
  'home',
  'grocery',
  'general',
] as const;
export type ThemeIndustry = (typeof THEME_INDUSTRIES)[number];

export const THEME_STATUSES = ['draft', 'published', 'archived'] as const;

export const templates = pgTable(
  'templates',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: uuid('tenant_id').notNull(),
    storeId: uuid('store_id').notNull(),
    kind: text('kind', { enum: TEMPLATE_KINDS }).notNull(),
    name: text('name').notNull(),
    status: text('status', { enum: ['active', 'archived'] })
      .notNull()
      .default('active'),
    isDefault: boolean('is_default').notNull().default(false),
    draft: jsonb('draft').$type<Record<string, unknown>>().notNull(),
    /** Bumped by a trigger whenever `draft` changes: the token for optimistic concurrency. */
    revision: integer('revision').notNull().default(1),
    publishedVersionId: uuid('published_version_id'),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    index('templates_store_kind_status_idx').on(
      t.tenantId,
      t.storeId,
      t.kind,
      t.status,
    ),
  ],
).enableRLS();

export const templateVersions = pgTable(
  'template_versions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: uuid('tenant_id').notNull(),
    storeId: uuid('store_id').notNull(),
    templateId: uuid('template_id').notNull(),
    /** Assigned by a trigger (strictly increasing per template). */
    versionNumber: integer('version_number').notNull(),
    document: jsonb('document').$type<Record<string, unknown>>().notNull(),
    source: text('source', {
      enum: ['publish', 'rollback', 'migration'],
    }).notNull(),
    rolledBackFrom: uuid('rolled_back_from'),
    /** Set by a trigger from the signed-in user. */
    publishedBy: uuid('published_by'),
    label: text('label'),
    publishedAt: timestamp('published_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    index('template_versions_template_idx').on(
      t.templateId,
      sql`${t.versionNumber} DESC NULLS LAST`,
    ),
  ],
).enableRLS();

export const themes = pgTable(
  'themes',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    slug: text('slug').notNull().unique(),
    name: text('name').notNull(),
    description: text('description').notNull().default(''),
    industry: text('industry', { enum: THEME_INDUSTRIES }).notNull(),
    version: integer('version').notNull().default(1),
    previewImage: text('preview_image'),
    status: text('status', { enum: THEME_STATUSES })
      .notNull()
      .default('published'),
    /** `{ <template kind>: <template document> }`. */
    documents: jsonb('documents')
      .$type<Partial<Record<TemplateKind, Record<string, unknown>>>>()
      .notNull(),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [index('themes_status_industry_idx').on(t.status, t.industry)],
).enableRLS();

export const storeThemes = pgTable(
  'store_themes',
  {
    storeId: uuid('store_id').primaryKey(),
    tenantId: uuid('tenant_id').notNull(),
    themeId: uuid('theme_id').notNull(),
    themeVersion: integer('theme_version').notNull(),
    appliedBy: uuid('applied_by'),
    appliedAt: timestamp('applied_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    index('store_themes_tenant_idx').on(t.tenantId),
    index('store_themes_theme_idx').on(t.themeId),
  ],
).enableRLS();

export type Template = typeof templates.$inferSelect;
export type TemplateVersion = typeof templateVersions.$inferSelect;
export type Theme = typeof themes.$inferSelect;
export type StoreTheme = typeof storeThemes.$inferSelect;

/** Content pages of a store (About, Contact...), migration 0026. Only `published` pages are visible to shoppers. */
export const STORE_PAGE_STATUSES = ['draft', 'published'] as const;
export type StorePageStatus = (typeof STORE_PAGE_STATUSES)[number];

export const storePages = pgTable(
  'store_pages',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: uuid('tenant_id').notNull(),
    storeId: uuid('store_id').notNull(),
    title: text('title').notNull(),
    slug: text('slug').notNull(),
    body: text('body').notNull().default(''),
    status: text('status').$type<StorePageStatus>().notNull().default('draft'),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    index('store_pages_tenant_store_idx').on(t.tenantId, t.storeId, t.status),
  ],
).enableRLS();

export type StorePage = typeof storePages.$inferSelect;
