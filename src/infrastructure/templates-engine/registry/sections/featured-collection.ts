// GENERATED from wnr-group/store-forge lib/templates/registry/sections/featured-collection.ts. DO NOT EDIT.

import type { SectionDefinition } from "../../engine/descriptors.js";

export const featuredCollectionSection: SectionDefinition = {
  type: "featured-collection",
  name: "Featured Collection",
  category: "Collections",
  settings: [
    {
      id: "collectionId",
      type: "text",
      label: "Collection Identifier",
      default: "",
    },
    {
      id: "title",
      type: "text",
      label: "Heading",
      default: "Featured Collection",
    },
    {
      id: "productsToShow",
      type: "number",
      label: "Products to Show",
      default: 4,
      min: 2,
      max: 24,
    },
    {
      id: "columns",
      type: "range",
      label: "Columns on Desktop",
      default: 4,
      min: 2,
      max: 6,
    },
    {
      id: "showViewAll",
      type: "toggle",
      label: "Show View All Link",
      default: true,
    },
  ],
};
