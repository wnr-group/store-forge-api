// GENERATED from wnr-group/store-forge lib/templates/registry/sections/collection-list.ts. DO NOT EDIT.

import type { SectionDefinition } from "../../engine/descriptors.js";

export const collectionListSection: SectionDefinition = {
  type: "collection-list",
  name: "Collection List",
  category: "Collections",
  settings: [
    {
      id: "title",
      type: "text",
      label: "Section Title",
      default: "Explore Collections",
    },
    {
      id: "columns",
      type: "range",
      label: "Columns",
      default: 3,
      min: 2,
      max: 6,
    },
    {
      id: "showProductCount",
      type: "toggle",
      label: "Show Product Count",
      default: true,
    },
  ],
};
