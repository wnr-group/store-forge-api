import { Injectable } from '@nestjs/common';
import { and, asc, desc, eq, inArray, ne, notInArray, sql } from 'drizzle-orm';
import { invalid, notFound } from '../../common/app.exception.js';
import type {
  AuthUser,
  OrgContext,
} from '../../common/interfaces/request-context.js';
import { DatabaseService, rowsOf } from '../../database/database.service.js';
import {
  collections,
  collectionProducts,
  products,
} from '../../database/schema/catalog.js';
import { productRecommendations } from '../../database/schema/studio.js';
import { requireStore } from '../themes/themes.shared.js';
import type {
  PublicRecommendationsQueryDto,
  RecommendationItemDto,
  SetRecommendationsDto,
} from './recommendations.dto.js';

export interface PublicRecommendedProduct {
  id: string;
  name: string;
  slug: string;
  priceMinor: number;
  compareAtPriceMinor: number | null;
  imagePath: string | null;
  available: boolean;
}

@Injectable()
export class RecommendationsService {
  constructor(private readonly db: DatabaseService) {}

  /** Get merchant-picked recommendations for a product in the manager's store. */
  async getRecommendations(org: OrgContext, productId: string) {
    return this.db.withUser(org.userId, async (tx) => {
      await requireStore(tx, org);

      const rows = await tx
        .select({
          id: productRecommendations.id,
          recommendedProductId: productRecommendations.recommendedProductId,
          relationKind: productRecommendations.relationKind,
          position: productRecommendations.position,
          productName: products.name,
          productSlug: products.slug,
          priceMinor: products.priceMinor,
          compareAtPriceMinor: products.compareAtPriceMinor,
          imagePath: sql<
            string | null
          >`(SELECT storage_path FROM public.product_images pi WHERE pi.product_id = ${products.id} AND pi.is_primary LIMIT 1)`,
          status: products.status,
        })
        .from(productRecommendations)
        .innerJoin(
          products,
          and(
            eq(products.id, productRecommendations.recommendedProductId),
            eq(products.tenantId, org.tenantId),
          ),
        )
        .where(
          and(
            eq(productRecommendations.tenantId, org.tenantId),
            eq(productRecommendations.productId, productId),
          ),
        )
        .orderBy(asc(productRecommendations.position));

      return rows.map((r) => ({
        id: r.id,
        recommendedProductId: r.recommendedProductId,
        relationKind: r.relationKind,
        position: r.position,
        product: {
          name: r.productName,
          slug: r.productSlug,
          priceMinor: r.priceMinor,
          compareAtPriceMinor: r.compareAtPriceMinor,
          imagePath: r.imagePath,
          available: r.status === 'active',
        },
      }));
    });
  }

  /** Set merchant-picked recommendations for a product. */
  async setRecommendations(
    org: OrgContext,
    user: AuthUser,
    productId: string,
    dto: SetRecommendationsDto,
  ) {
    return this.db.withUser(user.id, async (tx) => {
      const store = await requireStore(tx, org);

      // Verify product exists
      const existingProduct = await tx
        .select({ id: products.id })
        .from(products)
        .where(
          and(eq(products.tenantId, org.tenantId), eq(products.id, productId)),
        )
        .limit(1);

      if (existingProduct.length === 0) {
        throw notFound('Product not found.', 'PRODUCT_NOT_FOUND');
      }

      // Check for self-recommendation
      for (const rec of dto.recommendations) {
        if (rec.recommendedProductId === productId) {
          throw invalid('A product cannot recommend itself.', {
            recommendations: 'Self-recommendation is forbidden.',
          });
        }
      }

      // Verify all recommended products exist in the same tenant
      if (dto.recommendations.length > 0) {
        const recIds = dto.recommendations.map((r) => r.recommendedProductId);
        const validProducts = await tx
          .select({ id: products.id })
          .from(products)
          .where(
            and(
              eq(products.tenantId, org.tenantId),
              inArray(products.id, recIds),
            ),
          );

        if (validProducts.length !== recIds.length) {
          throw invalid(
            'One or more recommended products do not exist in this store.',
            {
              recommendations: 'Invalid product ID.',
            },
          );
        }
      }

      // Delete existing recommendations
      await tx
        .delete(productRecommendations)
        .where(
          and(
            eq(productRecommendations.tenantId, org.tenantId),
            eq(productRecommendations.productId, productId),
          ),
        );

      // Insert new recommendations
      if (dto.recommendations.length > 0) {
        await tx.insert(productRecommendations).values(
          dto.recommendations.map((rec, index) => ({
            tenantId: org.tenantId,
            storeId: store.id,
            productId,
            recommendedProductId: rec.recommendedProductId,
            relationKind: rec.relationKind ?? 'cross_sell',
            position: rec.position ?? index,
            createdBy: user.id,
          })),
        );
      }

      return this.getRecommendations(org, productId);
    });
  }

  /**
   * Public storefront recommendations resolver.
   * Supports sources: 'related', 'merchant_picked', 'collection', 'newest', 'recently_viewed'.
   * Excludes current product; filters to active status; deterministic fallback to newest.
   */
  async getPublicRecommendations(
    slug: string,
    query: PublicRecommendationsQueryDto,
  ): Promise<PublicRecommendedProduct[]> {
    const limit = Math.min(Math.max(query.limit ?? 4, 1), 8);
    const source = query.source ?? 'related';

    return this.db.withPublic(async (tx) => {
      // Find store
      const storeRows = rowsOf<{ id: string; tenant_id: string }>(
        await tx.execute(
          sql`SELECT s.id, s.tenant_id FROM public.stores s WHERE s.slug = ${slug} AND s.status = 'active'`,
        ),
      );
      const store = storeRows[0];
      if (!store) {
        throw notFound('Store not found.', 'STORE_NOT_FOUND');
      }

      let currentProductId: string | null = null;
      let currentCategoryId: string | null = null;

      if (query.productSlug) {
        const currentProdRows = rowsOf<{
          id: string;
          category_id: string | null;
        }>(
          await tx.execute(
            sql`SELECT id, category_id FROM public.products WHERE tenant_id = ${store.tenant_id} AND slug = ${query.productSlug} AND status = 'active'`,
          ),
        );
        if (currentProdRows[0]) {
          currentProductId = currentProdRows[0].id;
          currentCategoryId = currentProdRows[0].category_id;
        }
      }

      const results: PublicRecommendedProduct[] = [];
      const seenIds = new Set<string>();
      if (currentProductId) seenIds.add(currentProductId);

      const addProduct = (p: {
        id: string;
        name: string;
        slug: string;
        price_minor: number;
        compare_at_price_minor: number | null;
        image_path: string | null;
      }) => {
        if (!seenIds.has(p.id) && results.length < limit) {
          seenIds.add(p.id);
          results.push({
            id: p.id,
            name: p.name,
            slug: p.slug,
            priceMinor: p.price_minor,
            compareAtPriceMinor: p.compare_at_price_minor,
            imagePath: p.image_path,
            available: true,
          });
        }
      };

      // 1. Source-specific query
      if (source === 'merchant_picked' && currentProductId) {
        const pickedRows = rowsOf<{
          id: string;
          name: string;
          slug: string;
          price_minor: number;
          compare_at_price_minor: number | null;
          image_path: string | null;
        }>(
          await tx.execute(
            sql`SELECT p.id, p.name, p.slug, p.price_minor, p.compare_at_price_minor,
                       (SELECT storage_path FROM public.product_images pi WHERE pi.product_id = p.id AND pi.is_primary LIMIT 1) as image_path
                FROM public.product_recommendations pr
                JOIN public.products p ON p.id = pr.recommended_product_id AND p.tenant_id = pr.tenant_id AND p.status = 'active'
                WHERE pr.tenant_id = ${store.tenant_id} AND pr.product_id = ${currentProductId}
                ORDER BY pr.position ASC
                LIMIT ${limit}`,
          ),
        );
        for (const p of pickedRows) addProduct(p);
      } else if (source === 'related' && currentProductId) {
        // Related: first try products in the same category
        if (currentCategoryId) {
          const categoryRows = rowsOf<{
            id: string;
            name: string;
            slug: string;
            price_minor: number;
            compare_at_price_minor: number | null;
            image_path: string | null;
          }>(
            await tx.execute(
              sql`SELECT id, name, slug, price_minor, compare_at_price_minor,
                         (SELECT storage_path FROM public.product_images pi WHERE pi.product_id = products.id AND pi.is_primary LIMIT 1) as image_path
                  FROM public.products
                  WHERE tenant_id = ${store.tenant_id}
                    AND category_id = ${currentCategoryId}
                    AND id <> ${currentProductId}
                    AND status = 'active'
                  ORDER BY created_at DESC
                  LIMIT ${limit}`,
            ),
          );
          for (const p of categoryRows) addProduct(p);
        }
      } else if (source === 'collection' && query.collectionSlug) {
        const collRows = rowsOf<{
          id: string;
          name: string;
          slug: string;
          price_minor: number;
          compare_at_price_minor: number | null;
          image_path: string | null;
        }>(
          await tx.execute(
            sql`SELECT p.id, p.name, p.slug, p.price_minor, p.compare_at_price_minor,
                       (SELECT storage_path FROM public.product_images pi WHERE pi.product_id = p.id AND pi.is_primary LIMIT 1) as image_path
                FROM public.collections c
                JOIN public.collection_products pc ON pc.collection_id = c.id AND pc.tenant_id = c.tenant_id
                JOIN public.products p ON p.id = pc.product_id AND p.tenant_id = c.tenant_id AND p.status = 'active'
                WHERE c.tenant_id = ${store.tenant_id} AND c.slug = ${query.collectionSlug} AND c.status = 'active'
                ORDER BY p.created_at DESC
                LIMIT ${limit}`,
          ),
        );
        for (const p of collRows) addProduct(p);
      } else if (source === 'recently_viewed' && query.viewedSlugs) {
        const slugs = query.viewedSlugs
          .split(',')
          .map((s) => s.trim())
          .filter(Boolean)
          .slice(0, 10);

        if (slugs.length > 0) {
          const viewedRows = rowsOf<{
            id: string;
            name: string;
            slug: string;
            price_minor: number;
            compare_at_price_minor: number | null;
            image_path: string | null;
          }>(
            await tx.execute(
              sql`SELECT id, name, slug, price_minor, compare_at_price_minor,
                         (SELECT storage_path FROM public.product_images pi WHERE pi.product_id = products.id AND pi.is_primary LIMIT 1) as image_path
                  FROM public.products
                  WHERE tenant_id = ${store.tenant_id}
                    AND slug = ANY(${slugs})
                    AND status = 'active'`,
            ),
          );
          const map = new Map(viewedRows.map((r) => [r.slug, r]));
          for (const s of slugs) {
            const found = map.get(s);
            if (found) addProduct(found);
          }
        }
      }

      // 2. Deterministic fallback: if results < limit, fill from newest products
      if (results.length < limit) {
        const needed = limit - results.length;
        const fallbackRows = rowsOf<{
          id: string;
          name: string;
          slug: string;
          price_minor: number;
          compare_at_price_minor: number | null;
          image_path: string | null;
        }>(
          await tx.execute(
            sql`SELECT id, name, slug, price_minor, compare_at_price_minor,
                       (SELECT storage_path FROM public.product_images pi WHERE pi.product_id = products.id AND pi.is_primary LIMIT 1) as image_path
                FROM public.products
                WHERE tenant_id = ${store.tenant_id}
                  AND status = 'active'
                  AND id NOT IN (SELECT unnest(${Array.from(seenIds)}::uuid[]))
                ORDER BY created_at DESC
                LIMIT ${needed}`,
          ),
        );
        for (const p of fallbackRows) addProduct(p);
      }

      return results;
    });
  }
}
