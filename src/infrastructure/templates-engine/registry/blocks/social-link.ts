// GENERATED from wnr-group/store-forge lib/templates/registry/blocks/social-link.ts. DO NOT EDIT.

import type { BlockDefinition } from "../../engine/descriptors.js";

export const socialLinkBlock: BlockDefinition = {
  type: "social-link",
  name: "Social Link",
  settings: [
    {
      id: "network",
      type: "select",
      label: "Social Network",
      default: "instagram",
      options: [
        { label: "Instagram", value: "instagram" },
        { label: "Facebook", value: "facebook" },
        { label: "X (Twitter)", value: "x" },
        { label: "Twitter", value: "twitter" },
        { label: "Pinterest", value: "pinterest" },
        { label: "TikTok", value: "tiktok" },
        { label: "YouTube", value: "youtube" },
        { label: "LinkedIn", value: "linkedin" },
      ],
    },
    {
      id: "url",
      type: "url",
      label: "Profile URL",
      default: "https://instagram.com",
    },
  ],
};
