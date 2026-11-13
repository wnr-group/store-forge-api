// GENERATED from wnr-group/store-forge lib/templates/registry/blocks/column.ts. DO NOT EDIT.

import type { BlockDefinition } from "../../engine/descriptors.js";

export const columnBlock: BlockDefinition = {
  type: "column",
  name: "Column",
  accepts: ["heading", "text", "button", "image"],
  maxChildren: 10,
  settings: [
    {
      id: "image",
      type: "image",
      label: "Image",
      default: null,
    },
    {
      id: "title",
      type: "text",
      label: "Title",
      default: "Feature title",
    },
    {
      id: "text",
      type: "richtext",
      label: "Text",
      default: "Describe a key feature or highlight about your products or store.",
    },
    {
      id: "linkLabel",
      type: "text",
      label: "Link Label",
      default: "",
    },
    {
      id: "linkUrl",
      type: "url",
      label: "Link URL",
      default: "",
    },
  ],
};
