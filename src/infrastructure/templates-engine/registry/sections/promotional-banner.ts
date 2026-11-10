// GENERATED from wnr-group/store-forge lib/templates/registry/sections/promotional-banner.ts. DO NOT EDIT.

import type { SectionDefinition } from "../../engine/descriptors.js";

export const promotionalBannerSection: SectionDefinition = {
  type: "promotional-banner",
  name: "Promotional Banner",
  category: "Marketing",
  accepts: ["heading", "text", "button"],
  maxChildren: 5,
  settings: [
    {
      id: "title",
      type: "text",
      label: "Promotion Title",
      default: "Special Offer",
    },
    {
      id: "highlightText",
      type: "text",
      label: "Highlight Text",
      default: "Get 15% off your entire order with code FORGE15",
    },
    {
      id: "link",
      type: "url",
      label: "Banner Link",
      default: "/collections",
    },
    {
      id: "backgroundColor",
      type: "color",
      label: "Background Color",
      default: "#3b82f6",
    },
    {
      id: "textColor",
      type: "color",
      label: "Text Color",
      default: "#ffffff",
    },
  ],
};
