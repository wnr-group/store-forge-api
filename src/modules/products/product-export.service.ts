import { Injectable } from '@nestjs/common';
import { and, asc, eq, sql, type SQL } from 'drizzle-orm';
import { notFound } from '../../common/app.exception.js';
import type { OrgContext } from '../../common/interfaces/request-context.js';
import { minorToInput } from '../../common/utils/money.js';
import { escapeCell } from '../../common/utils/spreadsheet.js';
import { DatabaseService } from '../../database/database.service.js';
import { categories, products } from '../../database/schema/index.js';
import { getPrimaryStoreInTx } from '../store/store.service.js';
import type {
  ProductExportDto,
  ProductExportQueryDto,
} from './product-export.dto.js';

export const PRODUCT_EXPORT_COLUMNS = [
  'id',
  'name',
  'slug',
  'sku',
  'part_number',
  'price',
  'compare_at_price',
  'cost',
  'quantity',
  'track_inventory',
  'low_stock_threshold',
  'status',
  'short_description',
  'description',
  'product_type',
  'category',
  'subcategory',
  'has_variants',
] as const;

/**
 * Products as rows in the product import format, a page at a time, so a catalog can be edited in a spreadsheet and sent
 * back. The part number is exported next to the SKU; neither is used to match anything on the way back in (the import only
 * creates products). Formula-like text carries a leading apostrophe, which the import removes again.
 */
@Injectable()
export class ProductExportService {
  constructor(private readonly db: DatabaseService) {}

  async export(
    ctx: OrgContext,
    q: ProductExportQueryDto,
  ): Promise<ProductExportDto> {
    return this.db.withUser(ctx.userId, async (tx) => {
      const store = await getPrimaryStoreInTx(tx, ctx.tenantId);
      if (!store)
        throw notFound(
          'This workspace does not have a store.',
          'STORE_NOT_FOUND',
        );
      const where: SQL[] = [eq(products.tenantId, ctx.tenantId)];
      if (q.status !== 'all') where.push(eq(products.status, q.status));
      const filter = and(...where) as SQL;
      const [rows, [{ total }], cats] = await Promise.all([
        tx
          .select()
          .from(products)
          .where(filter)
          .orderBy(asc(products.createdAt), asc(products.id))
          .limit(q.limit)
          .offset((q.page - 1) * q.limit),
        tx
          .select({ total: sql<number>`count(*)::int` })
          .from(products)
          .where(filter),
        tx
          .select({
            id: categories.id,
            name: categories.name,
            parentId: categories.parentId,
          })
          .from(categories)
          .where(eq(categories.tenantId, ctx.tenantId)),
      ]);
      const category = new Map(cats.map((c) => [c.id, c]));
      const text = (v: string | null) => (v === null ? '' : escapeCell(v));
      const money = (minor: number | null) =>
        minor === null ? '' : minorToInput(minor, store.currency);
      return {
        columns: [...PRODUCT_EXPORT_COLUMNS],
        rows: rows.map((p) => {
          const c = p.categoryId ? category.get(p.categoryId) : undefined;
          const parent = c?.parentId ? category.get(c.parentId) : undefined;
          return {
            id: p.id,
            name: escapeCell(p.name),
            slug: p.slug,
            sku: text(p.sku),
            part_number: text(p.partNumber),
            price: money(p.priceMinor),
            compare_at_price: money(p.compareAtPriceMinor),
            cost: money(p.costMinor),
            quantity: String(p.quantity),
            track_inventory: p.trackInventory ? 'true' : 'false',
            low_stock_threshold: String(p.lowStockThreshold),
            status: p.status,
            short_description: text(p.shortDescription),
            description: text(p.description),
            product_type: text(p.productType),
            // The import reads "category" = the top category and "subcategory" = the one below it.
            category: text(parent ? parent.name : (c?.name ?? null)),
            subcategory: text(parent ? (c?.name ?? null) : null),
            has_variants: p.hasVariants ? 'true' : 'false',
          };
        }),
        page: q.page,
        limit: q.limit,
        total,
        totalPages: Math.max(1, Math.ceil(total / q.limit)),
      };
    });
  }
}
