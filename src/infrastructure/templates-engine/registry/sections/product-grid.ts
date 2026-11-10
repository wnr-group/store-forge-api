// GENERATED from wnr-group/store-forge lib/templates/registry/sections/product-grid.ts. DO NOT EDIT.

import type { SectionDefinition } from "../../engine/descriptors.js";

export const productGridSection: SectionDefinition = {
  type: "product-grid",
  name: "Product Grid",
  category: "Collections",
  settings: [
    {
      id: "accentColor",
      type: "color",
      label: "Accent Color",
      default: "#1a5aaa",
    },
    {
      id: "columns",
      type: "range",
      label: "Grid Columns",
      default: 4,
      min: 2,
      max: 6,
    },
    {
      id: "productsPerPage",
      type: "number",
      label: "Products Per Page",
      default: 12,
      min: 4,
      max: 48,
    },
  ],
};
