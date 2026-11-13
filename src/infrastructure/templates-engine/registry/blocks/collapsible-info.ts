// GENERATED from wnr-group/store-forge lib/templates/registry/blocks/collapsible-info.ts. DO NOT EDIT.

import type { BlockDefinition } from "../../engine/descriptors.js";

export const collapsibleInfoBlock: BlockDefinition = {
  type: "collapsible-info",
  name: "Collapsible Product Information",
  settings: [
    {
      id: "title",
      type: "text",
      label: "Heading",
      default: "Shipping & Returns",
    },
    {
      id: "content",
      type: "richtext",
      label: "Information Content",
      default: "Free standard delivery on orders over ₹999. Easy 30-day return policy.",
    },
    {
      id: "icon",
      type: "select",
      label: "Icon",
      default: "none",
      options: [
        { label: "None", value: "none" },
        { label: "Shipping Truck", value: "truck" },
        { label: "Security Shield", value: "shield" },
        { label: "Help Circle", value: "help" },
      ],
    },
  ],
};
