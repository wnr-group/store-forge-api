import { Injectable } from '@nestjs/common';
import { and, asc, eq, inArray, sql } from 'drizzle-orm';
import { conflict, invalid, notFound } from '../../common/app.exception.js';
import { mapErrors } from '../../common/db-errors.js';
import type {
  AuthUser,
  OrgContext,
} from '../../common/interfaces/request-context.js';
import { slugify } from '../../common/utils/slug.js';
import { DatabaseService, type DbTx } from '../../database/database.service.js';
import {
  collectionProducts,
  collections,
  products,
  type Collection,
} from '../../database/schema/index.js';
import {
  templates,
  templateVersions,
} from '../../database/schema/templates.js';
import { getPrimaryStoreInTx } from '../store/store.service.js';
import {
  computeUsage,
  type CollectionUsage,
  type TemplateSource,
} from './collection-usage.js';
import { collectionFolder } from '../storage/storage-paths.js';
import { StorageReferencesService } from '../storage/storage-references.service.js';
import type {
  CollectionDetailDto,
  CollectionDto,
  CreateCollectionDto,
  ProductOptionChoiceDto,
  UpdateCollectionDto,
} from './collections.dto.js';

const notFoundError = () =>
  notFound('That collection no longer exists.', 'COLLECTION_NOT_FOUND');

const toDto = (c: Collection, productCount: number): CollectionDto => ({
  id: c.id,
  name: c.name,
  slug: c.slug,
  description: c.description,
  status: c.status,
  imagePath: c.imagePath,
  productCount,
  createdAt: c.createdAt,
  updatedAt: c.updatedAt,
});

@Injectable()
export class CollectionsService {
  constructor(
    private readonly db: DatabaseService,
    private readonly references: StorageReferencesService,
  ) {}

  async list(ctx: OrgContext): Promise<CollectionDto[]> {
    return this.db.withUser(ctx.userId, async (tx) => {
      const rows = await tx
        .select({
          collection: collections,
          productCount: sql<number>`(select count(*)::int from "collection_products" cp where cp.collection_id = "collections"."id")`,
        })
        .from(collections)
        .where(eq(collections.tenantId, ctx.tenantId))
        .orderBy(asc(collections.name));
      return rows.map((r) => toDto(r.collection, r.productCount));
    });
  }

  async get(ctx: OrgContext, id: string): Promise<CollectionDetailDto> {
    return this.db.withUser(ctx.userId, async (tx) => {
      const [c] = await tx
        .select()
        .from(collections)
        .where(
          and(eq(collections.id, id), eq(collections.tenantId, ctx.tenantId)),
        );
      if (!c) throw notFoundError();
      const links = await tx
        .select({ id: collectionProducts.productId })
        .from(collectionProducts)
        .where(eq(collectionProducts.collectionId, id))
        .orderBy(asc(collectionProducts.position));
      return Object.assign(toDto(c, links.length), {
        productIds: links.map((l) => l.id),
      });
    });
  }

  /** Product choices for a collection picker (ids + names only). */
  async productOptions(ctx: OrgContext): Promise<ProductOptionChoiceDto[]> {
    return this.db.withUser(ctx.userId, (tx) =>
      tx
        .select({ id: products.id, name: products.name })
        .from(products)
        .where(eq(products.tenantId, ctx.tenantId))
        .orderBy(asc(products.name))
        .limit(500),
    );
  }

  private async replaceProducts(
    tx: DbTx,
    tenantId: string,
    collectionId: string,
    productIds: string[],
  ) {
    const unique = [...new Set(productIds)];
    if (unique.length) {
      const valid = await tx
        .select({ id: products.id })
        .from(products)
        .where(
          and(eq(products.tenantId, tenantId), inArray(products.id, unique)),
        );
      if (valid.length !== unique.length)
        throw invalid(
          'A selected product no longer exists.',
          undefined,
          'PRODUCT_NOT_FOUND',
        );
    }
    await tx
      .delete(collectionProducts)
      .where(eq(collectionProducts.collectionId, collectionId));
    if (unique.length)
      await tx.insert(collectionProducts).values(
        unique.map((productId, position) => ({
          tenantId,
          collectionId,
          productId,
          position,
        })),
      );
  }

  async create(
    ctx: OrgContext,
    user: AuthUser,
    dto: CreateCollectionDto,
  ): Promise<CollectionDetailDto> {
    const id = dto.id ?? crypto.randomUUID();
    await this.db.withUser(ctx.userId, (tx) =>
      mapErrors(async () => {
        // Lock the path, THEN check the object exists (see StorageReferencesService).
        const [image] = dto.imagePath
          ? await this.references.verifyObjectsUnderLock(
              tx,
              user.token,
              collectionFolder(ctx.tenantId, id),
              [dto.imagePath],
            )
          : [];
        await tx.insert(collections).values({
          id,
          tenantId: ctx.tenantId,
          name: dto.name,
          slug: dto.slug ?? (slugify(dto.name).padEnd(2, 'x') || 'collection'),
          description: dto.description ?? null,
          status: dto.status ?? 'draft',
          imagePath: image?.path ?? null,
        });
        await this.replaceProducts(tx, ctx.tenantId, id, dto.productIds ?? []);
      }),
    );
    return this.get(ctx, id);
  }

  async update(
    ctx: OrgContext,
    user: AuthUser,
    id: string,
    dto: UpdateCollectionDto,
  ): Promise<CollectionDetailDto> {
    const folder = collectionFolder(ctx.tenantId, id);
    const saved = await this.db.withUser(ctx.userId, (tx) =>
      mapErrors(async () => {
        const [current] = await tx
          .select({ imagePath: collections.imagePath })
          .from(collections)
          .where(
            and(eq(collections.id, id), eq(collections.tenantId, ctx.tenantId)),
          );
        if (!current) throw notFoundError();

        let imagePath = current.imagePath;
        if (dto.imagePath !== undefined) {
          if (!dto.imagePath) imagePath = null;
          else if (dto.imagePath === current.imagePath)
            imagePath = current.imagePath;
          else
            imagePath = (
              await this.references.verifyObjectsUnderLock(
                tx,
                user.token,
                folder,
                [dto.imagePath],
              )
            )[0].path;
        }

        const changes = {
          imagePath,
          ...(dto.name !== undefined && { name: dto.name }),
          ...(dto.slug !== undefined && { slug: dto.slug }),
          ...(dto.description !== undefined && {
            description: dto.description,
          }),
          ...(dto.status !== undefined && { status: dto.status }),
        };
        await tx
          .update(collections)
          .set(changes)
          .where(
            and(eq(collections.id, id), eq(collections.tenantId, ctx.tenantId)),
          );
        if (dto.productIds !== undefined)
          await this.replaceProducts(tx, ctx.tenantId, id, dto.productIds);
        return { previous: current.imagePath, current: imagePath };
      }),
    );
    if (saved.previous && saved.previous !== saved.current)
      await this.references.removeUnreferencedObjects(user, ctx.tenantId, [
        saved.previous,
      ]);
    return this.get(ctx, id);
  }

  private async requireCollection(tx: DbTx, tenantId: string, id: string) {
    const [c] = await tx
      .select({ id: collections.id, slug: collections.slug })
      .from(collections)
      .where(and(eq(collections.id, id), eq(collections.tenantId, tenantId)))
      .limit(1);
    if (!c) throw notFoundError();
    return c;
  }

  /** Draft and currently published document of every active template of the tenant's primary store. */
  private async templateSources(
    tx: DbTx,
    tenantId: string,
    lock: boolean,
  ): Promise<TemplateSource[]> {
    const store = await getPrimaryStoreInTx(tx, tenantId);
    if (!store) return [];
    const q = tx
      .select({
        id: templates.id,
        name: templates.name,
        kind: templates.kind,
        draft: templates.draft,
        published: templateVersions.document,
      })
      .from(templates)
      .leftJoin(
        templateVersions,
        and(
          eq(templateVersions.id, templates.publishedVersionId),
          eq(templateVersions.templateId, templates.id),
        ),
      )
      .where(
        and(
          eq(templates.tenantId, tenantId),
          eq(templates.storeId, store.id),
          eq(templates.status, 'active'),
        ),
      );
    // FOR SHARE on the template rows: a draft save running at the same time waits until this transaction ends.
    return lock ? await q.for('share', { of: templates }) : await q;
  }

  async usage(ctx: OrgContext, id: string): Promise<CollectionUsage> {
    return this.db.withUser(ctx.userId, (tx) =>
      mapErrors(async () => {
        const c = await this.requireCollection(tx, ctx.tenantId, id);
        return computeUsage(
          await this.templateSources(tx, ctx.tenantId, false),
          c,
        );
      }),
    );
  }

  async remove(
    ctx: OrgContext,
    user: AuthUser,
    id: string,
    usageHash?: string,
  ): Promise<void> {
    const imagePath = await this.db.withUser(ctx.userId, (tx) =>
      mapErrors(async () => {
        const c = await this.requireCollection(tx, ctx.tenantId, id);
        const current = computeUsage(
          await this.templateSources(tx, ctx.tenantId, true),
          c,
        );
        const confirmed =
          usageHash !== undefined
            ? usageHash === current.hash
            : current.total === 0;
        if (!confirmed)
          throw conflict(
            'The store design that uses this collection has changed. Review where it is used and confirm again.',
            undefined,
            'COLLECTION_IN_USE',
          );
        const rows = await tx
          .delete(collections)
          .where(
            and(eq(collections.id, id), eq(collections.tenantId, ctx.tenantId)),
          )
          .returning({ imagePath: collections.imagePath });
        if (!rows.length) throw notFoundError();
        return rows[0].imagePath;
      }),
    );
    if (imagePath)
      await this.references.removeUnreferencedObjects(user, ctx.tenantId, [
        imagePath,
      ]);
  }
}
