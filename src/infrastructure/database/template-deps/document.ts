// GENERATED from wnr-group/store-forge lib/templates/document.ts. DO NOT EDIT.

/**
 * Vocabulary and document shape shared by the schema, the migrations' drift tests and (later) the
 * validator and renderer. Plain data and types only: no React, database or server-only imports.
 */
export const TEMPLATE_KINDS = ["index", "product", "collection", "theme_settings", "group_header", "group_footer", "group_announcement"] as const;
export type TemplateKind = (typeof TEMPLATE_KINDS)[number];

/** Kinds that render a storefront page; a store may have many of each and one default (D8). */
export const PAGE_KINDS = ["index", "product", "collection"] as const;
/** One document per store, never assigned to a resource (D7). */
export const SHARED_KINDS = ["theme_settings", "group_header", "group_footer", "group_announcement"] as const;

/** Lifecycle only. Published or draft is derived from `published_version_id` (see template_publication_state()). */
export const TEMPLATE_STATUSES = ["active", "archived"] as const;
export type TemplateStatus = (typeof TEMPLATE_STATUSES)[number];

export const VERSION_SOURCES = ["publish", "rollback", "migration"] as const;
export type VersionSource = (typeof VERSION_SOURCES)[number];

/** Resources a page template can be assigned to (D1, D8). */
export const ASSIGNMENT_RESOURCE_TYPES = ["product", "collection"] as const;
export type AssignmentResourceType = (typeof ASSIGNMENT_RESOURCE_TYPES)[number];

export const DOCUMENT_SCHEMA_VERSION = 1;

/** Formalized layout options (D3, R3): the only page chrome a document may name. There is no "default" layout (C-02). */
export const LAYOUTS = ["classic", "spotlight"] as const;
export type LayoutKey = (typeof LAYOUTS)[number];
/** The layout a page document without one gets (migration, new templates): the first, `classic`. Defined once. */
export const DEFAULT_LAYOUT: LayoutKey = LAYOUTS[0];

export function isLayoutKey(value: unknown): value is LayoutKey {
  return typeof value === "string" && (LAYOUTS as readonly string[]).includes(value);
}

/** A section or a block: one recursive shape (D6). `disabled` is omitted when false (D26). */
export type ComponentNode = {
  type: string;
  settings: Record<string, unknown>;
  blocks: Record<string, ComponentNode>;
  block_order: string[];
  disabled?: boolean;
};

export type TemplateDocument = {
  schemaVersion: number;
  /** Names the page chrome used when no shared group is published: "classic" or "spotlight" (see LAYOUTS). */
  layout: string;
  sections: Record<string, ComponentNode>;
  order: string[];
};
