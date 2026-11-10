// GENERATED from wnr-group/store-forge lib/templates/registry/blocks/product-type.ts. DO NOT EDIT.

import type { BlockDefinition } from "../../engine/descriptors.js";

export const productTypeBlock: BlockDefinition = {
  type: "product-type",
  name: "Product Type",
  settings: [
    {
      id: "prefix",
      type: "text",
      label: "Type Prefix Label",
      default: "Type:",
    },
    {
      id: "showLabel",
      type: "toggle",
      label: "Show Prefix Label",
      default: true,
    },
  ],
};
