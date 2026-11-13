// GENERATED from wnr-group/store-forge lib/templates/registry/blocks/group.ts. DO NOT EDIT.

import type { BlockDefinition } from "../../engine/descriptors.js";

export const groupBlock: BlockDefinition = {
  type: "group",
  name: "Group Container",
  accepts: ["heading", "text", "button", "image", "link", "social-link"],
  maxChildren: 20,
  settings: [
    {
      id: "direction",
      type: "select",
      label: "Layout Direction",
      default: "vertical",
      options: [
        { label: "Vertical (Column)", value: "vertical" },
        { label: "Horizontal (Row)", value: "horizontal" },
      ],
    },
    {
      id: "gap",
      type: "range",
      label: "Gap (px)",
      default: 16,
      min: 0,
      max: 48,
      unit: "px",
    },
    {
      id: "alignment",
      type: "select",
      label: "Alignment",
      default: "start",
      options: [
        { label: "Start", value: "start" },
        { label: "Center", value: "center" },
        { label: "End", value: "end" },
      ],
    },
  ],
};
