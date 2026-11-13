// GENERATED from wnr-group/store-forge lib/templates/registry/blocks/product-category.ts. DO NOT EDIT.

import type { BlockDefinition } from "../../engine/descriptors.js";

export const productCategoryBlock: BlockDefinition = {
  type: "product-category",
  name: "Product Category",
  settings: [
    {
      id: "showHierarchy",
      type: "toggle",
      label: "Show Category Breadcrumb / Hierarchy",
      default: true,
    },
    {
      id: "linkToCategory",
      type: "toggle",
      label: "Link to Category",
      default: true,
    },
  ],
};
