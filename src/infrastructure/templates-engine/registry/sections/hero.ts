// GENERATED from wnr-group/store-forge lib/templates/registry/sections/hero.ts. DO NOT EDIT.

import type { SectionDefinition } from "../../engine/descriptors.js";

export const heroSection: SectionDefinition = {
  type: "hero",
  name: "Hero Banner",
  category: "Banners",
  accepts: ["heading", "text", "button"],
  maxChildren: 10,
  settings: [
    {
      id: "variant",
      type: "select",
      label: "Variant",
      default: "classic",
      options: [
        { label: "Classic", value: "classic" },
        { label: "Spotlight", value: "spotlight" },
      ],
    },
    {
      id: "heading",
      type: "text",
      label: "Heading",
      default: "",
      help: "Main heading displayed in the hero banner",
    },
    {
      id: "subheading",
      type: "textarea",
      label: "Subheading",
      default: "",
      help: "Supporting text under the heading",
    },
    {
      id: "accentColor",
      type: "color",
      label: "Accent Color",
      default: "#1a5aaa",
    },
    {
      id: "image",
      type: "image",
      label: "Hero Image",
      default: null,
    },
  ],
};
