// GENERATED from wnr-group/store-forge lib/templates/registry/blocks/product-compare-at-price.ts. DO NOT EDIT.

import type { BlockDefinition } from "../../engine/descriptors.js";

export const productCompareAtPriceBlock: BlockDefinition = {
  type: "product-compare-at-price",
  name: "Compare-at Price & Savings",
  settings: [
    {
      id: "showBadge",
      type: "toggle",
      label: "Show Sale Badge",
      default: true,
    },
    {
      id: "badgeText",
      type: "text",
      label: "Badge Text",
      default: "Sale",
    },
  ],
};
