// GENERATED from wnr-group/store-forge lib/templates/registry/blocks/text.ts. DO NOT EDIT.

import type { BlockDefinition } from "../../engine/descriptors.js";

export const textBlock: BlockDefinition = {
  type: "text",
  name: "Text",
  settings: [
    {
      id: "content",
      type: "richtext",
      label: "Content",
      default: "Pair text with an icon or image to focus on your chosen product, collection, or blog post.",
    },
    {
      id: "alignment",
      type: "select",
      label: "Alignment",
      default: "left",
      options: [
        { label: "Left", value: "left" },
        { label: "Center", value: "center" },
        { label: "Right", value: "right" },
      ],
    },
  ],
};
