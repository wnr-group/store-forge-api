import type {
  TemplateKind,
  ThemeIndustry,
} from '../../../database/schema/templates.js';

/** A section or a block: one recursive shape, exactly as the storefront template engine stores it. */
export interface ComponentNode {
  type: string;
  settings: Record<string, unknown>;
  blocks: Record<string, ComponentNode>;
  block_order: string[];
  disabled?: boolean;
}

export type Child = readonly [id: string, node: ComponentNode];

export interface PageDocument {
  schemaVersion: 1;
  layout: 'classic' | 'spotlight';
  sections: Record<string, ComponentNode>;
  order: string[];
}

export interface ThemeSettingsDocument {
  schemaVersion: 1;
  settings: Record<string, Record<string, unknown>>;
}

export type ThemeDocuments = Record<
  TemplateKind,
  PageDocument | ThemeSettingsDocument
>;

export interface ThemeDefinition {
  slug: string;
  name: string;
  description: string;
  industry: ThemeIndustry;
  version: number;
  /** Served by the storefront from /themes/<slug>/. */
  previewImage: string;
  documents: ThemeDocuments;
}

export const node = (
  type: string,
  settings: Record<string, unknown> = {},
  children: Child[] = [],
): ComponentNode => ({
  type,
  settings,
  blocks: Object.fromEntries(children),
  block_order: children.map(([id]) => id),
});

/** Block ids are unique across the whole document, so every block id is prefixed with its parent's id. */
const namespaced = (parentId: string, n: ComponentNode): ComponentNode => {
  const blocks: Record<string, ComponentNode> = {};
  for (const [id, child] of Object.entries(n.blocks))
    blocks[`${parentId}_${id}`] = namespaced(`${parentId}_${id}`, child);
  return {
    ...n,
    blocks,
    block_order: n.block_order.map((id) => `${parentId}_${id}`),
  };
};

export const page = (
  layout: PageDocument['layout'],
  sections: Child[],
): PageDocument => ({
  schemaVersion: 1,
  layout,
  sections: Object.fromEntries(
    sections.map(([id, n]) => [id, namespaced(id, n)]),
  ),
  order: sections.map(([id]) => id),
});

export const themeSettings = (
  settings: ThemeSettingsDocument['settings'],
): ThemeSettingsDocument => ({ schemaVersion: 1, settings });

/** A platform-supplied image, served from the storefront's /themes/<theme>/ folder. */
export const asset = (theme: string, file: string) => ({
  asset: `${theme}/${file}`,
});

export const heading = (
  text: string,
  level = 'h2',
  alignment = 'left',
): ComponentNode => node('heading', { text, level, alignment });

export const text = (content: string, alignment = 'left'): ComponentNode =>
  node('text', { content, alignment });

export const button = (
  label: string,
  link: string,
  style = 'primary',
): ComponentNode => node('button', { label, link, style });

export const link = (label: string, url: string): ComponentNode =>
  node('link', { label, url });
