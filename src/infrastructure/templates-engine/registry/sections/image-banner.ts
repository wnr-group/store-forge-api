// GENERATED from wnr-group/store-forge lib/templates/registry/sections/image-banner.ts. DO NOT EDIT.

import type { SectionDefinition } from "../../engine/descriptors.js";

export const imageBannerSection: SectionDefinition = {
  type: "image-banner",
  name: "Image Banner",
  category: "Banners",
  accepts: ["heading", "text", "button"],
  maxChildren: 10,
  settings: [
    {
      id: "image",
      type: "image",
      label: "Banner Image",
      default: null,
    },
    {
      id: "height",
      type: "select",
      label: "Banner Height",
      default: "medium",
      options: [
        { label: "Small (300px)", value: "small" },
        { label: "Medium (450px)", value: "medium" },
        { label: "Large (600px)", value: "large" },
      ],
    },
    {
      id: "overlayOpacity",
      type: "range",
      label: "Dark Overlay Opacity (%)",
      default: 30,
      min: 0,
      max: 100,
      unit: "%",
    },
    {
      id: "textAlignment",
      type: "select",
      label: "Text Alignment",
      default: "center",
      options: [
        { label: "Left", value: "left" },
        { label: "Center", value: "center" },
        { label: "Right", value: "right" },
      ],
    },
  ],
};
