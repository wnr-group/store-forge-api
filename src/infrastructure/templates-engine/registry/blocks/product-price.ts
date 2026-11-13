// GENERATED from wnr-group/store-forge lib/templates/registry/blocks/product-price.ts. DO NOT EDIT.

import type { BlockDefinition } from "../../engine/descriptors.js";

export const productPriceBlock: BlockDefinition = {
  type: "product-price",
  name: "Product Price",
  settings: [
    {
      id: "showCompareAt",
      type: "toggle",
      label: "Show Compare-at Price",
      default: true,
    },
    {
      id: "textSize",
      type: "select",
      label: "Text Size",
      default: "medium",
      options: [
        { label: "Small", value: "small" },
        { label: "Medium", value: "medium" },
        { label: "Large", value: "large" },
      ],
    },
  ],
};
