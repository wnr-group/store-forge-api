// GENERATED from wnr-group/store-forge lib/templates/registry/blocks/link.ts. DO NOT EDIT.

import type { BlockDefinition } from "../../engine/descriptors.js";

export const linkBlock: BlockDefinition = {
  type: "link",
  name: "Link",
  settings: [
    {
      id: "label",
      type: "text",
      label: "Link Label",
      default: "Learn more",
    },
    {
      id: "url",
      type: "url",
      label: "URL",
      default: "/",
    },
    {
      id: "openInNewTab",
      type: "toggle",
      label: "Open in new tab",
      default: false,
    },
  ],
};
