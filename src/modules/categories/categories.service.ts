import { Injectable } from '@nestjs/common';
import { and, asc, eq, sql } from 'drizzle-orm';
import { invalid, notFound } from '../../common/app.exception.js';
import { mapErrors } from '../../common/db-errors.js';
import type { OrgContext } from '../../common/interfaces/request-context.js';
import { slugify } from '../../common/utils/slug.js';
import { DatabaseService, type DbTx } from '../../database/database.service.js';
import { categories } from '../../database/schema/index.js';
import type {
  CategoryDto,
  CreateCategoryDto,
  UpdateCategoryDto,
} from './categories.dto.js';

const padSlug = (s: string) => (s.length >= 2 ? s : `${s}-item`);

const notFoundError = () =>
  notFound('That category no longer exists.', 'CATEGORY_NOT_FOUND');

@Injectable()
export class CategoriesService {
  constructor(private readonly db: DatabaseService) {}

  /** All categories of the organization, by name, with product counts and the parent's name. */
  async list(ctx: OrgContext): Promise<CategoryDto[]> {
    return this.db.withUser(ctx.userId, async (tx) => {
      const rows = await tx
        .select({
          category: categories,
          productCount: sql<number>`(select count(*)::int from "products" p where p.category_id = "categories"."id")`,
        })
        .from(categories)
        .where(eq(categories.tenantId, ctx.tenantId))
        .orderBy(asc(categories.name));
      const names = new Map(rows.map((r) => [r.category.id, r.category.name]));
      return rows.map((r) => ({
        ...r.category,
        productCount: r.productCount,
        parentName: r.category.parentId
          ? (names.get(r.category.parentId) ?? null)
          : null,
      }));
    });
  }

  async get(ctx: OrgContext, id: string): Promise<CategoryDto> {
    const all = await this.list(ctx);
    const found = all.find((c) => c.id === id);
    if (!found) throw notFoundError();
    return found;
  }

  /** A category may not become its own ancestor. Walks up from the proposed parent. */
  private async assertNoCycle(
    tx: DbTx,
    tenantId: string,
    id: string,
    parentId: string | null,
  ) {
    let cursor = parentId;
    for (let depth = 0; cursor && depth < 50; depth++) {
      if (cursor === id)
        throw invalid(
          'A category cannot be moved under itself.',
          { parentId: 'Choose a different parent' },
          'CATEGORY_CYCLE',
        );
      const [p] = await tx
        .select({ parentId: categories.parentId })
        .from(categories)
        .where(
          and(eq(categories.id, cursor), eq(categories.tenantId, tenantId)),
        );
      if (!p)
        throw invalid(
          'The parent category no longer exists.',
          { parentId: 'Choose a different parent' },
          'PARENT_NOT_FOUND',
        );
      cursor = p.parentId;
    }
  }

  async create(ctx: OrgContext, dto: CreateCategoryDto): Promise<CategoryDto> {
    const id = await this.db.withUser(ctx.userId, (tx) =>
      mapErrors(async () => {
        await this.assertNoCycle(tx, ctx.tenantId, '', dto.parentId ?? null);
        const [row] = await tx
          .insert(categories)
          .values({
            tenantId: ctx.tenantId,
            name: dto.name,
            slug: dto.slug ?? padSlug(slugify(dto.name) || 'category'),
            description: dto.description ?? null,
            parentId: dto.parentId ?? null,
          })
          .returning({ id: categories.id });
        return row.id;
      }),
    );
    return this.get(ctx, id);
  }

  async update(
    ctx: OrgContext,
    id: string,
    dto: UpdateCategoryDto,
  ): Promise<CategoryDto> {
    await this.db.withUser(ctx.userId, (tx) =>
      mapErrors(async () => {
        if (dto.parentId !== undefined)
          await this.assertNoCycle(tx, ctx.tenantId, id, dto.parentId);
        const changes = {
          ...(dto.name !== undefined && { name: dto.name }),
          ...(dto.slug !== undefined && { slug: dto.slug }),
          ...(dto.description !== undefined && {
            description: dto.description,
          }),
          ...(dto.parentId !== undefined && { parentId: dto.parentId }),
        };
        const rows =
          Object.keys(changes).length > 0
            ? await tx
                .update(categories)
                .set(changes)
                .where(
                  and(
                    eq(categories.id, id),
                    eq(categories.tenantId, ctx.tenantId),
                  ),
                )
                .returning({ id: categories.id })
            : await tx
                .select({ id: categories.id })
                .from(categories)
                .where(
                  and(
                    eq(categories.id, id),
                    eq(categories.tenantId, ctx.tenantId),
                  ),
                );
        if (!rows.length) throw notFoundError();
      }),
    );
    return this.get(ctx, id);
  }

  /** Products in the category become uncategorised; child categories become top-level. */
  async remove(ctx: OrgContext, id: string): Promise<void> {
    await this.db.withUser(ctx.userId, (tx) =>
      mapErrors(async () => {
        const rows = await tx
          .delete(categories)
          .where(
            and(eq(categories.id, id), eq(categories.tenantId, ctx.tenantId)),
          )
          .returning({ id: categories.id });
        if (!rows.length) throw notFoundError();
      }),
    );
  }
}
