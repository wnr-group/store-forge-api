import { Injectable } from '@nestjs/common';
import {
  and,
  asc,
  desc,
  eq,
  ilike,
  inArray,
  or,
  sql,
  type SQL,
} from 'drizzle-orm';
import { invalid, notFound } from '../../common/app.exception.js';
import { mapErrors } from '../../common/db-errors.js';
import { Paginated } from '../../common/dto/api-response.dto.js';
import { likeTerm, offsetOf } from '../../common/dto/pagination-query.dto.js';
import type {
  AuthUser,
  OrgContext,
} from '../../common/interfaces/request-context.js';
import {
  currencyDigits,
  minorToInput,
  parseMoney,
} from '../../common/utils/money.js';
import { slugify } from '../../common/utils/slug.js';
import { DatabaseService, type DbTx } from '../../database/database.service.js';
import {
  categories,
  collectionProducts,
  collections,
  productImages,
  productOptions,
  products,
  productVariants,
} from '../../database/schema/index.js';
import { productFolder } from '../storage/storage-paths.js';
import { StorageReferencesService } from '../storage/storage-references.service.js';
import { getPrimaryStoreInTx } from '../store/store.service.js';
import type {
  BulkCountDto,
  CreateProductDto,
  ProductDetailDto,
  ProductListItemDto,
  ProductListQueryDto,
  UpdateProductDto,
} from './products.dto.js';
import {
  assertProductRules,
  type ProductValues,
  type VariantValues,
} from './product-rules.js';

const productNotFound = () =>
  notFound('That product no longer exists.', 'PRODUCT_NOT_FOUND');

// NOTE: correlated subqueries use explicit "products"."id": Drizzle omits the table qualifier in single-table
// selects, and a bare "id" would silently bind to the INNER table.
/** Stock the merchant can actually sell: variant total for products with variants, else the product quantity. */
const effectiveStock = sql<number>`case when "products"."has_variants"
  then coalesce((select sum(v.quantity) from "product_variants" v where v.product_id = "products"."id" and v.is_active), 0)
  else "products"."quantity" end`;

/** Converts typed money to minor units; the store currency decides how many decimals are allowed. */
function money(
  value: string | null,
  currency: string,
  label: string,
  field: string,
): number | null {
  if (value === null) return null;
  const minor = parseMoney(value, currency);
  if (minor === null) {
    const digits = currencyDigits(currency);
    const hint =
      digits === 0 ? 'a whole amount' : `at most ${digits} decimal places`;
    throw invalid(
      `${label} must be a valid amount (${hint} for ${currency}).`,
      { [field]: `Use ${hint}.` },
      'INVALID_AMOUNT',
    );
  }
  return minor;
}

type ProductRow = typeof products.$inferSelect;
type Detail = {
  product: ProductRow;
  options: (typeof productOptions.$inferSelect)[];
  variants: (typeof productVariants.$inferSelect)[];
  images: (typeof productImages.$inferSelect)[];
  collectionIds: string[];
};

const toDetailDto = (d: Detail): ProductDetailDto => {
  const { tenantId: _tenant, ...product } = d.product;
  return {
    ...product,
    options: d.options.map(({ tenantId: _t, productId: _p, ...o }) => o),
    variants: d.variants.map(({ tenantId: _t, productId: _p, ...v }) => v),
    images: d.images.map(({ tenantId: _t, productId: _p, ...i }) => i),
    collectionIds: d.collectionIds,
  };
};

@Injectable()
export class ProductsService {
  constructor(
    private readonly db: DatabaseService,
    private readonly references: StorageReferencesService,
  ) {}

  // -------------------------------------------------------------------------------------------------------------------
  // Reads
  // -------------------------------------------------------------------------------------------------------------------

  private filters(tenantId: string, q: ProductListQueryDto): SQL {
    const where: (SQL | undefined)[] = [eq(products.tenantId, tenantId)];
    if (q.search) {
      const term = likeTerm(q.search);
      where.push(or(ilike(products.name, term), ilike(products.sku, term)));
    }
    if (q.status !== 'all') where.push(eq(products.status, q.status));
    if (q.category === 'none') where.push(sql`${products.categoryId} is null`);
    else if (q.category !== 'all')
      where.push(eq(products.categoryId, q.category));
    switch (q.stock) {
      case 'untracked':
        where.push(eq(products.trackInventory, false));
        break;
      case 'out':
        where.push(sql`${products.trackInventory} and ${effectiveStock} <= 0`);
        break;
      case 'low':
        where.push(
          sql`${products.trackInventory} and ${effectiveStock} > 0 and ${effectiveStock} <= ${products.lowStockThreshold}`,
        );
        break;
      case 'in':
        where.push(
          sql`${products.trackInventory} and ${effectiveStock} > ${products.lowStockThreshold}`,
        );
        break;
    }
    return and(...where) as SQL;
  }

  /** Server-side search / filter / sort / pagination. Only one page of rows ever leaves the database. */
  async list(
    ctx: OrgContext,
    q: ProductListQueryDto,
  ): Promise<Paginated<ProductListItemDto>> {
    return this.db.withUser(ctx.userId, async (tx) => {
      const where = this.filters(ctx.tenantId, q);
      const dir = q.sortOrder === 'asc' ? asc : desc;
      const order =
        q.sortBy === 'name'
          ? dir(products.name)
          : q.sortBy === 'price'
            ? dir(products.priceMinor)
            : dir(products.createdAt);

      const [rows, [{ total }]] = await Promise.all([
        tx
          .select({
            id: products.id,
            name: products.name,
            slug: products.slug,
            sku: products.sku,
            status: products.status,
            priceMinor: products.priceMinor,
            hasVariants: products.hasVariants,
            variantCount: sql<number>`(select count(*)::int from "product_variants" v where v.product_id = "products"."id")`,
            trackInventory: products.trackInventory,
            stock: sql<number>`${effectiveStock}::int`,
            lowStockThreshold: products.lowStockThreshold,
            categoryName: categories.name,
            imagePath: sql<
              string | null
            >`(select i.storage_path from "product_images" i where i.product_id = "products"."id" order by i.is_primary desc, i.position asc limit 1)`,
            updatedAt: products.updatedAt,
            createdAt: products.createdAt,
          })
          .from(products)
          .leftJoin(categories, eq(categories.id, products.categoryId))
          .where(where)
          .orderBy(order, asc(products.id))
          .limit(q.limit)
          .offset(offsetOf(q)),
        tx
          .select({ total: sql<number>`count(*)::int` })
          .from(products)
          .where(where),
      ]);
      return new Paginated(rows, { page: q.page, limit: q.limit, total });
    });
  }

  private async detailInTx(
    tx: DbTx,
    tenantId: string,
    id: string,
  ): Promise<Detail | null> {
    const [product] = await tx
      .select()
      .from(products)
      .where(and(eq(products.id, id), eq(products.tenantId, tenantId)));
    if (!product) return null;
    const [options, variants, images, links] = await Promise.all([
      tx
        .select()
        .from(productOptions)
        .where(eq(productOptions.productId, id))
        .orderBy(asc(productOptions.position)),
      tx
        .select()
        .from(productVariants)
        .where(eq(productVariants.productId, id))
        .orderBy(asc(productVariants.position), asc(productVariants.title)),
      tx
        .select()
        .from(productImages)
        .where(eq(productImages.productId, id))
        .orderBy(asc(productImages.position)),
      tx
        .select({ id: collectionProducts.collectionId })
        .from(collectionProducts)
        .where(eq(collectionProducts.productId, id)),
    ]);
    return {
      product,
      options,
      variants,
      images,
      collectionIds: links.map((l) => l.id),
    };
  }

  async get(ctx: OrgContext, id: string): Promise<ProductDetailDto> {
    const detail = await this.db.withUser(ctx.userId, (tx) =>
      this.detailInTx(tx, ctx.tenantId, id),
    );
    if (!detail) throw productNotFound();
    return toDetailDto(detail);
  }

  // -------------------------------------------------------------------------------------------------------------------
  // Writes (ported from services/product.service.ts)
  // -------------------------------------------------------------------------------------------------------------------

  private async uniqueSlug(
    tx: DbTx,
    tenantId: string,
    base: string,
    excludeId?: string,
  ): Promise<string> {
    // The DB check requires 2-80 chars; pad one-letter names ("A" -> "a-item").
    const root = base.length >= 2 ? base : `${base || 'product'}-item`;
    const taken = await tx
      .select({ slug: products.slug })
      .from(products)
      .where(
        and(
          eq(products.tenantId, tenantId),
          or(eq(products.slug, root), ilike(products.slug, `${root}-%`)),
          excludeId ? sql`${products.id} <> ${excludeId}` : undefined,
        ),
      );
    const used = new Set(taken.map((t) => t.slug));
    if (!used.has(root)) return root;
    for (let n = 2; n < 1000; n++)
      if (!used.has(`${root}-${n}`)) return `${root}-${n}`;
    return `${root}-${Date.now()}`;
  }

  private async replaceOptions(
    tx: DbTx,
    tenantId: string,
    productId: string,
    v: ProductValues,
  ) {
    await tx
      .delete(productOptions)
      .where(eq(productOptions.productId, productId));
    if (v.options.length)
      await tx.insert(productOptions).values(
        v.options.map((o, i) => ({
          tenantId,
          productId,
          name: o.name,
          values: o.values,
          position: i,
        })),
      );
  }

  private async syncVariants(
    tx: DbTx,
    tenantId: string,
    productId: string,
    v: ProductValues,
    currency: string,
    imageIdMap: Map<string, string>,
  ) {
    const existing = await tx
      .select({ id: productVariants.id })
      .from(productVariants)
      .where(eq(productVariants.productId, productId));
    const existingIds = new Set(existing.map((e) => e.id));
    const keep = new Set(
      v.variants.flatMap((x) => (x.id && existingIds.has(x.id) ? [x.id] : [])),
    );
    const removed = [...existingIds].filter((id) => !keep.has(id));
    if (removed.length)
      await tx
        .delete(productVariants)
        .where(
          and(
            eq(productVariants.productId, productId),
            inArray(productVariants.id, removed),
          ),
        );

    for (const [position, x] of v.variants.entries()) {
      const row = {
        title: Object.values(x.options).join(' / '),
        options: x.options,
        sku: x.sku,
        priceMinor:
          money(
            x.price,
            currency,
            'Variant price',
            `variants.${position}.price`,
          ) ?? 0,
        compareAtPriceMinor: money(
          x.compareAtPrice,
          currency,
          'Compare-at price',
          `variants.${position}.compareAtPrice`,
        ),
        quantity: x.quantity,
        imageId: x.imagePath ? (imageIdMap.get(x.imagePath) ?? null) : null,
        isActive: x.isActive,
        position,
      };
      if (x.id && existingIds.has(x.id))
        await tx
          .update(productVariants)
          .set(row)
          .where(
            and(
              eq(productVariants.id, x.id),
              eq(productVariants.productId, productId),
            ),
          );
      else
        await tx
          .insert(productVariants)
          .values({ ...row, tenantId, productId });
    }
  }

  /** Reconciles image rows: verified new uploads are inserted, removed ones deleted, order/primary/alt updated. */
  private async syncImages(
    tx: DbTx,
    tenantId: string,
    productId: string,
    v: ProductValues,
    verified: Map<string, { mimeType: string; sizeBytes: number }>,
  ) {
    const existing = await tx
      .select()
      .from(productImages)
      .where(eq(productImages.productId, productId));
    const byPath = new Map(existing.map((e) => [e.storagePath, e]));
    const wanted = new Set(v.images.map((i) => i.path));
    const removed = existing.filter((e) => !wanted.has(e.storagePath));
    if (removed.length)
      await tx.delete(productImages).where(
        and(
          eq(productImages.productId, productId),
          inArray(
            productImages.id,
            removed.map((r) => r.id),
          ),
        ),
      );

    // Clear the primary flag first so the one-primary unique index never trips mid-update.
    await tx
      .update(productImages)
      .set({ isPrimary: false })
      .where(eq(productImages.productId, productId));
    const idByPath = new Map<string, string>();
    for (const [position, img] of v.images.entries()) {
      const found = byPath.get(img.path);
      if (found) {
        await tx
          .update(productImages)
          .set({ position, isPrimary: position === 0, altText: img.altText })
          .where(eq(productImages.id, found.id));
        idByPath.set(img.path, found.id);
      } else {
        const meta = verified.get(img.path);
        if (!meta)
          throw invalid(
            'An uploaded image could not be verified.',
            undefined,
            'IMAGE_NOT_VERIFIED',
          );
        const [row] = await tx
          .insert(productImages)
          .values({
            tenantId,
            productId,
            storagePath: img.path,
            altText: img.altText,
            position,
            isPrimary: position === 0,
            mimeType: meta.mimeType,
            sizeBytes: meta.sizeBytes,
          })
          .returning({ id: productImages.id });
        idByPath.set(img.path, row.id);
      }
    }
    return { removedPaths: removed.map((r) => r.storagePath), idByPath };
  }

  private async syncCollections(
    tx: DbTx,
    tenantId: string,
    productId: string,
    collectionIds: string[],
  ) {
    const unique = [...new Set(collectionIds)];
    if (unique.length) {
      const valid = await tx
        .select({ id: collections.id })
        .from(collections)
        .where(
          and(
            eq(collections.tenantId, tenantId),
            inArray(collections.id, unique),
          ),
        );
      if (valid.length !== unique.length)
        throw invalid(
          'A selected collection no longer exists.',
          undefined,
          'COLLECTION_NOT_FOUND',
        );
    }
    await tx
      .delete(collectionProducts)
      .where(eq(collectionProducts.productId, productId));
    if (unique.length)
      await tx
        .insert(collectionProducts)
        .values(
          unique.map((collectionId) => ({ tenantId, collectionId, productId })),
        );
  }

  /** One tenant-scoped check for many category ids (the batch form of assertCategory; same error). */
  async assertCategories(tx: DbTx, tenantId: string, ids: string[]) {
    const unique = [...new Set(ids)];
    if (unique.length === 0) return;
    const found = await tx
      .select({ id: categories.id })
      .from(categories)
      .where(
        and(eq(categories.tenantId, tenantId), inArray(categories.id, unique)),
      );
    if (found.length !== unique.length)
      throw invalid(
        'The selected category no longer exists.',
        { categoryId: 'Choose another category' },
        'CATEGORY_NOT_FOUND',
      );
  }

  /**
   * Inserts ONE NEW product and the child rows it actually has. Shared by POST /products and POST /products/import.
   * A just-inserted product cannot have options, images, variants or collections yet (the insert precedes them and
   * foreign keys cascade), so the delete/select steps of the update path are skipped when a list is empty.
   */
  async insertNewProductInTx(
    tx: DbTx,
    tenantId: string,
    values: ProductValues,
    currency: string,
    opts: {
      verified?: Map<string, { mimeType: string; sizeBytes: number }>;
      skipCategoryCheck?: boolean;
    } = {},
  ): Promise<void> {
    if (!opts.skipCategoryCheck)
      await this.assertCategory(tx, tenantId, values.categoryId);
    const slug =
      values.slug ??
      (await this.uniqueSlug(tx, tenantId, slugify(values.name)));
    await tx.insert(products).values({
      id: values.id,
      tenantId,
      slug,
      ...this.productColumns(values, currency),
    });
    if (values.options.length)
      await this.replaceOptions(tx, tenantId, values.id, values);
    let idByPath = new Map<string, string>();
    if (values.images.length)
      idByPath = (
        await this.syncImages(
          tx,
          tenantId,
          values.id,
          values,
          opts.verified ?? new Map(),
        )
      ).idByPath;
    if (values.variants.length)
      await this.syncVariants(
        tx,
        tenantId,
        values.id,
        values,
        currency,
        idByPath,
      );
    if (values.collectionIds.length)
      await this.syncCollections(tx, tenantId, values.id, values.collectionIds);
  }

  private async assertCategory(
    tx: DbTx,
    tenantId: string,
    categoryId: string | null,
  ) {
    if (!categoryId) return;
    const [c] = await tx
      .select({ id: categories.id })
      .from(categories)
      .where(
        and(eq(categories.id, categoryId), eq(categories.tenantId, tenantId)),
      );
    if (!c)
      throw invalid(
        'The selected category no longer exists.',
        { categoryId: 'Choose another category' },
        'CATEGORY_NOT_FOUND',
      );
  }

  private productColumns(v: ProductValues, currency: string) {
    const hasVariants = v.variants.length > 0;
    return {
      name: v.name,
      description: v.description,
      shortDescription: v.shortDescription,
      productType: v.productType,
      categoryId: v.categoryId,
      // With variants, SKU / price / stock live on the variants; the product row keeps its base price for display.
      sku: hasVariants ? null : v.sku,
      priceMinor: money(v.price, currency, 'Price', 'price') ?? 0,
      compareAtPriceMinor: money(
        v.compareAtPrice,
        currency,
        'Compare-at price',
        'compareAtPrice',
      ),
      costMinor: money(v.cost, currency, 'Cost per item', 'cost'),
      hasVariants,
      trackInventory: v.trackInventory,
      quantity: hasVariants ? 0 : v.quantity,
      lowStockThreshold: v.lowStockThreshold,
      status: v.status,
    };
  }

  /** Locks the new paths, THEN checks they exist, inside the save transaction (see StorageReferencesService). */
  private async verifiedImages(
    tx: DbTx,
    user: AuthUser,
    tenantId: string,
    v: ProductValues,
    alreadyStored: Set<string>,
  ) {
    const fresh = v.images
      .map((i) => i.path)
      .filter((p) => !alreadyStored.has(p));
    const checked = await this.references.verifyObjectsUnderLock(
      tx,
      user.token,
      productFolder(tenantId, v.id),
      fresh,
    );
    return new Map(
      checked.map((c) => [
        c.path,
        { mimeType: c.mimeType, sizeBytes: c.sizeBytes },
      ]),
    );
  }

  static fromCreate(dto: CreateProductDto, id: string): ProductValues {
    return {
      id,
      name: dto.name,
      slug: dto.slug,
      description: dto.description ?? null,
      shortDescription: dto.shortDescription ?? null,
      productType: dto.productType ?? null,
      categoryId: dto.categoryId ?? null,
      collectionIds: dto.collectionIds ?? [],
      sku: dto.sku ?? null,
      price: dto.price,
      compareAtPrice: dto.compareAtPrice ?? null,
      cost: dto.cost ?? null,
      trackInventory: dto.trackInventory ?? true,
      quantity: dto.quantity ?? 0,
      lowStockThreshold: dto.lowStockThreshold ?? 5,
      status: dto.status ?? 'draft',
      options: (dto.options ?? []).map((o) => ({
        name: o.name,
        values: o.values,
      })),
      variants: (dto.variants ?? []).map((x) => ({
        id: x.id,
        options: x.options,
        sku: x.sku ?? null,
        price: x.price,
        compareAtPrice: x.compareAtPrice ?? null,
        quantity: x.quantity,
        imagePath: x.imagePath ?? null,
        isActive: x.isActive ?? true,
      })),
      images: (dto.images ?? []).map((i) => ({
        path: i.path,
        altText: i.altText ?? null,
      })),
    };
  }

  /** PATCH: the stored product with the sent fields applied. The result is validated like a create. */
  private static merge(
    current: Detail,
    currency: string,
    dto: UpdateProductDto,
  ): ProductValues {
    const p = current.product;
    const pathOfImage = new Map(
      current.images.map((i) => [i.id, i.storagePath]),
    );
    const variants: VariantValues[] = dto.variants
      ? dto.variants.map((x) => ({
          id: x.id,
          options: x.options,
          sku: x.sku ?? null,
          price: x.price,
          compareAtPrice: x.compareAtPrice ?? null,
          quantity: x.quantity,
          imagePath: x.imagePath ?? null,
          isActive: x.isActive ?? true,
        }))
      : current.variants.map((x) => ({
          id: x.id,
          options: x.options,
          sku: x.sku,
          price: minorToInput(x.priceMinor, currency),
          compareAtPrice:
            x.compareAtPriceMinor === null
              ? null
              : minorToInput(x.compareAtPriceMinor, currency),
          quantity: x.quantity,
          imagePath: x.imageId ? (pathOfImage.get(x.imageId) ?? null) : null,
          isActive: x.isActive,
        }));
    const pick = <T>(sent: T | undefined, stored: T): T =>
      sent !== undefined ? sent : stored;
    return {
      id: p.id,
      name: dto.name ?? p.name,
      slug: dto.slug ?? p.slug,
      description: pick(dto.description, p.description),
      shortDescription: pick(dto.shortDescription, p.shortDescription),
      productType: pick(dto.productType, p.productType),
      categoryId: pick(dto.categoryId, p.categoryId),
      collectionIds: dto.collectionIds ?? current.collectionIds,
      sku: pick(dto.sku, p.sku),
      price: dto.price ?? minorToInput(p.priceMinor, currency),
      compareAtPrice: pick(
        dto.compareAtPrice,
        p.compareAtPriceMinor === null
          ? null
          : minorToInput(p.compareAtPriceMinor, currency),
      ),
      cost: pick(
        dto.cost,
        p.costMinor === null ? null : minorToInput(p.costMinor, currency),
      ),
      trackInventory: dto.trackInventory ?? p.trackInventory,
      quantity: dto.quantity ?? p.quantity,
      lowStockThreshold: dto.lowStockThreshold ?? p.lowStockThreshold,
      status: dto.status ?? p.status,
      options: dto.options
        ? dto.options.map((o) => ({ name: o.name, values: o.values }))
        : current.options.map((o) => ({ name: o.name, values: o.values })),
      variants,
      images: dto.images
        ? dto.images.map((i) => ({ path: i.path, altText: i.altText ?? null }))
        : current.images.map((i) => ({
            path: i.storagePath,
            altText: i.altText,
          })),
    };
  }

  async create(
    ctx: OrgContext,
    user: AuthUser,
    dto: CreateProductDto,
  ): Promise<ProductDetailDto> {
    const values = ProductsService.fromCreate(
      dto,
      dto.id ?? crypto.randomUUID(),
    );
    assertProductRules(values);
    await mapErrors(() =>
      this.db.withUser(ctx.userId, async (tx) => {
        const store = await getPrimaryStoreInTx(tx, ctx.tenantId);
        if (!store)
          throw notFound(
            'This workspace does not have a store.',
            'STORE_NOT_FOUND',
          );
        // The transaction either records everything or nothing; storage is checked inside it, after the path locks.
        const verified = await this.verifiedImages(
          tx,
          user,
          ctx.tenantId,
          values,
          new Set(),
        );
        await this.insertNewProductInTx(
          tx,
          ctx.tenantId,
          values,
          store.currency,
          { verified },
        );
      }),
    );
    return this.get(ctx, values.id);
  }

  async update(
    ctx: OrgContext,
    user: AuthUser,
    id: string,
    dto: UpdateProductDto,
  ): Promise<ProductDetailDto> {
    const removedPaths = await mapErrors(() =>
      this.db.withUser(ctx.userId, async (tx) => {
        const current = await this.detailInTx(tx, ctx.tenantId, id);
        if (!current) throw productNotFound();
        const store = await getPrimaryStoreInTx(tx, ctx.tenantId);
        if (!store)
          throw notFound(
            'This workspace does not have a store.',
            'STORE_NOT_FOUND',
          );

        const values = ProductsService.merge(current, store.currency, dto);
        assertProductRules(values);

        const stored = new Set(current.images.map((i) => i.storagePath));
        const verified = await this.verifiedImages(
          tx,
          user,
          ctx.tenantId,
          values,
          stored,
        );
        await this.assertCategory(tx, ctx.tenantId, values.categoryId);
        await tx
          .update(products)
          .set({
            slug: values.slug ?? current.product.slug,
            ...this.productColumns(values, store.currency),
          })
          .where(and(eq(products.id, id), eq(products.tenantId, ctx.tenantId)));
        await this.replaceOptions(tx, ctx.tenantId, id, values);
        const images = await this.syncImages(
          tx,
          ctx.tenantId,
          id,
          values,
          verified,
        );
        await this.syncVariants(
          tx,
          ctx.tenantId,
          id,
          values,
          store.currency,
          images.idByPath,
        );
        await this.syncCollections(tx, ctx.tenantId, id, values.collectionIds);
        return images.removedPaths;
      }),
    );
    // Only after the transaction committed: a rollback must never orphan DB rows from their files.
    await this.references.removeUnreferencedObjects(
      user,
      ctx.tenantId,
      removedPaths,
    );
    return this.get(ctx, id);
  }

  /** Deletes products and then their image files. Returns how many were deleted. */
  async remove(
    ctx: OrgContext,
    user: AuthUser,
    ids: string[],
  ): Promise<number> {
    const { count, paths } = await this.db.withUser(ctx.userId, (tx) =>
      mapErrors(async () => {
        const imgs = await tx
          .select({ path: productImages.storagePath })
          .from(productImages)
          .where(
            and(
              eq(productImages.tenantId, ctx.tenantId),
              inArray(productImages.productId, ids),
            ),
          );
        const deleted = await tx
          .delete(products)
          .where(
            and(eq(products.tenantId, ctx.tenantId), inArray(products.id, ids)),
          )
          .returning({ id: products.id });
        return {
          count: deleted.length,
          paths: deleted.length ? imgs.map((i) => i.path) : [],
        };
      }),
    );
    await this.references.removeUnreferencedObjects(user, ctx.tenantId, paths);
    return count;
  }

  async removeOne(ctx: OrgContext, user: AuthUser, id: string): Promise<void> {
    if ((await this.remove(ctx, user, [id])) === 0) throw productNotFound();
  }

  async setStatus(
    ctx: OrgContext,
    ids: string[],
    status: 'draft' | 'active',
  ): Promise<BulkCountDto> {
    const count = await this.db.withUser(ctx.userId, (tx) =>
      mapErrors(async () => {
        const rows = await tx
          .update(products)
          .set({ status })
          .where(
            and(eq(products.tenantId, ctx.tenantId), inArray(products.id, ids)),
          )
          .returning({ id: products.id });
        return rows.length;
      }),
    );
    return { count };
  }

  /** Copies the product as a draft. Images are not copied (files stay tied to the original). */
  async duplicate(ctx: OrgContext, id: string): Promise<ProductDetailDto> {
    const copyId = await this.db.withUser(ctx.userId, (tx) =>
      mapErrors(async () => {
        const [src] = await tx
          .select()
          .from(products)
          .where(and(eq(products.id, id), eq(products.tenantId, ctx.tenantId)));
        if (!src) throw productNotFound();
        const [options, variants] = await Promise.all([
          tx
            .select()
            .from(productOptions)
            .where(eq(productOptions.productId, id)),
          tx
            .select()
            .from(productVariants)
            .where(eq(productVariants.productId, id)),
        ]);
        const name = `${src.name} (copy)`.slice(0, 200);
        const slug = await this.uniqueSlug(
          tx,
          ctx.tenantId,
          `${src.slug}-copy`.slice(0, 80),
        );
        const [copy] = await tx
          .insert(products)
          .values({
            ...src,
            id: undefined,
            name,
            slug,
            sku: null,
            status: 'draft',
            createdAt: undefined,
            updatedAt: undefined,
          })
          .returning({ id: products.id });
        if (options.length)
          await tx.insert(productOptions).values(
            options.map((o) => ({
              tenantId: ctx.tenantId,
              productId: copy.id,
              name: o.name,
              values: o.values,
              position: o.position,
            })),
          );
        if (variants.length)
          await tx.insert(productVariants).values(
            variants.map((v) => ({
              tenantId: ctx.tenantId,
              productId: copy.id,
              title: v.title,
              options: v.options,
              sku: null,
              priceMinor: v.priceMinor,
              compareAtPriceMinor: v.compareAtPriceMinor,
              quantity: v.quantity,
              isActive: v.isActive,
              position: v.position,
            })),
          );
        return copy.id;
      }),
    );
    return this.get(ctx, copyId);
  }
}
