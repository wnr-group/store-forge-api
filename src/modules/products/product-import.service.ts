import { Injectable } from '@nestjs/common';
import { and, eq, inArray } from 'drizzle-orm';
import { AppException, notFound } from '../../common/app.exception.js';
import { mapErrors } from '../../common/db-errors.js';
import type { OrgContext } from '../../common/interfaces/request-context.js';
import { DatabaseService } from '../../database/database.service.js';
import { categories, products } from '../../database/schema/index.js';
import { getPrimaryStoreInTx } from '../store/store.service.js';
import type { ImportProductsDto } from './product-import.dto.js';
import {
  assignSlugs,
  capErrors,
  findConflicts,
  findInFileDuplicates,
  initialSlugWindows,
  resolveCategories,
  slugCandidates,
  validateRow,
  type RowError,
  type ValidRow,
} from './product-import.rules.js';
import { ProductsService } from './products.service.js';

@Injectable()
export class ProductImportService {
  constructor(
    private readonly db: DatabaseService,
    private readonly productsService: ProductsService,
  ) {}

  async import(
    ctx: OrgContext,
    dto: ImportProductsDto,
  ): Promise<{ count: number }> {
    // 1. Pure phase: no database.
    const errors: RowError[] = [];
    const valid: ValidRow[] = [];
    for (const row of dto.rows) {
      const r = await validateRow(row);
      errors.push(...r.errors);
      if (r.valid) valid.push(r.valid);
    }
    errors.push(...findInFileDuplicates(valid));

    // 2. Read phase: one read-only unit, before any write.
    const skus = valid.flatMap((r) => (r.sku ? [r.sku] : []));
    const slugs = valid.flatMap((r) =>
      r.explicitSlug ? [r.explicitSlug] : [],
    );
    const read = await this.db.withUser(ctx.userId, async (tx) => {
      const store = await getPrimaryStoreInTx(tx, ctx.tenantId);
      if (!store)
        throw notFound(
          'This workspace does not have a store.',
          'STORE_NOT_FOUND',
        );
      const cats = await tx
        .select({
          id: categories.id,
          name: categories.name,
          slug: categories.slug,
          parentId: categories.parentId,
        })
        .from(categories)
        .where(eq(categories.tenantId, ctx.tenantId));
      const skuRows = skus.length
        ? await tx
            .select({ v: products.sku })
            .from(products)
            .where(
              and(
                eq(products.tenantId, ctx.tenantId),
                inArray(products.sku, skus),
              ),
            )
        : [];
      const slugRows = slugs.length
        ? await tx
            .select({ v: products.slug })
            .from(products)
            .where(
              and(
                eq(products.tenantId, ctx.tenantId),
                inArray(products.slug, slugs),
              ),
            )
        : [];
      // Slugs for rows without one are allocated in memory (file order) from indexed lookups of just the candidates:
      // calling uniqueSlug per row costs one RLS-filtered scan each, which grows with catalog size.
      const windows = initialSlugWindows(valid);
      let generated = new Map<number, string>();
      for (let pass = 0; pass < 12 && windows.size > 0; pass++) {
        const candidates = slugCandidates(windows);
        const takenSlugs = new Set<string>();
        for (let i = 0; i < candidates.length; i += 2000) {
          const rows = await tx
            .select({ v: products.slug })
            .from(products)
            .where(
              and(
                eq(products.tenantId, ctx.tenantId),
                inArray(products.slug, candidates.slice(i, i + 2000)),
              ),
            );
          for (const x of rows) takenSlugs.add(x.v);
        }
        const out = assignSlugs(valid, takenSlugs, windows);
        generated = out.slugs;
        if (out.short.size === 0) break;
        for (const root of out.short)
          windows.set(root, (windows.get(root) ?? 1) * 2 + 4);
      }
      return {
        currency: store.currency,
        cats,
        skus: new Set(skuRows.map((x) => x.v ?? '')),
        slugs: new Set(slugRows.map((x) => x.v)),
        generated,
      };
    });
    const resolved = resolveCategories(valid, read.cats);
    errors.push(
      ...resolved.errors,
      ...findConflicts(valid, read.skus, read.slugs),
    );

    // 3. Any error (parser or API): nothing is written and no transaction is opened.
    if (errors.length > 0)
      throw new AppException(
        'VALIDATION',
        'No products were imported. Fix the rows below and upload the file again.',
        {
          code: 'PRODUCT_IMPORT_INVALID',
          details: capErrors(errors),
        },
      );

    // 4. Write phase: one transaction, all or nothing, rows inserted in spreadsheet order.
    // Slugs were allocated in the read phase (explicit slugs anywhere in the file are reserved), so no per-row lookup here.
    const rows = valid;
    await mapErrors(() =>
      this.db.withUser(ctx.userId, async (tx) => {
        const categoryIds = [...resolved.ids.values()].filter(
          (id): id is string => id !== null,
        );
        await this.productsService.assertCategories(
          tx,
          ctx.tenantId,
          categoryIds,
        );
        for (const r of rows)
          await this.productsService.insertNewProductInTx(
            tx,
            ctx.tenantId,
            {
              ...r.values,
              categoryId: resolved.ids.get(r.row) ?? null,
              slug: r.explicitSlug ?? read.generated.get(r.row),
            },
            read.currency,
            { skipCategoryCheck: true },
          );
      }),
    );
    return { count: rows.length };
  }
}
