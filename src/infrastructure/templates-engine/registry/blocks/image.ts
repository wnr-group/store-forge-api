// GENERATED from wnr-group/store-forge lib/templates/registry/blocks/image.ts. DO NOT EDIT.

import type { BlockDefinition } from "../../engine/descriptors.js";

export const imageBlock: BlockDefinition = {
  type: "image",
  name: "Image",
  settings: [
    {
      id: "image",
      type: "image",
      label: "Image",
      default: null,
    },
    {
      id: "aspectRatio",
      type: "select",
      label: "Aspect Ratio",
      default: "auto",
      options: [
        { label: "Auto", value: "auto" },
        { label: "Square (1:1)", value: "1/1" },
        { label: "Widescreen (16:9)", value: "16/9" },
        { label: "Standard (4:3)", value: "4/3" },
        { label: "Portrait (3:4)", value: "3/4" },
      ],
    },
    {
      id: "objectFit",
      type: "select",
      label: "Object Fit",
      default: "cover",
      options: [
        { label: "Cover", value: "cover" },
        { label: "Contain", value: "contain" },
        { label: "Fill", value: "fill" },
      ],
    },
    {
      id: "width",
      type: "select",
      label: "Width",
      default: "full",
      options: [
        { label: "Full width", value: "full" },
        { label: "Large (75%)", value: "large" },
        { label: "Medium (50%)", value: "medium" },
        { label: "Small (25%)", value: "small" },
      ],
    },
    {
      id: "alignment",
      type: "select",
      label: "Alignment",
      default: "center",
      options: [
        { label: "Left", value: "left" },
        { label: "Center", value: "center" },
        { label: "Right", value: "right" },
      ],
    },
  ],
};
