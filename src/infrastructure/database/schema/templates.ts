// GENERATED from wnr-group/store-forge lib/db/schema/templates.ts. DO NOT EDIT.

import { sql } from "drizzle-orm";
import { boolean, check, foreignKey, index, integer, jsonb, pgTable, text, timestamp, unique, uniqueIndex, uuid, type PgTableExtraConfigValue } from "drizzle-orm/pg-core";
import { authUsers } from "drizzle-orm/supabase";
import { TEMPLATE_KINDS, TEMPLATE_STATUSES, VERSION_SOURCES, type TemplateDocument } from "../template-deps/document.js";
import { LIMITS } from "../template-deps/limits.js";
import { collections, products } from "./catalog.js";
import { stores } from "./stores.js";

const kindList = sql.raw(TEMPLATE_KINDS.map((k) => `'${k}'`).join(", "));
const pageKindList = sql.raw("'index', 'product', 'collection'");
const singletonKindList = sql.raw("'theme_settings', 'group_header', 'group_footer', 'group_announcement'");

/** An object with an integer schemaVersion of at least 1 and at most the document size limit (D6). Registry rules live in the app validator. */
const documentCheck = (name: string, col: unknown) =>
  check(
    name,
    sql`jsonb_typeof(${col}) = 'object'
      and coalesce(jsonb_typeof(${col} -> 'schemaVersion') = 'number' and (${col} ->> 'schemaVersion') ~ '^[1-9][0-9]*$', false)
      and octet_length(${col}::text) <= ${sql.raw(String(LIMITS.maxDocumentBytes))}`,
  );

/**
 * Store Forge Template Engine - Ownership Model (Multi-Store Option A, R6, AC-DB-021):
 *
 * 1. Catalog entities (Products & Collections) are TENANT-WIDE:
 *    - Owned by the tenant (`tenant_id`), shared across all stores within that tenant.
 *    - Products and collections do NOT carry a `store_id`, and there are no store-product
 *      or store-collection membership tables.
 *
 * 2. Templates & Template Assignments are STORE-SCOPED:
 *    - Owned by a specific store (`tenant_id`, `store_id`).
 *    - A template belongs to exactly one store.
 *    - An assignment maps a template in that store to a product or collection in the same tenant.
 *
 * 3. Assignment & Cross-Store Boundaries:
 *    - Cross-store template assignment is strictly rejected: a template created in Store 1
 *      cannot be assigned to a product in Store 2, even within the same tenant.
 *    - Cross-tenant template assignment is strictly rejected.
 *    - Both violations fail with an explicit SQLSTATE 23503 error:
 *      "template does not belong to this store" (migration 0015, AC-DB-011).
 *    - Within a multi-store tenant, each store independently assigns templates to the same shared
 *      product (e.g., Store 1 uses Template A, Store 2 uses Template B for Product X).
 */

/**
 * One row per template: the mutable draft and a pointer to the published version (D3).
 * `status` is lifecycle only (active or archived); published or draft is derived from `published_version_id`
 * (see template_publication_state()). `revision` is bumped by a trigger whenever `draft` changes and cannot
 * be written by the app, so a stale write is always detectable with `where revision = :seen`.
 * `kind` can never change (not grantable, and the assignment FK includes it).
 */
export const templates = pgTable(
  "templates",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id").notNull(),
    storeId: uuid("store_id").notNull(),
    kind: text("kind", { enum: TEMPLATE_KINDS }).notNull(),
    name: text("name").notNull(),
    status: text("status", { enum: TEMPLATE_STATUSES }).notNull().default("active"),
    isDefault: boolean("is_default").notNull().default(false),
    draft: jsonb("draft").$type<TemplateDocument>().notNull(),
    revision: integer("revision").notNull().default(1),
    publishedVersionId: uuid("published_version_id"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t): PgTableExtraConfigValue[] => [
    foreignKey({ columns: [t.tenantId, t.storeId], foreignColumns: [stores.tenantId, stores.id], name: "templates_store_fk" }).onDelete("cascade"),
    // The pointer must name a version of this same template.
    foreignKey({ columns: [t.id, t.publishedVersionId], foreignColumns: [templateVersions.templateId, templateVersions.id], name: "templates_published_version_fk" }),
    unique("templates_tenant_store_id_key").on(t.tenantId, t.storeId, t.id),
    unique("templates_tenant_store_id_kind_key").on(t.tenantId, t.storeId, t.id, t.kind),
    check("templates_kind_check", sql`${t.kind} in (${kindList})`),
    check("templates_status_check", sql`${t.status} in ('active', 'archived')`),
    check("templates_name_check", sql`char_length(btrim(${t.name})) between 1 and ${sql.raw(String(LIMITS.maxNameLength))}`),
    check("templates_revision_check", sql`${t.revision} >= 1`),
    check("templates_default_kind_check", sql`not ${t.isDefault} or ${t.kind} in (${pageKindList})`),
    check("templates_default_active_check", sql`not ${t.isDefault} or ${t.status} = 'active'`),
    documentCheck("templates_draft_check", t.draft),
    // At most one default per page kind, and one document per shared kind, per store (D7, D8).
    uniqueIndex("templates_one_default_idx").on(t.storeId, t.kind).where(sql`${t.isDefault}`),
    uniqueIndex("templates_one_shared_idx").on(t.storeId, t.kind).where(sql`${t.kind} in (${singletonKindList})`),
    index("templates_store_kind_status_idx").on(t.tenantId, t.storeId, t.kind, t.status),
  ],
).enableRLS();

/**
 * Immutable publish history (D3, D16). The app role can only SELECT and INSERT. `version_number` and
 * `published_by` are set by a trigger (sequential per template, and auth.uid()), never by the client.
 */
export const templateVersions = pgTable(
  "template_versions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id").notNull(),
    storeId: uuid("store_id").notNull(),
    templateId: uuid("template_id").notNull(),
    versionNumber: integer("version_number").notNull(),
    document: jsonb("document").$type<TemplateDocument>().notNull(),
    source: text("source", { enum: VERSION_SOURCES }).notNull(),
    rolledBackFrom: uuid("rolled_back_from"),
    publishedBy: uuid("published_by").references(() => authUsers.id, { onDelete: "set null" }),
    label: text("label"),
    publishedAt: timestamp("published_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t): PgTableExtraConfigValue[] => [
    foreignKey({ columns: [t.tenantId, t.storeId, t.templateId], foreignColumns: [templates.tenantId, templates.storeId, templates.id], name: "template_versions_template_fk" }).onDelete("cascade"),
    foreignKey({ columns: [t.templateId, t.rolledBackFrom], foreignColumns: [t.templateId, t.id], name: "template_versions_rolled_back_from_fk" }),
    unique("template_versions_template_id_id_key").on(t.templateId, t.id),
    unique("template_versions_template_id_version_number_key").on(t.templateId, t.versionNumber),
    check("template_versions_version_number_check", sql`${t.versionNumber} >= 1`),
    check("template_versions_source_check", sql`${t.source} in ('publish', 'rollback', 'migration')`),
    check("template_versions_rollback_source_check", sql`(${t.source} = 'rollback') = (${t.rolledBackFrom} is not null)`),
    check("template_versions_label_check", sql`${t.label} is null or char_length(${t.label}) <= ${sql.raw(String(LIMITS.maxVersionLabelLength))}`),
    documentCheck("template_versions_document_check", t.document),
    index("template_versions_template_idx").on(t.templateId, t.versionNumber.desc()),
  ],
).enableRLS();

/**
 * A page template assigned to one product or one collection of a store (D8, D23). Polymorphic by two
 * nullable columns, exactly one set, each with its own composite FK to the catalog table: the resource must
 * exist in the same tenant, and deleting it deletes the assignment. `template_kind` is copied from the
 * template by a trigger and tied to `(tenant, store, template, kind)` by FK, so a product can only point at a
 * product template. Deleting a template that still has assignments is blocked (NO ACTION).
 */
export const templateAssignments = pgTable(
  "template_assignments",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id").notNull(),
    storeId: uuid("store_id").notNull(),
    templateId: uuid("template_id").notNull(),
    templateKind: text("template_kind").notNull(),
    productId: uuid("product_id"),
    collectionId: uuid("collection_id"),
    resourceType: text("resource_type").generatedAlwaysAs(sql`case when product_id is not null then 'product' else 'collection' end`),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    foreignKey({ columns: [t.tenantId, t.storeId], foreignColumns: [stores.tenantId, stores.id], name: "template_assignments_store_fk" }).onDelete("cascade"),
    foreignKey({
      columns: [t.tenantId, t.storeId, t.templateId, t.templateKind],
      foreignColumns: [templates.tenantId, templates.storeId, templates.id, templates.kind],
      name: "template_assignments_template_fk",
    }),
    foreignKey({ columns: [t.tenantId, t.productId], foreignColumns: [products.tenantId, products.id], name: "template_assignments_product_fk" }).onDelete("cascade"),
    foreignKey({ columns: [t.tenantId, t.collectionId], foreignColumns: [collections.tenantId, collections.id], name: "template_assignments_collection_fk" }).onDelete("cascade"),
    unique("template_assignments_store_product_key").on(t.storeId, t.productId),
    unique("template_assignments_store_collection_key").on(t.storeId, t.collectionId),
    check("template_assignments_one_resource_check", sql`num_nonnulls(${t.productId}, ${t.collectionId}) = 1`),
    check("template_assignments_kind_matches_resource_check", sql`${t.templateKind} = case when ${t.productId} is not null then 'product' else 'collection' end`),
    index("template_assignments_template_idx").on(t.templateId),
  ],
).enableRLS();

export type TemplateRow = typeof templates.$inferSelect;
export type TemplateVersionRow = typeof templateVersions.$inferSelect;
export type TemplateAssignmentRow = typeof templateAssignments.$inferSelect;
