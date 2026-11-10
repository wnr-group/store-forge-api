// GENERATED from wnr-group/store-forge lib/templates/registry/presets/group-header.ts. DO NOT EDIT.

import { DOCUMENT_SCHEMA_VERSION, type TemplateDocument } from "../../document.js";

export const groupHeaderPreset: TemplateDocument = {
  schemaVersion: DOCUMENT_SCHEMA_VERSION,
  layout: "classic",
  sections: {
    announcement: {
      type: "announcement-bar",
      settings: {
        text: "Welcome to our store! Free shipping on orders over ₹999",
        link: "",
        backgroundColor: "#0f172a",
        textColor: "#ffffff",
        showSocial: false,
        alignment: "center",
      },
      blocks: {},
      block_order: [],
    },
    header: {
      type: "header",
      settings: {
        logoWidth: 120,
        menuAlignment: "left",
        sticky: true,
        showSeparator: true,
      },
      blocks: {},
      block_order: [],
    },
  },
  order: ["announcement", "header"],
};
