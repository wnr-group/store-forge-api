// GENERATED from wnr-group/store-forge lib/templates/registry/sections/main-product.ts. DO NOT EDIT.

import type { SectionDefinition } from "../../engine/descriptors.js";

export const mainProductSection: SectionDefinition = {
  type: "main-product",
  name: "Product Information & Media",
  category: "Product",
  accepts: [
    "product-title",
    "product-price",
    "product-compare-at-price",
    "product-sku",
    "product-type",
    "product-category",
    "product-description",
    "variant-picker",
    "collapsible-info",
    "social-share",
    "image",
    "button",
    "text",
    "heading",
  ],
  maxChildren: 20,
  settings: [
    {
      id: "galleryLayout",
      type: "select",
      label: "Media Gallery Layout",
      default: "thumbnails",
      options: [
        { label: "Thumbnails Grid", value: "thumbnails" },
        { label: "Stacked Vertical", value: "stacked" },
      ],
    },
    {
      id: "mediaPosition",
      type: "select",
      label: "Desktop Media Position",
      default: "left",
      options: [
        { label: "Media on Left", value: "left" },
        { label: "Media on Right", value: "right" },
      ],
    },
  ],
};
