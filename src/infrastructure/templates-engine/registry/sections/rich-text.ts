// GENERATED from wnr-group/store-forge lib/templates/registry/sections/rich-text.ts. DO NOT EDIT.

import type { SectionDefinition } from "../../engine/descriptors.js";

export const richTextSection: SectionDefinition = {
  type: "rich-text",
  name: "Rich Text",
  category: "Content",
  accepts: ["heading", "text", "button"],
  maxChildren: 10,
  settings: [
    {
      id: "alignment",
      type: "select",
      label: "Text Alignment",
      default: "center",
      options: [
        { label: "Left", value: "left" },
        { label: "Center", value: "center" },
        { label: "Right", value: "right" },
      ],
    },
    {
      id: "maxWidth",
      type: "select",
      label: "Container Width",
      default: "normal",
      options: [
        { label: "Narrow (640px)", value: "narrow" },
        { label: "Normal (896px)", value: "normal" },
        { label: "Wide (1152px)", value: "wide" },
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
