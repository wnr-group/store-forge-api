// GENERATED from wnr-group/store-forge lib/templates/registry/presets/product.ts. DO NOT EDIT.

import { DOCUMENT_SCHEMA_VERSION, type TemplateDocument } from "../../document.js";

export const productPreset: TemplateDocument = {
  schemaVersion: DOCUMENT_SCHEMA_VERSION,
  layout: "classic",
  sections: {
    main: {
      type: "main-product",
      settings: {
        galleryLayout: "thumbnails",
        mediaPosition: "left",
      },
      blocks: {
        title: {
          type: "product-title",
          settings: { level: "h1", alignment: "left" },
          blocks: {},
          block_order: [],
        },
        price: {
          type: "product-price",
          settings: { showCompareAt: true, textSize: "medium" },
          blocks: {},
          block_order: [],
        },
        variants: {
          type: "variant-picker",
          settings: { pickerType: "pills", showSku: true, showInventory: false },
          blocks: {},
          block_order: [],
        },
        description: {
          type: "product-description",
          settings: { truncate: false, maxLines: 5 },
          blocks: {},
          block_order: [],
        },
      },
      block_order: ["title", "price", "variants", "description"],
    },
    related: {
      type: "related-products",
      settings: {
        heading: "You May Also Like",
        productsToShow: 4,
        columns: 4,
      },
      blocks: {},
      block_order: [],
    },
  },
  order: ["main", "related"],
};
