// GENERATED from wnr-group/store-forge lib/templates/registry/blocks/testimonial.ts. DO NOT EDIT.

import type { BlockDefinition } from "../../engine/descriptors.js";

export const testimonialBlock: BlockDefinition = {
  type: "testimonial",
  name: "Testimonial",
  settings: [
    {
      id: "quote",
      type: "textarea",
      label: "Customer Quote",
      default: "Store Forge has completely transformed how we sell our products online.",
    },
    {
      id: "author",
      type: "text",
      label: "Author Name",
      default: "Jane Doe",
    },
    {
      id: "role",
      type: "text",
      label: "Author Role",
      default: "Verified Customer",
    },
    {
      id: "company",
      type: "text",
      label: "Company / Location",
      default: "",
    },
    {
      id: "avatar",
      type: "image",
      label: "Author Avatar",
      default: null,
    },
  ],
};
