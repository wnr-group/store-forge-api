// GENERATED from wnr-group/store-forge lib/templates/registry/blocks/product-description.ts. DO NOT EDIT.

import type { BlockDefinition } from "../../engine/descriptors.js";

export const productDescriptionBlock: BlockDefinition = {
  type: "product-description",
  name: "Product Description",
  settings: [
    {
      id: "truncate",
      type: "toggle",
      label: "Truncate Description",
      default: false,
    },
    {
      id: "maxLines",
      type: "range",
      label: "Max Lines Before Truncation",
      default: 5,
      min: 1,
      max: 20,
    },
  ],
};
