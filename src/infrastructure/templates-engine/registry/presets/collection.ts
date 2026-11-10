// GENERATED from wnr-group/store-forge lib/templates/registry/presets/collection.ts. DO NOT EDIT.

import { DOCUMENT_SCHEMA_VERSION, type TemplateDocument } from "../../document.js";

export const collectionPreset: TemplateDocument = {
  schemaVersion: DOCUMENT_SCHEMA_VERSION,
  layout: "classic",
  sections: {
    banner: {
      type: "collection-banner",
      settings: {
        showCollectionDescription: true,
        showCollectionImage: true,
      },
      blocks: {},
      block_order: [],
    },
    products: {
      type: "product-grid",
      settings: {
        columns: 4,
        productsPerPage: 12,
      },
      blocks: {},
      block_order: [],
    },
  },
  order: ["banner", "products"],
};
