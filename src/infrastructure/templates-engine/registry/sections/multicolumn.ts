// GENERATED from wnr-group/store-forge lib/templates/registry/sections/multicolumn.ts. DO NOT EDIT.

import type { SectionDefinition } from "../../engine/descriptors.js";

export const multicolumnSection: SectionDefinition = {
  type: "multicolumn",
  name: "Multi-column",
  category: "Content",
  accepts: ["column"],
  maxChildren: 12,
  settings: [
    {
      id: "columns",
      type: "range",
      label: "Columns on Desktop",
      default: 3,
      min: 2,
      max: 6,
    },
    {
      id: "columnAlignment",
      type: "select",
      label: "Content Alignment",
      default: "left",
      options: [
        { label: "Left", value: "left" },
        { label: "Center", value: "center" },
        { label: "Right", value: "right" },
      ],
    },
    {
      id: "backgroundColor",
      type: "color",
      label: "Background Color",
      default: "#ffffff",
    },
  ],
};
