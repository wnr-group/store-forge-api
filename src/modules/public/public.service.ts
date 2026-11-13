import { Injectable, Logger } from '@nestjs/common';
import { sql } from 'drizzle-orm';
import { notFound } from '../../common/app.exception.js';
import { DatabaseService, rowsOf } from '../../database/database.service.js';
import type { PublicBrandingDto, StorefrontDto } from './public.dto.js';

const DEFAULT_BRANDING: PublicBrandingDto = {
  platformName: 'StoreForge',
  supportEmail: null,
};

interface StorefrontRaw {
  name: string;
  slug: string;
  description: string | null;
  logo_path: string | null;
  currency: string;
  products: {
    name: string;
    slug: string;
    short_description: string | null;
    price_minor: number;
    compare_at_price_minor: number | null;
    image_path: string | null;
  }[];
  template?: Record<string, unknown> | null;
}

/**
 * Anonymous reads. They run as the request role with NO identity, which sees no rows through RLS: the only way to
 * read public data is a narrow SECURITY DEFINER function (`get_public_storefront`, `get_public_platform_settings`).
 */
@Injectable()
export class PublicService {
  private readonly logger = new Logger(PublicService.name);

  constructor(private readonly db: DatabaseService) {}

  /** The platform name and support contact. If the database cannot be reached the defaults are used. */
  async branding(): Promise<PublicBrandingDto> {
    try {
      const row = await this.db.withPublic(
        async (tx) =>
          rowsOf<{ platform_name: string; support_email: string | null }>(
            await tx.execute(
              sql`select * from public.get_public_platform_settings()`,
            ),
          )[0],
      );
      return row
        ? { platformName: row.platform_name, supportEmail: row.support_email }
        : DEFAULT_BRANDING;
    } catch (error) {
      this.logger.error(
        `public branding unavailable, using defaults: ${error instanceof Error ? error.message : 'unknown'}`,
      );
      return DEFAULT_BRANDING;
    }
  }

  /** Unknown, inactive and suspended stores look identical: not found. */
  async storefront(slug: string): Promise<StorefrontDto> {
    const raw = await this.db.withPublic(
      async (tx) =>
        rowsOf<{ s: unknown }>(
          await tx.execute(
            sql`select public.get_public_storefront(${slug}) as s`,
          ),
        )[0]?.s,
    );
    if (raw === null || raw === undefined)
      throw notFound('Store not found.', 'STORE_NOT_FOUND');
    const s = (
      typeof raw === 'string' ? JSON.parse(raw) : raw
    ) as StorefrontRaw;
    return {
      name: s.name,
      slug: s.slug,
      description: s.description,
      logoPath: s.logo_path,
      currency: s.currency,
      products: s.products.map((p) => ({
        name: p.name,
        slug: p.slug,
        shortDescription: p.short_description,
        priceMinor: p.price_minor,
        compareAtPriceMinor: p.compare_at_price_minor,
        imagePath: p.image_path,
      })),
      template: s.template ?? null,
    };
  }

  /**
   * The PUBLISHED design of a store page (what shoppers see), straight from the database function: the page document,
   * the theme settings and the header, footer and announcement groups. Drafts are never returned. Anything not
   * published is null, and the caller falls back to its built-in look. Unknown stores are not found.
   */
  async layout(
    slug: string,
    kind: string,
    resourceSlug?: string,
  ): Promise<Record<string, unknown>> {
    const raw = await this.db.withPublic(
      async (tx) =>
        rowsOf<{ l: unknown }>(
          await tx.execute(
            sql`select public.get_public_template_layout(${slug}, ${kind}, ${resourceSlug ?? null}) as l`,
          ),
        )[0]?.l,
    );
    if (raw === null || raw === undefined)
      throw notFound('Store not found.', 'STORE_NOT_FOUND');
    return (typeof raw === 'string' ? JSON.parse(raw) : raw) as Record<
      string,
      unknown
    >;
  }

  /** The store's active collections for the storefront (name, slug, image, product count). */
  async collections(slug: string): Promise<Record<string, unknown>[]> {
    const raw = await this.db.withPublic(
      async (tx) =>
        rowsOf<{ c: unknown }>(
          await tx.execute(
            sql`select public.get_public_collections(${slug}) as c`,
          ),
        )[0]?.c,
    );
    if (raw === null || raw === undefined)
      throw notFound('Store not found.', 'STORE_NOT_FOUND');
    const parsed = typeof raw === 'string' ? JSON.parse(raw) : raw;
    return Array.isArray(parsed) ? parsed : [];
  }

  /** One active product with images, options, variants and related products. Unknown store or product is not found. */
  async product(
    slug: string,
    productSlug: string,
  ): Promise<Record<string, unknown>> {
    const raw = await this.db.withPublic(
      async (tx) =>
        rowsOf<{ p: unknown }>(
          await tx.execute(
            sql`select public.get_public_product(${slug}, ${productSlug}) as p`,
          ),
        )[0]?.p,
    );
    if (raw === null || raw === undefined)
      throw notFound('Product not found.', 'PRODUCT_NOT_FOUND');
    return (typeof raw === 'string' ? JSON.parse(raw) : raw) as Record<
      string,
      unknown
    >;
  }

  /** One active collection with its active products. Unknown store or collection is not found. */
  async collection(
    slug: string,
    collectionSlug: string,
  ): Promise<Record<string, unknown>> {
    const raw = await this.db.withPublic(
      async (tx) =>
        rowsOf<{ c: unknown }>(
          await tx.execute(
            sql`select public.get_public_collection(${slug}, ${collectionSlug}) as c`,
          ),
        )[0]?.c,
    );
    if (raw === null || raw === undefined)
      throw notFound('Collection not found.', 'COLLECTION_NOT_FOUND');
    return (typeof raw === 'string' ? JSON.parse(raw) : raw) as Record<
      string,
      unknown
    >;
  }

  /** Titles and addresses of the published content pages, for menus. */
  async pages(slug: string): Promise<Record<string, unknown>[]> {
    const raw = await this.db.withPublic(
      async (tx) =>
        rowsOf<{ g: unknown }>(
          await tx.execute(sql`select public.get_public_pages(${slug}) as g`),
        )[0]?.g,
    );
    if (raw === null || raw === undefined)
      throw notFound('Store not found.', 'STORE_NOT_FOUND');
    const parsed = typeof raw === 'string' ? JSON.parse(raw) : raw;
    return Array.isArray(parsed) ? parsed : [];
  }

  /** One published content page. Drafts, unknown pages and unavailable stores are all "not found". */
  async page(slug: string, pageSlug: string): Promise<Record<string, unknown>> {
    const raw = await this.db.withPublic(
      async (tx) =>
        rowsOf<{ g: unknown }>(
          await tx.execute(
            sql`select public.get_public_page(${slug}, ${pageSlug}) as g`,
          ),
        )[0]?.g,
    );
    if (raw === null || raw === undefined)
      throw notFound('Page not found.', 'PAGE_NOT_FOUND');
    return (typeof raw === 'string' ? JSON.parse(raw) : raw) as Record<
      string,
      unknown
    >;
  }
}
