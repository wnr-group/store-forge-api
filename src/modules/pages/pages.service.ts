import { Injectable } from '@nestjs/common';
import { and, asc, eq, sql } from 'drizzle-orm';
import { invalid, notFound } from '../../common/app.exception.js';
import { mapErrors } from '../../common/db-errors.js';
import type { OrgContext } from '../../common/interfaces/request-context.js';
import { slugify } from '../../common/utils/slug.js';
import { DatabaseService, rowsOf } from '../../database/database.service.js';
import { storePages, type StorePage } from '../../database/schema/templates.js';
import { requireStore } from '../themes/themes.shared.js';
import {
  RESERVED_PAGE_SLUGS,
  type CreatePageDto,
  type StorePageDto,
  type UpdatePageDto,
} from './pages.dto.js';

const pageNotFound = () =>
  notFound('That page could not be found.', 'PAGE_NOT_FOUND');

const toDto = (p: StorePage): StorePageDto => ({
  id: p.id,
  title: p.title,
  slug: p.slug,
  body: p.body,
  status: p.status,
  createdAt: p.createdAt,
  updatedAt: p.updatedAt,
});

/** Content pages of the organization's store. Every statement runs as the signed-in user, so RLS applies. */
@Injectable()
export class PagesService {
  constructor(private readonly db: DatabaseService) {}

  async list(ctx: OrgContext): Promise<StorePageDto[]> {
    return this.db.withUser(ctx.userId, async (tx) => {
      const store = await requireStore(tx, ctx);
      const rows = await tx
        .select()
        .from(storePages)
        .where(
          and(
            eq(storePages.tenantId, ctx.tenantId),
            eq(storePages.storeId, store.id),
          ),
        )
        .orderBy(asc(storePages.title), asc(storePages.slug));
      return rows.map(toDto);
    });
  }

  async get(ctx: OrgContext, id: string): Promise<StorePageDto> {
    return this.db.withUser(ctx.userId, async (tx) => {
      const store = await requireStore(tx, ctx);
      const [row] = await tx
        .select()
        .from(storePages)
        .where(
          and(
            eq(storePages.id, id),
            eq(storePages.tenantId, ctx.tenantId),
            eq(storePages.storeId, store.id),
          ),
        );
      if (!row) throw pageNotFound();
      return toDto(row);
    });
  }

  async create(ctx: OrgContext, dto: CreatePageDto): Promise<StorePageDto> {
    const slug = dto.slug ?? slugify(dto.title);
    if (!slug || RESERVED_PAGE_SLUGS.includes(slug))
      throw invalid('Please choose an address for this page.', {
        slug: 'Choose a different address.',
      });
    return this.db.withUser(ctx.userId, (tx) =>
      mapErrors(async () => {
        const store = await requireStore(tx, ctx);
        // The app role may insert only specific columns, so the column list is explicit.
        const rows = rowsOf<{ id: string }>(
          await tx.execute(
            sql`insert into public.store_pages (tenant_id, store_id, title, slug, body, status)
                values (${ctx.tenantId}, ${store.id}, ${dto.title}, ${slug}, ${dto.body ?? ''}, ${dto.status ?? 'draft'})
                returning id`,
          ),
        );
        const [row] = await tx
          .select()
          .from(storePages)
          .where(eq(storePages.id, rows[0].id));
        return toDto(row);
      }),
    );
  }

  async update(
    ctx: OrgContext,
    id: string,
    dto: UpdatePageDto,
  ): Promise<StorePageDto> {
    const changes: Partial<
      Pick<StorePage, 'title' | 'slug' | 'body' | 'status'>
    > = {};
    if (dto.title !== undefined) changes.title = dto.title;
    if (dto.slug !== undefined) changes.slug = dto.slug;
    if (dto.body !== undefined) changes.body = dto.body;
    if (dto.status !== undefined) changes.status = dto.status;
    if (Object.keys(changes).length === 0)
      throw invalid('Nothing to change.', undefined, 'NOTHING_TO_UPDATE');
    return this.db.withUser(ctx.userId, (tx) =>
      mapErrors(async () => {
        const store = await requireStore(tx, ctx);
        const [row] = await tx
          .update(storePages)
          .set(changes)
          .where(
            and(
              eq(storePages.id, id),
              eq(storePages.tenantId, ctx.tenantId),
              eq(storePages.storeId, store.id),
            ),
          )
          .returning();
        if (!row) throw pageNotFound();
        return toDto(row);
      }),
    );
  }

  async remove(ctx: OrgContext, id: string): Promise<void> {
    await this.db.withUser(ctx.userId, (tx) =>
      mapErrors(async () => {
        const store = await requireStore(tx, ctx);
        const rows = await tx
          .delete(storePages)
          .where(
            and(
              eq(storePages.id, id),
              eq(storePages.tenantId, ctx.tenantId),
              eq(storePages.storeId, store.id),
            ),
          )
          .returning({ id: storePages.id });
        if (!rows.length) throw pageNotFound();
      }),
    );
  }
}
