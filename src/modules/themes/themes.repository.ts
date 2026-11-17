import { Injectable } from '@nestjs/common';
import { and, asc, desc, eq, ilike, or, sql, type SQL } from 'drizzle-orm';
import { likeTerm } from '../../common/dto/pagination-query.dto.js';
import { rowsOf, type DbTx } from '../../database/database.service.js';
import {
  storeThemes,
  templates,
  templateVersions,
  themes,
  type StoreTheme,
  type Template,
  type TemplateKind,
  type TemplateVersion,
  type Theme,
  type ThemeIndustry,
} from '../../database/schema/templates.js';

/** A template with the facts the dashboard needs: which version is live and whether the draft differs from it. */
export type TemplateRow = Template & {
  publishedVersionNumber: number | null;
  publishedAt: Date | null;
  publishedDocument: Record<string, unknown> | null;
};

const publicationState = sql<string>`case
  when ${templates.status} = 'archived' then 'archived'
  when ${templates.publishedVersionId} is null then 'draft'
  when ${templates.draft} = ${templateVersions.document} then 'published'
  else 'published_with_changes' end`;

/**
 * Every query for themes and templates. The caller always passes a transaction opened by `DatabaseService.withUser`,
 * so Postgres row level security applies to each statement; the explicit tenant and store filters below are a second,
 * independent guard. Inserts are raw SQL because the app role may only insert specific columns (see migration 0012).
 */
@Injectable()
export class ThemesRepository {
  // ---- catalogue -----------------------------------------------------------------------------------------------

  async listThemes(
    tx: DbTx,
    q: {
      industry?: ThemeIndustry;
      search: string;
      limit: number;
      offset: number;
    },
  ): Promise<{ rows: Omit<Theme, 'documents'>[]; total: number }> {
    const conditions: SQL[] = [eq(themes.status, 'published')];
    if (q.industry) conditions.push(eq(themes.industry, q.industry));
    if (q.search) {
      const term = likeTerm(q.search);
      conditions.push(
        or(ilike(themes.name, term), ilike(themes.description, term))!,
      );
    }
    const where = and(...conditions);
    const [{ total } = { total: 0 }] = await tx
      .select({ total: sql<number>`count(*)::int` })
      .from(themes)
      .where(where);
    const rows = await tx
      .select({
        id: themes.id,
        slug: themes.slug,
        name: themes.name,
        description: themes.description,
        industry: themes.industry,
        version: themes.version,
        previewImage: themes.previewImage,
        status: themes.status,
        createdAt: themes.createdAt,
        updatedAt: themes.updatedAt,
      })
      .from(themes)
      .where(where)
      .orderBy(asc(themes.name))
      .limit(q.limit)
      .offset(q.offset);
    return { rows, total };
  }

  async findTheme(
    tx: DbTx,
    slug: string,
    onlyPublished = true,
  ): Promise<Theme | null> {
    const [row] = await tx
      .select()
      .from(themes)
      .where(
        onlyPublished
          ? and(eq(themes.slug, slug), eq(themes.status, 'published'))
          : eq(themes.slug, slug),
      )
      .limit(1);
    return row ?? null;
  }

  async findThemeById(tx: DbTx, id: string): Promise<Theme | null> {
    const [row] = await tx
      .select()
      .from(themes)
      .where(eq(themes.id, id))
      .limit(1);
    return row ?? null;
  }

  // ---- store theme ---------------------------------------------------------------------------------------------

  async getStoreTheme(tx: DbTx, storeId: string): Promise<StoreTheme | null> {
    const [row] = await tx
      .select()
      .from(storeThemes)
      .where(eq(storeThemes.storeId, storeId))
      .limit(1);
    return row ?? null;
  }

  async upsertStoreTheme(
    tx: DbTx,
    v: {
      tenantId: string;
      storeId: string;
      themeId: string;
      themeVersion: number;
    },
  ): Promise<void> {
    await tx.execute(sql`
      insert into public.store_themes (tenant_id, store_id, theme_id, theme_version)
      values (${v.tenantId}, ${v.storeId}, ${v.themeId}, ${v.themeVersion})
      on conflict (store_id) do update
        set theme_id = excluded.theme_id, theme_version = excluded.theme_version`);
  }

  // ---- templates -----------------------------------------------------------------------------------------------

  private selectTemplateRows(tx: DbTx) {
    return tx
      .select({
        template: templates,
        publishedVersionNumber: templateVersions.versionNumber,
        publishedAt: templateVersions.publishedAt,
        publishedDocument: templateVersions.document,
        state: publicationState,
      })
      .from(templates)
      .leftJoin(
        templateVersions,
        and(
          eq(templateVersions.id, templates.publishedVersionId),
          eq(templateVersions.templateId, templates.id),
        ),
      );
  }

  async listTemplates(
    tx: DbTx,
    tenantId: string,
    storeId: string,
  ): Promise<(TemplateRow & { state: string })[]> {
    const rows = await this.selectTemplateRows(tx)
      .where(
        and(eq(templates.tenantId, tenantId), eq(templates.storeId, storeId)),
      )
      .orderBy(
        asc(templates.kind),
        desc(templates.isDefault),
        asc(templates.name),
      );
    return rows.map((r) => ({
      ...r.template,
      publishedVersionNumber: r.publishedVersionNumber,
      publishedAt: r.publishedAt,
      publishedDocument: r.publishedDocument,
      state: r.state,
    }));
  }

  async getTemplate(
    tx: DbTx,
    tenantId: string,
    storeId: string,
    id: string,
  ): Promise<(TemplateRow & { state: string }) | null> {
    const [r] = await this.selectTemplateRows(tx)
      .where(
        and(
          eq(templates.id, id),
          eq(templates.tenantId, tenantId),
          eq(templates.storeId, storeId),
        ),
      )
      .limit(1);
    if (!r) return null;
    return {
      ...r.template,
      publishedVersionNumber: r.publishedVersionNumber,
      publishedAt: r.publishedAt,
      publishedDocument: r.publishedDocument,
      state: r.state,
    };
  }

  /** The row a theme writes into: the default page template, or the store's single shared document of that kind. */
  async findActiveByKind(
    tx: DbTx,
    tenantId: string,
    storeId: string,
    kind: TemplateKind,
    pageKind: boolean,
  ): Promise<Template | null> {
    const [row] = await tx
      .select()
      .from(templates)
      .where(
        and(
          eq(templates.tenantId, tenantId),
          eq(templates.storeId, storeId),
          eq(templates.kind, kind),
          eq(templates.status, 'active'),
          pageKind ? eq(templates.isDefault, true) : undefined,
        ),
      )
      .limit(1);
    return row ?? null;
  }

  async insertTemplate(
    tx: DbTx,
    v: {
      tenantId: string;
      storeId: string;
      kind: TemplateKind;
      name: string;
      isDefault: boolean;
      draft: unknown;
    },
  ): Promise<string> {
    const rows = rowsOf<{ id: string }>(
      await tx.execute(sql`
        insert into public.templates (tenant_id, store_id, kind, name, is_default, draft)
        values (${v.tenantId}, ${v.storeId}, ${v.kind}, ${v.name}, ${v.isDefault}, ${JSON.stringify(v.draft)}::jsonb)
        returning id`),
    );
    return rows[0]!.id;
  }

  /** Writes the draft only if nobody saved in between (`expectedRevision`); returns the new row or null. */
  async updateDraft(
    tx: DbTx,
    v: {
      tenantId: string;
      storeId: string;
      id: string;
      draft: Record<string, unknown>;
      expectedRevision?: number;
      name?: string;
    },
  ): Promise<Template | null> {
    const [row] = await tx
      .update(templates)
      .set({ draft: v.draft, ...(v.name ? { name: v.name } : {}) })
      .where(
        and(
          eq(templates.id, v.id),
          eq(templates.tenantId, v.tenantId),
          eq(templates.storeId, v.storeId),
          eq(templates.status, 'active'),
          v.expectedRevision === undefined
            ? undefined
            : eq(templates.revision, v.expectedRevision),
        ),
      )
      .returning();
    return row ?? null;
  }

  /** Locks the template row for the rest of the transaction so two publishes cannot interleave. */
  async lockTemplate(
    tx: DbTx,
    tenantId: string,
    storeId: string,
    id: string,
  ): Promise<Template | null> {
    const [row] = await tx
      .select()
      .from(templates)
      .where(
        and(
          eq(templates.id, id),
          eq(templates.tenantId, tenantId),
          eq(templates.storeId, storeId),
        ),
      )
      .for('update')
      .limit(1);
    return row ?? null;
  }

  async insertVersion(
    tx: DbTx,
    v: {
      tenantId: string;
      storeId: string;
      templateId: string;
      document: unknown;
      source: 'publish' | 'rollback';
      rolledBackFrom?: string;
      label?: string | null;
    },
  ): Promise<{ id: string; versionNumber: number; publishedAt: Date }> {
    const rows = rowsOf<{
      id: string;
      version_number: number;
      published_at: string | Date;
    }>(
      await tx.execute(sql`
        insert into public.template_versions (tenant_id, store_id, template_id, document, source, rolled_back_from, label)
        values (${v.tenantId}, ${v.storeId}, ${v.templateId}, ${JSON.stringify(v.document)}::jsonb, ${v.source},
                ${v.rolledBackFrom ?? null}, ${v.label ?? null})
        returning id, version_number, published_at`),
    );
    const r = rows[0]!;
    return {
      id: r.id,
      versionNumber: r.version_number,
      publishedAt: new Date(r.published_at),
    };
  }

  async setPublishedVersion(
    tx: DbTx,
    v: {
      tenantId: string;
      storeId: string;
      templateId: string;
      versionId: string;
      draft?: Record<string, unknown>;
    },
  ): Promise<void> {
    await tx
      .update(templates)
      .set({
        publishedVersionId: v.versionId,
        ...(v.draft ? { draft: v.draft } : {}),
      })
      .where(
        and(
          eq(templates.id, v.templateId),
          eq(templates.tenantId, v.tenantId),
          eq(templates.storeId, v.storeId),
        ),
      );
  }

  async listVersions(
    tx: DbTx,
    tenantId: string,
    storeId: string,
    templateId: string,
    limit: number,
  ): Promise<TemplateVersion[]> {
    return tx
      .select()
      .from(templateVersions)
      .where(
        and(
          eq(templateVersions.tenantId, tenantId),
          eq(templateVersions.storeId, storeId),
          eq(templateVersions.templateId, templateId),
        ),
      )
      .orderBy(desc(templateVersions.versionNumber))
      .limit(limit);
  }

  async getVersion(
    tx: DbTx,
    tenantId: string,
    storeId: string,
    templateId: string,
    versionId: string,
  ): Promise<TemplateVersion | null> {
    const [row] = await tx
      .select()
      .from(templateVersions)
      .where(
        and(
          eq(templateVersions.id, versionId),
          eq(templateVersions.tenantId, tenantId),
          eq(templateVersions.storeId, storeId),
          eq(templateVersions.templateId, templateId),
        ),
      )
      .limit(1);
    return row ?? null;
  }
}
