// GENERATED from wnr-group/store-forge lib/templates/registry.ts. DO NOT EDIT.

/**
 * Template metadata only: plain data with no React, database or server-only imports, so the Zod schema,
 * the dashboard picker, the services and node tests can all import it. The components live in
 * components/storefront/templates and are mapped by key there.
 * Names and descriptions are provisional copy pending approval.
 */
export const TEMPLATE_KEYS = ["classic", "spotlight"] as const;
export type TemplateKey = (typeof TEMPLATE_KEYS)[number];

export const DEFAULT_TEMPLATE_KEY: TemplateKey = "classic";

export type TemplateMeta = { key: TemplateKey; name: string; description: string };

export const TEMPLATES: readonly TemplateMeta[] = [
  { key: "classic", name: "Classic", description: "The current StoreForge storefront: your store name on top and your products in a grid." },
  { key: "spotlight", name: "Spotlight", description: "A full-width hero banner with your heading and image above the product grid." },
];

export function isTemplateKey(value: unknown): value is TemplateKey {
  return typeof value === "string" && (TEMPLATE_KEYS as readonly string[]).includes(value);
}

export function templateMeta(key: TemplateKey): TemplateMeta {
  return TEMPLATES.find((t) => t.key === key) ?? TEMPLATES[0];
}
