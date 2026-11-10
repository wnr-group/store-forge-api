// GENERATED from wnr-group/store-forge lib/templates/registry/sections/logo-list.ts. DO NOT EDIT.

import type { SectionDefinition } from "../../engine/descriptors.js";

export const logoListSection: SectionDefinition = {
  type: "logo-list",
  name: "Logo List",
  category: "Marketing",
  accepts: ["image"],
  maxChildren: 12,
  settings: [
    {
      id: "title",
      type: "text",
      label: "Heading",
      default: "As Seen In",
    },
    {
      id: "columns",
      type: "range",
      label: "Logos Per Row",
      default: 4,
      min: 2,
      max: 8,
    },
    {
      id: "grayscale",
      type: "toggle",
      label: "Display in Grayscale",
      default: true,
    },
  ],
};
