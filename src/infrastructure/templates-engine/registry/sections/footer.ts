// GENERATED from wnr-group/store-forge lib/templates/registry/sections/footer.ts. DO NOT EDIT.

import type { SectionDefinition } from "../../engine/descriptors.js";

export const footerSection: SectionDefinition = {
  type: "footer",
  name: "Footer",
  category: "Footer",
  accepts: ["link-column", "social-link", "text", "heading"],
  maxChildren: 10,
  settings: [
    {
      id: "backgroundColor",
      type: "color",
      label: "Background Color",
      default: "#f8fafc",
    },
    {
      id: "textColor",
      type: "color",
      label: "Text Color",
      default: "#0f172a",
    },
    {
      id: "copyrightText",
      type: "text",
      label: "Custom Copyright Text",
      default: "",
    },
    {
      id: "showPaymentIcons",
      type: "toggle",
      label: "Show Payment Badges",
      default: false,
    },
    {
      id: "showSocial",
      type: "toggle",
      label: "Show Social Media Links",
      default: true,
    },
  ],
};
