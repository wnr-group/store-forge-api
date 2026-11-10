export const TEMPLATE_KINDS = ['storefront', 'checkout'] as const;
export type TemplateKind = (typeof TEMPLATE_KINDS)[number];
export interface TemplateDocument {
  version: string;
}
