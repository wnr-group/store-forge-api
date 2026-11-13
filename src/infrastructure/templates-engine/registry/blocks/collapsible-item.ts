// GENERATED from wnr-group/store-forge lib/templates/registry/blocks/collapsible-item.ts. DO NOT EDIT.

import type { BlockDefinition } from "../../engine/descriptors.js";

export const collapsibleItemBlock: BlockDefinition = {
  type: "collapsible-item",
  name: "Collapsible Row",
  settings: [
    {
      id: "heading",
      type: "text",
      label: "Heading",
      default: "Frequently asked question",
    },
    {
      id: "content",
      type: "richtext",
      label: "Content",
      default: "Provide a detailed answer or supporting information for your shoppers.",
    },
    {
      id: "defaultOpen",
      type: "toggle",
      label: "Open by default",
      default: false,
    },
  ],
};
