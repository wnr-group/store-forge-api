import { Injectable, Logger } from '@nestjs/common';
import { sql } from 'drizzle-orm';
import { notFound } from '../../common/app.exception.js';
import { DatabaseService, rowsOf } from '../../database/database.service.js';
import { RecommendationsService } from '../recommendations/recommendations.service.js';
import type { PublicRecommendationsQueryDto } from '../recommendations/recommendations.dto.js';
import type { RecordWebVitalsDto } from '../studio/studio.dto.js';
import type {
  PublicBrandingDto,
  PublicHostDto,
  StorefrontDto,
} from './public.dto.js';

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
    available?: boolean;
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

  constructor(
    private readonly db: DatabaseService,
    private readonly recommendationsService: RecommendationsService,
  ) {}

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

  /**
   * Which store a host label names (`urban-nest-zqkod2`), read from the stored stores.subdomain. Unknown, inactive and
   * suspended stores look identical: not found.
   */
  async host(subdomain: string): Promise<PublicHostDto> {
    const row = await this.db.withPublic(
      async (tx) =>
        rowsOf<{ slug: string; public_id: string }>(
          await tx.execute(
            sql`select * from public.get_public_store_by_subdomain(${subdomain})`,
          ),
        )[0],
    );
    if (!row) throw notFound('Store not found.', 'STORE_NOT_FOUND');
    return { slug: row.slug, publicId: row.public_id };
  }

  /** Unknown, inactive and suspended stores look identical: not found. */
  async storefront(slug: string): Promise<StorefrontDto> {
    const { raw, publicId } = await this.db.withPublic(async (tx) => ({
      raw: rowsOf<{ s: unknown }>(
        await tx.execute(
          sql`select public.get_public_storefront(${slug}) as s`,
        ),
      )[0]?.s,
      publicId: rowsOf<{ p: string | null }>(
        await tx.execute(
          sql`select public.get_public_store_public_id(${slug}) as p`,
        ),
      )[0]?.p,
    }));
    if (raw === null || raw === undefined || !publicId)
      throw notFound('Store not found.', 'STORE_NOT_FOUND');
    const s = (
      typeof raw === 'string' ? JSON.parse(raw) : raw
    ) as StorefrontRaw;
    return {
      name: s.name,
      slug: s.slug,
      publicId,
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
        // Older database functions do not send the flag: such a product counts as available.
        available: p.available ?? true,
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

  /** Published reviews for a product with mandatory disclosure wording. */
  async reviews(slug: string, productSlug: string, limit = 20, offset = 0) {
    const raw = await this.db.withPublic(
      async (tx) =>
        rowsOf<{ r: unknown }>(
          await tx.execute(
            sql`select public.get_public_product_reviews(${slug}, ${productSlug}, ${limit}, ${offset}) as r`,
          ),
        )[0]?.r,
    );
    if (!raw) throw notFound('Product or store not found.', 'NOT_FOUND');
    return (typeof raw === 'string' ? JSON.parse(raw) : raw) as Record<
      string,
      unknown
    >;
  }

  /** Recommendations for a product / collection on the storefront. */
  async recommendations(slug: string, query: PublicRecommendationsQueryDto) {
    return this.recommendationsService.getPublicRecommendations(slug, query);
  }

  /** Ingest client-side Web Vitals performance sample into daily aggregation. */
  async recordWebVitals(dto: RecordWebVitalsDto) {
    return this.db.withPublic(async (tx) => {
      const storeRows = rowsOf<{ id: string }>(
        await tx.execute(
          sql`SELECT id FROM public.stores WHERE slug = ${dto.storeSlug} AND status = 'active'`,
        ),
      );
      if (!storeRows[0]) return { recorded: false };
      const storeId = storeRows[0].id;

      let bucket = 'good';
      if (dto.metric === 'LCP') {
        if (dto.value > 4000) bucket = 'poor';
        else if (dto.value > 2500) bucket = 'needs_improvement';
      } else if (dto.metric === 'CLS') {
        if (dto.value > 0.25) bucket = 'poor';
        else if (dto.value > 0.1) bucket = 'needs_improvement';
      } else if (dto.metric === 'INP') {
        if (dto.value > 500) bucket = 'poor';
        else if (dto.value > 200) bucket = 'needs_improvement';
      } else if (dto.metric === 'TTFB' || dto.metric === 'FCP') {
        if (dto.value > 1800) bucket = 'poor';
        else if (dto.value > 800) bucket = 'needs_improvement';
      }

      const bucketKey = bucket;
      await tx.execute(
        sql`INSERT INTO public.web_vitals_daily
              (store_id, publish_id, route_kind, device_class, metric, day, bucket_counts, sample_count)
            VALUES
              (${storeId}, ${dto.publishId ?? null}, ${dto.routeKind}, ${dto.deviceClass}, ${dto.metric}, CURRENT_DATE, jsonb_build_object(${bucketKey}, 1), 1)
            ON CONFLICT ("store_id", "publish_id", "route_kind", "device_class", "metric", "day")
            DO UPDATE SET
              sample_count = public.web_vitals_daily.sample_count + 1,
              bucket_counts = jsonb_set(
                public.web_vitals_daily.bucket_counts,
                ARRAY[${bucketKey}],
                to_jsonb(COALESCE((public.web_vitals_daily.bucket_counts->>${bucketKey})::int, 0) + 1)
              )`,
      );
      return { recorded: true };
    });
  }

  /** One published landing page (kind = 'page'). */
  async landingPage(slug: string, pageSlug: string) {
    const raw = await this.db.withPublic(
      async (tx) =>
        rowsOf<{ p: unknown }>(
          await tx.execute(
            sql`select public.get_public_landing_page(${slug}, ${pageSlug}) as p`,
          ),
        )[0]?.p,
    );
    if (!raw) throw notFound('Landing page not found.', 'PAGE_NOT_FOUND');
    return (typeof raw === 'string' ? JSON.parse(raw) : raw) as Record<
      string,
      unknown
    >;
  }
}
