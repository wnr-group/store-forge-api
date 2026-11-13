// GENERATED from wnr-group/store-forge lib/templates/registry/blocks/product-title.ts. DO NOT EDIT.

import type { BlockDefinition } from "../../engine/descriptors.js";

export const productTitleBlock: BlockDefinition = {
  type: "product-title",
  name: "Product Title",
  settings: [
    {
      id: "level",
      type: "select",
      label: "Heading Level",
      default: "h1",
      options: [
        { label: "Heading 1", value: "h1" },
        { label: "Heading 2", value: "h2" },
        { label: "Heading 3", value: "h3" },
      ],
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
