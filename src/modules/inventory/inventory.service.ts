import { Injectable } from '@nestjs/common';
import { and, desc, eq, sql } from 'drizzle-orm';
import { invalid, notFound } from '../../common/app.exception.js';
import { mapErrors } from '../../common/db-errors.js';
import { Paginated } from '../../common/dto/api-response.dto.js';
import { likeTerm, offsetOf } from '../../common/dto/pagination-query.dto.js';
import type { OrgContext } from '../../common/interfaces/request-context.js';
import {
  DatabaseService,
  rowsOf,
  type DbTx,
} from '../../database/database.service.js';
import {
  inventoryAdjustments,
  products,
  productVariants,
} from '../../database/schema/index.js';
import type {
  AdjustmentDto,
  AdjustStockDto,
  InventoryQueryDto,
  InventoryRowDto,
  StockLevelDto,
  StockState,
} from './inventory.dto.js';

export interface InventoryFilter {
  search: string;
  stock: 'all' | StockState;
  page: number;
  limit: number;
}

/**
 * One row per sellable unit: a simple product, or each ACTIVE variant of a product with variants.
 * Stock is never shared between variants.
 */
export async function listInventoryInTx(
  tx: DbTx,
  tenantId: string,
  q: InventoryFilter,
): Promise<Paginated<InventoryRowDto>> {
  const term = q.search ? likeTerm(q.search) : null;
  const filters = sql`
    where u.tenant_id = ${tenantId}
    ${term ? sql`and (u.product_name ilike ${term} or u.sku ilike ${term} or u.variant_title ilike ${term})` : sql``}
    ${q.stock === 'all' ? sql`` : sql`and u.state = ${q.stock}`}`;
  const units = sql`(
    select p.tenant_id, p.id as product_id, null::uuid as variant_id, p.name as product_name, null::text as variant_title,
           p.sku, p.quantity, p.track_inventory as tracked, p.low_stock_threshold as threshold,
           case when not p.track_inventory then 'untracked' when p.quantity <= 0 then 'out'
                when p.quantity <= p.low_stock_threshold then 'low' else 'in' end as state
    from public.products p where not p.has_variants
    union all
    select v.tenant_id, p.id, v.id, p.name, v.title, v.sku, v.quantity, p.track_inventory, p.low_stock_threshold,
           case when not p.track_inventory then 'untracked' when v.quantity <= 0 then 'out'
                when v.quantity <= p.low_stock_threshold then 'low' else 'in' end
    from public.product_variants v join public.products p on p.id = v.product_id
    where p.has_variants and v.is_active
  ) u`;

  const rows = rowsOf<Record<string, unknown>>(
    await tx.execute(sql`
      select u.product_id, u.variant_id, u.product_name, u.variant_title, u.sku, u.quantity::int as quantity,
             u.tracked, u.threshold::int as threshold, u.state
      from ${units} ${filters}
      order by (case u.state when 'out' then 0 when 'low' then 1 else 2 end), u.product_name, u.variant_title nulls first
      limit ${q.limit} offset ${offsetOf(q)}`),
  );
  const [{ total }] = rowsOf<{ total: number }>(
    await tx.execute(
      sql`select count(*)::int as total from ${units} ${filters}`,
    ),
  );
  return new Paginated(
    rows.map((r) => ({
      productId: r.product_id as string,
      variantId: (r.variant_id as string | null) ?? null,
      productName: r.product_name as string,
      variantTitle: (r.variant_title as string | null) ?? null,
      sku: (r.sku as string | null) ?? null,
      quantity: Number(r.quantity),
      tracked: Boolean(r.tracked),
      threshold: Number(r.threshold),
      state: r.state as StockState,
    })),
    { page: q.page, limit: q.limit, total },
  );
}

@Injectable()
export class InventoryService {
  constructor(private readonly db: DatabaseService) {}

  list(ctx: OrgContext, q: InventoryQueryDto) {
    return this.db.withUser(ctx.userId, (tx) =>
      listInventoryInTx(tx, ctx.tenantId, {
        search: q.search,
        stock: q.stock,
        page: q.page,
        limit: q.limit,
      }),
    );
  }

  async listAdjustments(
    ctx: OrgContext,
    limit: number,
  ): Promise<AdjustmentDto[]> {
    return this.db.withUser(ctx.userId, async (tx) => {
      const rows = await tx
        .select({
          adj: inventoryAdjustments,
          productName: products.name,
          variantTitle: productVariants.title,
        })
        .from(inventoryAdjustments)
        .innerJoin(products, eq(products.id, inventoryAdjustments.productId))
        .leftJoin(
          productVariants,
          eq(productVariants.id, inventoryAdjustments.variantId),
        )
        .where(eq(inventoryAdjustments.tenantId, ctx.tenantId))
        .orderBy(desc(inventoryAdjustments.createdAt))
        .limit(limit);
      return rows.map((r) => ({
        id: r.adj.id,
        productId: r.adj.productId,
        variantId: r.adj.variantId,
        productName: r.productName,
        variantTitle: r.variantTitle,
        delta: r.adj.delta,
        quantityAfter: r.adj.quantityAfter,
        reason: r.adj.reason,
        note: r.adj.note,
        createdBy: r.adj.createdBy,
        createdAt: r.adj.createdAt,
      }));
    });
  }

  /**
   * Changes stock and writes the ledger row in ONE transaction. The row is locked (FOR UPDATE) so concurrent
   * adjustments serialise, and the quantity >= 0 CHECK constraint is the final guard against negative stock.
   */
  async adjust(ctx: OrgContext, v: AdjustStockDto): Promise<StockLevelDto> {
    const variantId = v.variantId ?? null;
    return this.db.withUser(ctx.userId, (tx) =>
      mapErrors(async () => {
        const [product] = await tx
          .select({
            id: products.id,
            track: products.trackInventory,
            hasVariants: products.hasVariants,
            quantity: products.quantity,
          })
          .from(products)
          .where(
            and(
              eq(products.id, v.productId),
              eq(products.tenantId, ctx.tenantId),
            ),
          )
          .for('update');
        if (!product)
          throw notFound('That product no longer exists.', 'PRODUCT_NOT_FOUND');
        if (!product.track)
          throw invalid(
            'Inventory is not tracked for this product. Turn on tracking first.',
            undefined,
            'INVENTORY_NOT_TRACKED',
          );

        let current: number;
        if (product.hasVariants) {
          if (!variantId)
            throw invalid(
              'Choose which variant to adjust.',
              { variantId: 'Required for products with variants' },
              'VARIANT_REQUIRED',
            );
          const [variant] = await tx
            .select({ quantity: productVariants.quantity })
            .from(productVariants)
            .where(
              and(
                eq(productVariants.id, variantId),
                eq(productVariants.productId, v.productId),
                eq(productVariants.tenantId, ctx.tenantId),
              ),
            )
            .for('update');
          if (!variant)
            throw notFound(
              'That variant no longer exists.',
              'VARIANT_NOT_FOUND',
            );
          current = variant.quantity;
        } else {
          if (variantId)
            throw invalid(
              'This product has no variants.',
              { variantId: 'This product has no variants' },
              'NO_VARIANTS',
            );
          current = product.quantity;
        }

        const next = v.mode === 'set' ? v.value : current + v.value;
        if (v.mode === 'set' && v.value < 0)
          throw invalid(
            'Stock cannot be negative.',
            { value: 'Stock cannot be negative.' },
            'NEGATIVE_STOCK',
          );
        if (v.mode === 'add' && v.value === 0)
          throw invalid('Enter a quantity other than zero.', {
            value: 'Enter a quantity other than zero.',
          });
        if (next < 0)
          throw invalid(
            `Stock cannot go below zero (currently ${current}).`,
            { value: 'Would make stock negative' },
            'NEGATIVE_STOCK',
          );
        const delta = next - current;
        if (delta === 0)
          throw invalid(
            'That is already the current stock level.',
            { value: 'No change' },
            'NO_CHANGE',
          );

        if (variantId)
          await tx
            .update(productVariants)
            .set({ quantity: next })
            .where(eq(productVariants.id, variantId));
        else
          await tx
            .update(products)
            .set({ quantity: next })
            .where(eq(products.id, v.productId));
        await tx.insert(inventoryAdjustments).values({
          tenantId: ctx.tenantId,
          productId: v.productId,
          variantId,
          delta,
          quantityAfter: next,
          reason: v.reason,
          note: v.note ?? null,
          createdBy: ctx.userId,
        });
        return { quantity: next };
      }),
    );
  }
}
