// GENERATED from wnr-group/store-forge lib/templates/registry/sections/related-products.ts. DO NOT EDIT.

import type { SectionDefinition } from "../../engine/descriptors.js";

export const relatedProductsSection: SectionDefinition = {
  type: "related-products",
  name: "Related Products",
  category: "Product",
  settings: [
    {
      id: "heading",
      type: "text",
      label: "Section Heading",
      default: "You May Also Like",
    },
    {
      id: "productsToShow",
      type: "range",
      label: "Products to Show",
      default: 4,
      min: 2,
      max: 8,
    },
    {
      id: "columns",
      type: "range",
      label: "Columns on Desktop",
      default: 4,
      min: 2,
      max: 4,
    },
  ],
};
