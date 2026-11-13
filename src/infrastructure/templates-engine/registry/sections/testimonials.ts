// GENERATED from wnr-group/store-forge lib/templates/registry/sections/testimonials.ts. DO NOT EDIT.

import type { SectionDefinition } from "../../engine/descriptors.js";

export const testimonialsSection: SectionDefinition = {
  type: "testimonials",
  name: "Customer Testimonials",
  category: "Content",
  accepts: ["testimonial"],
  maxChildren: 12,
  settings: [
    {
      id: "heading",
      type: "text",
      label: "Heading",
      default: "What Our Customers Say",
    },
    {
      id: "subheading",
      type: "textarea",
      label: "Subheading",
      default: "Read real feedback and reviews from happy customers around the world.",
    },
    {
      id: "columns",
      type: "range",
      label: "Columns on Desktop",
      default: 3,
      min: 1,
      max: 4,
    },
  ],
};
