import { Injectable } from '@nestjs/common';
import { and, asc, desc, eq, sql } from 'drizzle-orm';
import { rowsOf, type DbTx } from '../../database/database.service.js';
import { products } from '../../database/schema/catalog.js';
import {
  productPresentations,
  type ProductPresentation,
} from '../../database/schema/product-presentations.js';

export type PresentationRow = ProductPresentation & { state: string };

const stateSql = sql<string>`case
  when ${productPresentations.published} is null then 'draft'
  when ${productPresentations.draft} = ${productPresentations.published} then 'published'
  else 'published_with_changes' end`;

/** Draft and live copy differ, and the draft is not just the empty "inherit everything" document of a never-published row. */
const needsPublish = sql`(${productPresentations.draft} is distinct from ${productPresentations.published}
  and not (${productPresentations.published} is null
           and ${productPresentations.draft} = '{"schemaVersion": 1}'::jsonb))`;

/**
 * Every query for product presentations. The caller always passes a transaction from `DatabaseService.withUser`, so
 * Postgres row level security applies to each statement; the explicit tenant and store filters are a second guard.
 * The insert is raw SQL because the app role may only insert specific columns (migration 0032).
 */
@Injectable()
export class ProductPresentationsRepository {
  /** True when the product exists in this tenant (RLS and the tenant filter both apply). */
  async productExists(
    tx: DbTx,
    tenantId: string,
    productId: string,
  ): Promise<boolean> {
    const [row] = await tx
      .select({ id: products.id })
      .from(products)
      .where(and(eq(products.id, productId), eq(products.tenantId, tenantId)))
      .limit(1);
    return Boolean(row);
  }

  async list(
    tx: DbTx,
    tenantId: string,
    storeId: string,
    limit: number,
    offset: number,
  ): Promise<{ rows: PresentationRow[]; total: number }> {
    const where = and(
      eq(productPresentations.tenantId, tenantId),
      eq(productPresentations.storeId, storeId),
    );
    const [{ total } = { total: 0 }] = await tx
      .select({ total: sql<number>`count(*)::int` })
      .from(productPresentations)
      .where(where);
    const rows = await tx
      .select({ row: productPresentations, state: stateSql })
      .from(productPresentations)
      .where(where)
      .orderBy(
        desc(productPresentations.updatedAt),
        asc(productPresentations.productId),
      )
      .limit(limit)
      .offset(offset);
    return { rows: rows.map((r) => ({ ...r.row, state: r.state })), total };
  }

  async get(
    tx: DbTx,
    tenantId: string,
    storeId: string,
    productId: string,
  ): Promise<PresentationRow | null> {
    const [r] = await tx
      .select({ row: productPresentations, state: stateSql })
      .from(productPresentations)
      .where(
        and(
          eq(productPresentations.productId, productId),
          eq(productPresentations.tenantId, tenantId),
          eq(productPresentations.storeId, storeId),
        ),
      )
      .limit(1);
    return r ? { ...r.row, state: r.state } : null;
  }

  /** Locks the row for the rest of the transaction so two saves or publishes cannot interleave. */
  async lock(
    tx: DbTx,
    tenantId: string,
    storeId: string,
    productId: string,
  ): Promise<ProductPresentation | null> {
    const [row] = await tx
      .select()
      .from(productPresentations)
      .where(
        and(
          eq(productPresentations.productId, productId),
          eq(productPresentations.tenantId, tenantId),
          eq(productPresentations.storeId, storeId),
        ),
      )
      .for('update')
      .limit(1);
    return row ?? null;
  }

  /** Creates the row unless one already exists (a concurrent create): returns whether this call created it. */
  async insertIfAbsent(
    tx: DbTx,
    v: {
      tenantId: string;
      storeId: string;
      productId: string;
      draft: Record<string, unknown>;
    },
  ): Promise<boolean> {
    const rows = rowsOf<{ product_id: string }>(
      await tx.execute(sql`
        insert into public.product_presentations (tenant_id, store_id, product_id, draft)
        values (${v.tenantId}, ${v.storeId}, ${v.productId}, ${JSON.stringify(v.draft)}::jsonb)
        on conflict (product_id) do nothing
        returning product_id`),
    );
    return rows.length === 1;
  }

  /** Writes the draft only if nobody saved in between (`expectedRevision`); returns whether a row was changed. */
  async updateDraft(
    tx: DbTx,
    v: {
      tenantId: string;
      storeId: string;
      productId: string;
      draft: Record<string, unknown>;
      expectedRevision: number;
    },
  ): Promise<boolean> {
    const rows = await tx
      .update(productPresentations)
      .set({ draft: v.draft })
      .where(
        and(
          eq(productPresentations.productId, v.productId),
          eq(productPresentations.tenantId, v.tenantId),
          eq(productPresentations.storeId, v.storeId),
          eq(productPresentations.revision, v.expectedRevision),
        ),
      )
      .returning({ productId: productPresentations.productId });
    return rows.length === 1;
  }

  async setPublished(
    tx: DbTx,
    v: {
      tenantId: string;
      storeId: string;
      productId: string;
      published: Record<string, unknown>;
    },
  ): Promise<void> {
    await tx
      .update(productPresentations)
      .set({ published: v.published })
      .where(
        and(
          eq(productPresentations.productId, v.productId),
          eq(productPresentations.tenantId, v.tenantId),
          eq(productPresentations.storeId, v.storeId),
        ),
      );
  }

  async remove(
    tx: DbTx,
    tenantId: string,
    storeId: string,
    productId: string,
  ): Promise<void> {
    await tx
      .delete(productPresentations)
      .where(
        and(
          eq(productPresentations.productId, productId),
          eq(productPresentations.tenantId, tenantId),
          eq(productPresentations.storeId, storeId),
        ),
      );
  }

  /**
   * Locks and returns every row of the store whose draft is waiting to go live, in product-id order so two
   * publish-all calls can never deadlock on each other.
   */
  async lockPublishCandidates(
    tx: DbTx,
    tenantId: string,
    storeId: string,
  ): Promise<ProductPresentation[]> {
    return tx
      .select()
      .from(productPresentations)
      .where(
        and(
          eq(productPresentations.tenantId, tenantId),
          eq(productPresentations.storeId, storeId),
          needsPublish,
        ),
      )
      .orderBy(asc(productPresentations.productId))
      .for('update');
  }
}
