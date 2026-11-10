// GENERATED from wnr-group/store-forge lib/templates/registry/blocks/link-column.ts. DO NOT EDIT.

import type { BlockDefinition } from "../../engine/descriptors.js";

export const linkColumnBlock: BlockDefinition = {
  type: "link-column",
  name: "Link Column",
  accepts: ["link"],
  maxChildren: 20,
  settings: [
    {
      id: "title",
      type: "text",
      label: "Column Title",
      default: "Quick Links",
    },
  ],
};
