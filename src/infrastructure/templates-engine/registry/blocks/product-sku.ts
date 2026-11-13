// GENERATED from wnr-group/store-forge lib/templates/registry/blocks/product-sku.ts. DO NOT EDIT.

import type { BlockDefinition } from "../../engine/descriptors.js";

export const productSkuBlock: BlockDefinition = {
  type: "product-sku",
  name: "Product SKU",
  settings: [
    {
      id: "prefix",
      type: "text",
      label: "SKU Prefix Label",
      default: "SKU:",
    },
    {
      id: "showLabel",
      type: "toggle",
      label: "Show Prefix Label",
      default: true,
    },
  ],
};
