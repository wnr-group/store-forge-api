import { Injectable } from '@nestjs/common';
import { isDeepStrictEqual } from 'node:util';
import { conflict, invalid } from '../../common/app.exception.js';
import { mapErrors } from '../../common/db-errors.js';
import type { OrgContext } from '../../common/interfaces/request-context.js';
import { DatabaseService, type DbTx } from '../../database/database.service.js';
import {
  PAGE_TEMPLATE_KINDS,
  TEMPLATE_KINDS,
  type Template,
  type TemplateKind,
} from '../../database/schema/templates.js';
import type {
  PreviewBundleDto,
  PublishDto,
  PublishResultDto,
  PublishThemeDto,
  RollbackDto,
  SaveDraftDto,
  TemplateDetailDto,
  TemplateSummaryDto,
  TemplateVersionDto,
} from './themes.dto.js';
import { ProductPresentationsService } from './product-presentations.service.js';
import { ThemesRepository, type TemplateRow } from './themes.repository.js';
import {
  documentInvalid,
  issuesToFieldErrors,
  requireStore,
  templateNotFound,
} from './themes.shared.js';
import { validateTemplateDocument } from './validation/template-document.js';

type Row = TemplateRow & { state: string };

const toSummary = (t: Row): TemplateSummaryDto => ({
  id: t.id,
  kind: t.kind,
  name: t.name,
  status: t.status,
  isDefault: t.isDefault,
  revision: t.revision,
  publicationState: t.state,
  publishedVersion: t.publishedVersionNumber,
  publishedAt: t.publishedAt,
  updatedAt: t.updatedAt,
});

const toDetail = (t: Row): TemplateDetailDto =>
  Object.assign(toSummary(t), { document: t.draft });

@Injectable()
export class TemplatesService {
  constructor(
    private readonly db: DatabaseService,
    private readonly repo: ThemesRepository,
    private readonly presentations: ProductPresentationsService,
  ) {}

  async list(ctx: OrgContext): Promise<TemplateSummaryDto[]> {
    return this.db.withUser(ctx.userId, async (tx) => {
      const store = await requireStore(tx, ctx);
      const rows = await this.repo.listTemplates(tx, ctx.tenantId, store.id);
      return rows.map(toSummary);
    });
  }

  async get(ctx: OrgContext, id: string): Promise<TemplateDetailDto> {
    return this.db.withUser(ctx.userId, async (tx) => {
      const store = await requireStore(tx, ctx);
      const row = await this.repo.getTemplate(tx, ctx.tenantId, store.id, id);
      if (!row) throw templateNotFound();
      return toDetail(row);
    });
  }

  /**
   * Everything the storefront renderer needs to show a draft: the page, the draft theme settings and the three
   * shared groups. Only members of the organization can read it, so a draft is never visible to shoppers.
   */
  async preview(ctx: OrgContext, id: string): Promise<PreviewBundleDto> {
    return this.db.withUser(ctx.userId, async (tx) => {
      const store = await requireStore(tx, ctx);
      const rows = await this.repo.listTemplates(tx, ctx.tenantId, store.id);
      const page = rows.find((r) => r.id === id);
      if (!page) throw templateNotFound();
      const shared = (kind: TemplateKind) =>
        rows.find((r) => r.kind === kind && r.status === 'active')?.draft ??
        null;
      return {
        template: toDetail(page),
        theme: shared('theme_settings'),
        groups: {
          header: shared('group_header'),
          footer: shared('group_footer'),
          announcement: shared('group_announcement'),
        },
        storeSlug: store.slug,
      };
    });
  }

  /**
   * Saves the draft. `expectedRevision` is the revision the editor started from: when someone else saved in the
   * meantime nothing is written and the caller gets a 409 with the current revision, so edits are never lost silently.
   */
  async saveDraft(
    ctx: OrgContext,
    id: string,
    dto: SaveDraftDto,
  ): Promise<TemplateDetailDto> {
    return this.db.withUser(ctx.userId, (tx) =>
      mapErrors(async () => {
        const store = await requireStore(tx, ctx);
        const current = await this.repo.lockTemplate(
          tx,
          ctx.tenantId,
          store.id,
          id,
        );
        if (!current || current.status !== 'active') throw templateNotFound();
        const issues = validateTemplateDocument(dto.document, {
          kind: current.kind,
          tenantId: ctx.tenantId,
        });
        if (issues.length) throw documentInvalid(current.kind, issues);
        if (current.revision !== dto.expectedRevision)
          throw revisionConflict(current.revision);
        // An unchanged draft is not a write: the revision must not move, or two tabs would conflict for nothing.
        if (!isDeepStrictEqual(current.draft, dto.document)) {
          const saved = await this.repo.updateDraft(tx, {
            tenantId: ctx.tenantId,
            storeId: store.id,
            id,
            draft: dto.document,
            expectedRevision: dto.expectedRevision,
          });
          if (!saved) throw revisionConflict(current.revision);
        }
        const row = await this.repo.getTemplate(tx, ctx.tenantId, store.id, id);
        return toDetail(row!);
      }),
    );
  }

  /** Publishes one template: its current draft becomes the next immutable version and goes live. */
  async publish(
    ctx: OrgContext,
    id: string,
    dto: PublishDto,
  ): Promise<PublishResultDto> {
    return this.db.withUser(ctx.userId, (tx) =>
      mapErrors(async () => {
        const store = await requireStore(tx, ctx);
        const current = await this.repo.lockTemplate(
          tx,
          ctx.tenantId,
          store.id,
          id,
        );
        if (!current || current.status !== 'active') throw templateNotFound();
        if (
          dto.expectedRevision !== undefined &&
          dto.expectedRevision !== current.revision
        )
          throw revisionConflict(current.revision);
        const outcome = await this.publishOne(
          tx,
          ctx,
          store.id,
          current,
          dto.label,
        );
        return {
          published: outcome.published ? [outcome.published] : [],
          unchanged: outcome.published ? 0 : 1,
          storeSlug: store.slug,
          publishedAt: outcome.at,
        };
      }),
    );
  }

  /**
   * Publishes the whole theme in one transaction: every page and shared document whose draft differs from its live
   * version, plus the draft settings of every customized product. Either all of them go live or none do, so shoppers
   * never see half a redesign.
   */
  async publishTheme(
    ctx: OrgContext,
    dto: PublishThemeDto,
  ): Promise<PublishResultDto> {
    return this.db.withUser(ctx.userId, (tx) =>
      mapErrors(async () => {
        const store = await requireStore(tx, ctx);
        const all = await this.repo.listTemplates(tx, ctx.tenantId, store.id);
        const candidates = all.filter(
          (t) =>
            t.status === 'active' &&
            ((PAGE_TEMPLATE_KINDS as readonly string[]).includes(t.kind)
              ? t.isDefault
              : true),
        );

        // Validate everything before writing anything.
        const problems: Record<string, string> = {};
        for (const t of candidates)
          Object.assign(
            problems,
            issuesToFieldErrors(
              t.kind,
              validateTemplateDocument(t.draft, {
                kind: t.kind,
                tenantId: ctx.tenantId,
              }),
            ),
          );
        // Product settings waiting to go live are locked and validated with the pages, still before any write.
        const pending = await this.presentations.prepareThemePublish(
          tx,
          ctx,
          store.id,
        );
        Object.assign(problems, pending.problems);
        if (Object.keys(problems).length)
          throw invalid(
            'This design has problems that must be fixed first.',
            problems,
            'TEMPLATE_DOCUMENT_INVALID',
          );

        const published: PublishResultDto['published'] = [];
        let unchanged = 0;
        let at = new Date();
        for (const t of candidates) {
          const locked = await this.repo.lockTemplate(
            tx,
            ctx.tenantId,
            store.id,
            t.id,
          );
          if (!locked) continue;
          const outcome = await this.publishOne(
            tx,
            ctx,
            store.id,
            locked,
            dto.label,
          );
          if (outcome.published) {
            published.push(outcome.published);
            at = outcome.at;
          } else unchanged += 1;
        }
        const presentationsLive = await this.presentations.publishCandidates(
          tx,
          ctx,
          store.id,
          pending.candidates,
        );
        if (presentationsLive && !published.length) at = new Date();
        return {
          published,
          unchanged,
          storeSlug: store.slug,
          publishedAt: at,
          productPresentations: { published: presentationsLive },
        };
      }),
    );
  }

  async versions(ctx: OrgContext, id: string): Promise<TemplateVersionDto[]> {
    return this.db.withUser(ctx.userId, async (tx) => {
      const store = await requireStore(tx, ctx);
      const template = await this.repo.getTemplate(
        tx,
        ctx.tenantId,
        store.id,
        id,
      );
      if (!template) throw templateNotFound();
      const rows = await this.repo.listVersions(
        tx,
        ctx.tenantId,
        store.id,
        id,
        100,
      );
      return rows.map((v) => ({
        id: v.id,
        versionNumber: v.versionNumber,
        source: v.source,
        rolledBackFrom: v.rolledBackFrom,
        publishedBy: v.publishedBy,
        label: v.label,
        publishedAt: v.publishedAt,
        isLive: v.id === template.publishedVersionId,
      }));
    });
  }

  /**
   * Restores an earlier version. History is append-only: the old document is published again as a NEW version
   * (source "rollback"), so no record is ever changed or lost. The draft is reset to the restored document.
   */
  async rollback(
    ctx: OrgContext,
    id: string,
    dto: RollbackDto,
  ): Promise<PublishResultDto> {
    return this.db.withUser(ctx.userId, (tx) =>
      mapErrors(async () => {
        const store = await requireStore(tx, ctx);
        const current = await this.repo.lockTemplate(
          tx,
          ctx.tenantId,
          store.id,
          id,
        );
        if (!current || current.status !== 'active') throw templateNotFound();
        const target = await this.repo.getVersion(
          tx,
          ctx.tenantId,
          store.id,
          id,
          dto.versionId,
        );
        if (!target)
          throw invalid(
            'That version does not belong to this design.',
            undefined,
            'VERSION_NOT_FOUND',
          );
        if (target.id === current.publishedVersionId)
          throw conflict(
            'That version is already live.',
            undefined,
            'VERSION_ALREADY_LIVE',
          );
        const issues = validateTemplateDocument(target.document, {
          kind: current.kind,
          tenantId: ctx.tenantId,
        });
        if (issues.length) throw documentInvalid(current.kind, issues);

        const version = await this.repo.insertVersion(tx, {
          tenantId: ctx.tenantId,
          storeId: store.id,
          templateId: id,
          document: target.document,
          source: 'rollback',
          rolledBackFrom: target.id,
          label: dto.label ?? `Restored version ${target.versionNumber}`,
        });
        await this.repo.setPublishedVersion(tx, {
          tenantId: ctx.tenantId,
          storeId: store.id,
          templateId: id,
          versionId: version.id,
          draft: target.document,
        });
        return {
          published: [
            {
              templateId: id,
              kind: current.kind,
              versionNumber: version.versionNumber,
            },
          ],
          unchanged: 0,
          storeSlug: store.slug,
          publishedAt: version.publishedAt,
        };
      }),
    );
  }

  private async publishOne(
    tx: DbTx,
    ctx: OrgContext,
    storeId: string,
    template: Template,
    label?: string,
  ): Promise<{
    published: {
      templateId: string;
      kind: string;
      versionNumber: number;
    } | null;
    at: Date;
  }> {
    const issues = validateTemplateDocument(template.draft, {
      kind: template.kind,
      tenantId: ctx.tenantId,
    });
    if (issues.length) throw documentInvalid(template.kind, issues);

    // Nothing to do when the live version already equals the draft.
    if (template.publishedVersionId) {
      const live = await this.repo.getVersion(
        tx,
        ctx.tenantId,
        storeId,
        template.id,
        template.publishedVersionId,
      );
      if (live && isDeepStrictEqual(live.document, template.draft))
        return { published: null, at: live.publishedAt };
    }

    const version = await this.repo.insertVersion(tx, {
      tenantId: ctx.tenantId,
      storeId,
      templateId: template.id,
      document: template.draft,
      source: 'publish',
      label: label ?? null,
    });
    await this.repo.setPublishedVersion(tx, {
      tenantId: ctx.tenantId,
      storeId,
      templateId: template.id,
      versionId: version.id,
    });
    return {
      published: {
        templateId: template.id,
        kind: template.kind,
        versionNumber: version.versionNumber,
      },
      at: version.publishedAt,
    };
  }
}

const revisionConflict = (currentRevision: number) =>
  conflict(
    'Someone else changed this design. Reload to see their changes before saving.',
    { revision: `Current revision is ${currentRevision}.` },
    'TEMPLATE_REVISION_CONFLICT',
  );

export { TEMPLATE_KINDS };
