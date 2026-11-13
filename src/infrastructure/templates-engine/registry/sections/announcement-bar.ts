// GENERATED from wnr-group/store-forge lib/templates/registry/sections/announcement-bar.ts. DO NOT EDIT.

import type { SectionDefinition } from "../../engine/descriptors.js";

export const announcementBarSection: SectionDefinition = {
  type: "announcement-bar",
  name: "Announcement Bar",
  category: "Header",
  accepts: ["text", "link", "social-link"],
  maxChildren: 5,
  settings: [
    {
      id: "text",
      type: "text",
      label: "Announcement Message",
      default: "Welcome to our store! Free shipping on orders over ₹999",
    },
    {
      id: "link",
      type: "url",
      label: "Banner Link",
      default: "",
    },
    {
      id: "backgroundColor",
      type: "color",
      label: "Background Color",
      default: "#0f172a",
    },
    {
      id: "textColor",
      type: "color",
      label: "Text Color",
      default: "#ffffff",
    },
    {
      id: "showSocial",
      type: "toggle",
      label: "Show Social Icons",
      default: false,
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
