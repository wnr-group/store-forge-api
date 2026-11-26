import { z } from 'zod';

export const templateSchema = z.object({
  key: z.string(),
  accent_color: z.string().nullable(),
  hero_heading: z.string().nullable(),
  hero_subheading: z.string().nullable(),
  hero_image_path: z.string().nullable(),
});

/** `template` is optional and nullable so a store with no settings still renders */
export const storefrontSchema = z.object({
  name: z.string(),
  slug: z.string(),
  description: z.string().nullable(),
  logo_path: z.string().nullable(),
  /** Optional so a database not yet migrated to 0071 still parses. */
  meta_title: z.string().nullish(),
  meta_description: z.string().nullish(),
  currency: z.string(),
  products: z.array(
    z.object({
      name: z.string(),
      slug: z.string(),
      short_description: z.string().nullable(),
      price_minor: z.number(),
      compare_at_price_minor: z.number().nullable(),
      image_path: z.string().nullable(),
    }),
  ),
  template: templateSchema.nullish(),
});

export type PublicStorefront = z.infer<typeof storefrontSchema>;

export const layoutPayloadSchema = z.object({
  source: z.enum(['assigned', 'default']).nullable().optional(),
  template: z
    .object({
      name: z.string(),
      version_number: z.number().int(),
      document: z.record(z.string(), z.unknown()),
    })
    .nullable()
    .optional(),
  theme: z.record(z.string(), z.unknown()).nullable().optional(),
  groups: z
    .object({
      header: z.record(z.string(), z.unknown()).nullable().optional(),
      footer: z.record(z.string(), z.unknown()).nullable().optional(),
      announcement: z.record(z.string(), z.unknown()).nullable().optional(),
    })
    .default({}),
});

export type PublicTemplateLayout = z.infer<typeof layoutPayloadSchema>;

export const publicProductPayloadSchema = z.object({
  store: z.object({
    name: z.string(),
    slug: z.string(),
    description: z.string().nullable().optional(),
    logo_path: z.string().nullable().optional(),
    currency: z.string().default('INR'),
  }),
  product: z.object({
    name: z.string(),
    slug: z.string(),
    description: z.string().nullable().optional(),
    short_description: z.string().nullable().optional(),
    product_type: z.string().nullable().optional(),
    sku: z.string().nullable().optional(),
    price_minor: z.number(),
    compare_at_price_minor: z.number().nullable().optional(),
    has_variants: z.boolean().default(false),
    category_name: z.string().nullable().optional(),
  }),
  images: z
    .array(
      z.object({
        id: z.string(),
        path: z.string(),
        alt: z.string().nullable().optional(),
        position: z.number().default(0),
        is_primary: z.boolean().default(false),
      }),
    )
    .default([]),
  options: z
    .array(
      z.object({
        name: z.string(),
        values: z.array(z.string()),
      }),
    )
    .default([]),
  variants: z
    .array(
      z.object({
        id: z.string(),
        title: z.string(),
        options: z
          .record(z.string(), z.string())
          .or(z.record(z.string(), z.unknown()))
          .default({}),
        sku: z.string().nullable().optional(),
        price_minor: z.number(),
        compare_at_price_minor: z.number().nullable().optional(),
        image_id: z.string().nullable().optional(),
      }),
    )
    .default([]),
  related: z
    .array(
      z.object({
        name: z.string(),
        slug: z.string(),
        short_description: z.string().nullable().optional(),
        price_minor: z.number(),
        compare_at_price_minor: z.number().nullable().optional(),
        image_path: z.string().nullable().optional(),
      }),
    )
    .default([]),
});

export type PublicProduct = z.infer<typeof publicProductPayloadSchema>;

export const publicCollectionPayloadSchema = z.object({
  store: z.object({
    name: z.string(),
    slug: z.string(),
    description: z.string().nullable().optional(),
    logo_path: z.string().nullable().optional(),
    currency: z.string().default('INR'),
  }),
  collection: z.object({
    id: z.string(),
    name: z.string(),
    slug: z.string(),
    description: z.string().nullable().optional(),
    image_path: z.string().nullable().optional(),
  }),
  products: z
    .array(
      z.object({
        name: z.string(),
        slug: z.string(),
        short_description: z.string().nullable().optional(),
        price_minor: z.number(),
        compare_at_price_minor: z.number().nullable().optional(),
        image_path: z.string().nullable().optional(),
      }),
    )
    .default([]),
});

export type PublicCollection = z.infer<typeof publicCollectionPayloadSchema>;

export const publicCollectionsListSchema = z.array(
  z.object({
    id: z.string(),
    name: z.string(),
    slug: z.string(),
    description: z.string().nullable().optional(),
    image_path: z.string().nullable().optional(),
    product_count: z.number().default(0),
  }),
);

export type PublicCollectionsList = z.infer<typeof publicCollectionsListSchema>;
