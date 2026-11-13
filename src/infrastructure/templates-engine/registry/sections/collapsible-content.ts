// GENERATED from wnr-group/store-forge lib/templates/registry/sections/collapsible-content.ts. DO NOT EDIT.

import type { SectionDefinition } from "../../engine/descriptors.js";

export const collapsibleContentSection: SectionDefinition = {
  type: "collapsible-content",
  name: "Collapsible Content",
  category: "Content",
  accepts: ["collapsible-item"],
  maxChildren: 20,
  settings: [
    {
      id: "heading",
      type: "text",
      label: "Section Heading",
      default: "Frequently Asked Questions",
    },
    {
      id: "subheading",
      type: "textarea",
      label: "Subheading",
      default: "Find answers to common questions about our products, shipping, and returns.",
    },
    {
      id: "openFirstItem",
      type: "toggle",
      label: "Keep first item open",
      default: true,
    },
  ],
};
