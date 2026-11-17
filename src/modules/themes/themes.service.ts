import { Injectable } from '@nestjs/common';
import { isDeepStrictEqual } from 'node:util';
import { invalid } from '../../common/app.exception.js';
import { mapErrors } from '../../common/db-errors.js';
import { Paginated } from '../../common/dto/api-response.dto.js';
import { offsetOf } from '../../common/dto/pagination-query.dto.js';
import type { OrgContext } from '../../common/interfaces/request-context.js';
import { DatabaseService } from '../../database/database.service.js';
import {
  PAGE_TEMPLATE_KINDS,
  TEMPLATE_KINDS,
  type Theme,
  type TemplateKind,
} from '../../database/schema/templates.js';
import type {
  ApplyThemeDto,
  ApplyThemeResultDto,
  CurrentThemeDto,
  ThemeDetailDto,
  ThemeListQueryDto,
  ThemeSummaryDto,
} from './themes.dto.js';
import { ThemesRepository } from './themes.repository.js';
import {
  issuesToFieldErrors,
  requireStore,
  themeNotFound,
} from './themes.shared.js';
import { validateTemplateDocument } from './validation/template-document.js';

const toSummary = (
  t: Omit<Theme, 'documents'>,
  currentThemeId: string | null,
): ThemeSummaryDto => ({
  id: t.id,
  slug: t.slug,
  name: t.name,
  description: t.description,
  industry: t.industry,
  version: t.version,
  previewImage: t.previewImage,
  isCurrent: t.id === currentThemeId,
});

@Injectable()
export class ThemesService {
  constructor(
    private readonly db: DatabaseService,
    private readonly repo: ThemesRepository,
  ) {}

  /** The catalogue is global: every tenant sees the same published themes, one page at a time. */
  async list(
    ctx: OrgContext,
    q: ThemeListQueryDto,
  ): Promise<Paginated<ThemeSummaryDto>> {
    return this.db.withUser(ctx.userId, async (tx) => {
      const store = await requireStore(tx, ctx);
      const current = await this.repo.getStoreTheme(tx, store.id);
      const { rows, total } = await this.repo.listThemes(tx, {
        industry: q.industry,
        search: q.search,
        limit: q.limit,
        offset: offsetOf(q),
      });
      return new Paginated(
        rows.map((t) => toSummary(t, current?.themeId ?? null)),
        { page: q.page, limit: q.limit, total },
      );
    });
  }

  async detail(ctx: OrgContext, slug: string): Promise<ThemeDetailDto> {
    return this.db.withUser(ctx.userId, async (tx) => {
      const store = await requireStore(tx, ctx);
      const theme = await this.repo.findTheme(tx, slug);
      if (!theme) throw themeNotFound();
      const current = await this.repo.getStoreTheme(tx, store.id);
      return Object.assign(toSummary(theme, current?.themeId ?? null), {
        documents: theme.documents,
      });
    });
  }

  async current(ctx: OrgContext): Promise<CurrentThemeDto> {
    return this.db.withUser(ctx.userId, async (tx) => {
      const store = await requireStore(tx, ctx);
      const assignment = await this.repo.getStoreTheme(tx, store.id);
      if (!assignment)
        return {
          theme: null,
          appliedVersion: null,
          appliedAt: null,
          updateAvailable: false,
        };
      const theme = await this.repo.findThemeById(tx, assignment.themeId);
      return {
        theme: theme ? toSummary(theme, theme.id) : null,
        appliedVersion: assignment.themeVersion,
        appliedAt: assignment.appliedAt,
        updateAvailable: Boolean(
          theme && theme.version > assignment.themeVersion,
        ),
      };
    });
  }

  /**
   * Gives the store a theme by copying its documents into the store's own drafts. Nothing goes live until the
   * merchant publishes, published versions are never touched, and products, collections, orders and customers are not
   * read or written at all, so switching themes can never lose business data.
   */
  async apply(
    ctx: OrgContext,
    dto: ApplyThemeDto,
  ): Promise<ApplyThemeResultDto> {
    return this.db.withUser(ctx.userId, (tx) =>
      mapErrors(async () => {
        const store = await requireStore(tx, ctx);
        const theme = await this.repo.findTheme(tx, dto.themeSlug);
        if (!theme) throw themeNotFound();

        // The catalogue is trusted, but a document is only ever stored after the same checks a merchant's edit gets.
        const problems: Record<string, string> = {};
        for (const kind of TEMPLATE_KINDS) {
          const doc = theme.documents[kind];
          if (!doc) continue;
          Object.assign(
            problems,
            issuesToFieldErrors(
              kind,
              validateTemplateDocument(doc, { kind, tenantId: ctx.tenantId }),
            ),
          );
        }
        if (Object.keys(problems).length)
          throw invalid(
            'This theme is not valid and cannot be applied.',
            problems,
            'THEME_INVALID',
          );

        let written = 0;
        let replaced = 0;
        for (const kind of TEMPLATE_KINDS as readonly TemplateKind[]) {
          const doc = theme.documents[kind];
          if (!doc) continue;
          const isPage = (PAGE_TEMPLATE_KINDS as readonly string[]).includes(
            kind,
          );
          const existing = await this.repo.findActiveByKind(
            tx,
            ctx.tenantId,
            store.id,
            kind,
            isPage,
          );
          if (existing) {
            if (!isDeepStrictEqual(existing.draft, doc)) replaced += 1;
            await this.repo.updateDraft(tx, {
              tenantId: ctx.tenantId,
              storeId: store.id,
              id: existing.id,
              draft: doc as Record<string, unknown>,
            });
          } else {
            await this.repo.insertTemplate(tx, {
              tenantId: ctx.tenantId,
              storeId: store.id,
              kind,
              name: isPage ? `${theme.name} ${kind}` : kind.replace('_', ' '),
              isDefault: isPage,
              draft: doc,
            });
          }
          written += 1;
        }
        await this.repo.upsertStoreTheme(tx, {
          tenantId: ctx.tenantId,
          storeId: store.id,
          themeId: theme.id,
          themeVersion: theme.version,
        });
        return {
          theme: toSummary(theme, theme.id),
          draftsWritten: written,
          draftsReplaced: replaced,
        };
      }),
    );
  }
}
