// GENERATED from wnr-group/store-forge lib/templates/registry/blocks/social-share.ts. DO NOT EDIT.

import type { BlockDefinition } from "../../engine/descriptors.js";

export const socialShareBlock: BlockDefinition = {
  type: "social-share",
  name: "Social Share",
  settings: [
    {
      id: "title",
      type: "text",
      label: "Share Heading",
      default: "Share this product",
    },
    {
      id: "networks",
      type: "select",
      label: "Available Networks",
      default: "all",
      options: [
        { label: "All Networks (Facebook, X, Pinterest, LinkedIn)", value: "all" },
        { label: "Facebook, X, and Pinterest", value: "facebook_x_pinterest" },
        { label: "Copy Link Only", value: "direct_link" },
      ],
    },
    {
      id: "showLabels",
      type: "toggle",
      label: "Show Network Names",
      default: true,
    },
  ],
};
