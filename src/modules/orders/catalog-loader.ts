import { sql } from 'drizzle-orm';
import { rowsOf, type DbTx } from '../../database/database.service.js';
import type {
  CatalogProduct,
  CatalogVariant,
  RequestedLine,
} from './checkout-pricing.js';

/**
 * Reads the catalog rows a cart refers to. The checkout locks them (FOR UPDATE, products by id then variants by id: one global
 * order, so two checkouts cannot deadlock); a shipping quote only reads. Either way the numbers come from the database, never
 * from the browser.
 */
export async function loadCatalog(
  tx: DbTx,
  tenantId: string,
  requested: readonly RequestedLine[],
  lock: boolean,
): Promise<{ products: CatalogProduct[]; variants: CatalogVariant[] }> {
  const slugs = [...new Set(requested.map((l) => l.productSlug))];
  const products = rowsOf<{
    id: string;
    slug: string;
    name: string;
    sku: string | null;
    status: string;
    price_minor: number;
    has_variants: boolean;
    track_inventory: boolean;
    quantity: number;
    weight_grams: number;
  }>(
    await tx.execute(sql`
      select id, slug, name, sku, status, price_minor::float8 as price_minor, has_variants, track_inventory, quantity, weight_grams
      from public.products
      where tenant_id = ${tenantId}::uuid and slug in (${sql.join(
        slugs.map((s) => sql`${s}`),
        sql`, `,
      )})
      order by id ${lock ? sql`for update` : sql``}`),
  ).map((p): CatalogProduct => ({
    id: p.id,
    slug: p.slug,
    name: p.name,
    sku: p.sku,
    status: p.status,
    priceMinor: Number(p.price_minor),
    hasVariants: p.has_variants,
    trackInventory: p.track_inventory,
    quantity: p.quantity,
    weightGrams: p.weight_grams,
  }));

  const variantIds = [
    ...new Set(requested.flatMap((l) => (l.variantId ? [l.variantId] : []))),
  ];
  const variants = variantIds.length
    ? rowsOf<{
        id: string;
        product_id: string;
        title: string;
        sku: string | null;
        price_minor: number;
        is_active: boolean;
        quantity: number;
      }>(
        await tx.execute(sql`
          select id, product_id, title, sku, price_minor::float8 as price_minor, is_active, quantity
          from public.product_variants
          where tenant_id = ${tenantId}::uuid and id in (${sql.join(
            variantIds.map((v) => sql`${v}::uuid`),
            sql`, `,
          )})
          order by id ${lock ? sql`for update` : sql``}`),
      ).map((v): CatalogVariant => ({
        id: v.id,
        productId: v.product_id,
        title: v.title,
        sku: v.sku,
        priceMinor: Number(v.price_minor),
        isActive: v.is_active,
        quantity: v.quantity,
      }))
    : [];
  return { products, variants };
}
