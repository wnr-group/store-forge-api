// GENERATED from wnr-group/store-forge lib/templates/registry/presets/spotlight.ts. DO NOT EDIT.

import { DOCUMENT_SCHEMA_VERSION, type TemplateDocument } from "../../document.js";

export const spotlightPreset: TemplateDocument = {
  schemaVersion: DOCUMENT_SCHEMA_VERSION,
  layout: "spotlight",
  sections: {
    hero: {
      type: "hero",
      settings: { variant: "spotlight" },
      blocks: {},
      block_order: [],
    },
    products: {
      type: "product-grid",
      settings: {},
      blocks: {},
      block_order: [],
    },
  },
  order: ["hero", "products"],
};
