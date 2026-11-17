import { Injectable } from '@nestjs/common';
import { isDeepStrictEqual } from 'node:util';
import { conflict, invalid, notFound } from '../../common/app.exception.js';
import { mapErrors } from '../../common/db-errors.js';
import { Paginated } from '../../common/dto/api-response.dto.js';
import { offsetOf } from '../../common/dto/pagination-query.dto.js';
import type { OrgContext } from '../../common/interfaces/request-context.js';
import { DatabaseService, type DbTx } from '../../database/database.service.js';
import type { ProductPresentation } from '../../database/schema/product-presentations.js';
import type {
  ProductPresentationDto,
  ProductPresentationListQueryDto,
  ProductPresentationSummaryDto,
  PublishProductPresentationDto,
  PublishProductPresentationResultDto,
  SaveProductPresentationDto,
} from './product-presentations.dto.js';
import {
  ProductPresentationsRepository,
  type PresentationRow,
} from './product-presentations.repository.js';
import { issuesToFieldErrors, requireStore } from './themes.shared.js';
import {
  EMPTY_PRESENTATION,
  validatePresentationDocument,
} from './validation/presentation-document.js';
import type { DocumentIssue } from './validation/template-document.js';

const productNotFound = () =>
  notFound('That product could not be found.', 'PRODUCT_NOT_FOUND');

const presentationNotFound = () =>
  notFound(
    'That product has no customization to publish.',
    'PRESENTATION_NOT_FOUND',
  );

const revisionConflict = (currentRevision: number) =>
  conflict(
    'Someone else changed this product design. Reload to see their changes before saving.',
    { revision: `Current revision is ${currentRevision}.` },
    'PRESENTATION_REVISION_CONFLICT',
  );

export const presentationFieldKey = (productId: string) =>
  `productPresentation.${productId}`;

const documentInvalid = (productId: string, issues: DocumentIssue[]) =>
  invalid(
    'These product settings have problems that must be fixed first.',
    issuesToFieldErrors(presentationFieldKey(productId), issues),
    'PRESENTATION_DOCUMENT_INVALID',
  );

/** What an uncustomized product looks like: nothing stored, everything inherited. */
const defaultDetail = (productId: string): ProductPresentationDto => ({
  productId,
  revision: 0,
  publicationState: 'default',
  document: { ...EMPTY_PRESENTATION },
  publishedDocument: null,
  publishedAt: null,
  updatedAt: null,
});

const toDetail = (r: PresentationRow): ProductPresentationDto => ({
  productId: r.productId,
  revision: r.revision,
  publicationState: r.state,
  document: r.draft,
  publishedDocument: r.published,
  publishedAt: r.publishedAt,
  updatedAt: r.updatedAt,
});

/** Draft and live copy of a product's presentation. Mirrors the template draft/publish workflow (revisions, 409). */
@Injectable()
export class ProductPresentationsService {
  constructor(
    private readonly db: DatabaseService,
    private readonly repo: ProductPresentationsRepository,
  ) {}

  async list(
    ctx: OrgContext,
    q: ProductPresentationListQueryDto,
  ): Promise<Paginated<ProductPresentationSummaryDto>> {
    return this.db.withUser(ctx.userId, async (tx) => {
      const store = await requireStore(tx, ctx);
      const { rows, total } = await this.repo.list(
        tx,
        ctx.tenantId,
        store.id,
        q.limit,
        offsetOf(q),
      );
      return new Paginated(
        rows.map((r) => ({
          productId: r.productId,
          revision: r.revision,
          publicationState: r.state,
          publishedAt: r.publishedAt,
          updatedAt: r.updatedAt,
        })),
        { page: q.page, limit: q.limit, total },
      );
    });
  }

  /** A product without a row is not an error: it simply has the default design (revision 0). */
  async get(
    ctx: OrgContext,
    productId: string,
  ): Promise<ProductPresentationDto> {
    return this.db.withUser(ctx.userId, async (tx) => {
      const store = await requireStore(tx, ctx);
      if (!(await this.repo.productExists(tx, ctx.tenantId, productId)))
        throw productNotFound();
      const row = await this.repo.get(tx, ctx.tenantId, store.id, productId);
      return row ? toDetail(row) : defaultDetail(productId);
    });
  }

  /**
   * Saves the draft. `expectedRevision` is the revision the editor started from (0 when there is no row yet): when
   * someone else saved or created it in the meantime, nothing is written and the caller gets a 409.
   */
  async saveDraft(
    ctx: OrgContext,
    productId: string,
    dto: SaveProductPresentationDto,
  ): Promise<ProductPresentationDto> {
    return this.db.withUser(ctx.userId, (tx) =>
      mapErrors(async () => {
        const store = await requireStore(tx, ctx);
        if (!(await this.repo.productExists(tx, ctx.tenantId, productId)))
          throw productNotFound();
        const current = await this.repo.lock(
          tx,
          ctx.tenantId,
          store.id,
          productId,
        );
        const issues = validatePresentationDocument(dto.document);
        if (issues.length) throw documentInvalid(productId, issues);

        const currentRevision = current?.revision ?? 0;
        if (currentRevision !== dto.expectedRevision)
          throw revisionConflict(currentRevision);

        if (!current) {
          const created = await this.repo.insertIfAbsent(tx, {
            tenantId: ctx.tenantId,
            storeId: store.id,
            productId,
            draft: dto.document,
          });
          // A parallel request created it first.
          if (!created) throw revisionConflict(1);
        } else if (!isDeepStrictEqual(current.draft, dto.document)) {
          // An unchanged draft is not a write: the revision must not move, or two tabs would conflict for nothing.
          const saved = await this.repo.updateDraft(tx, {
            tenantId: ctx.tenantId,
            storeId: store.id,
            productId,
            draft: dto.document,
            expectedRevision: dto.expectedRevision,
          });
          if (!saved) throw revisionConflict(current.revision);
        }
        const row = await this.repo.get(tx, ctx.tenantId, store.id, productId);
        return toDetail(row!);
      }),
    );
  }

  /** Makes the draft live. Nothing happens when the live copy already equals the draft. */
  async publish(
    ctx: OrgContext,
    productId: string,
    dto: PublishProductPresentationDto,
  ): Promise<PublishProductPresentationResultDto> {
    return this.db.withUser(ctx.userId, (tx) =>
      mapErrors(async () => {
        const store = await requireStore(tx, ctx);
        if (!(await this.repo.productExists(tx, ctx.tenantId, productId)))
          throw productNotFound();
        const current = await this.repo.lock(
          tx,
          ctx.tenantId,
          store.id,
          productId,
        );
        if (!current) throw presentationNotFound();
        if (
          dto.expectedRevision !== undefined &&
          dto.expectedRevision !== current.revision
        )
          throw revisionConflict(current.revision);
        const issues = validatePresentationDocument(current.draft);
        if (issues.length) throw documentInvalid(productId, issues);

        const changed = this.needsPublish(current);
        if (changed)
          await this.repo.setPublished(tx, {
            tenantId: ctx.tenantId,
            storeId: store.id,
            productId,
            published: current.draft,
          });
        const row = await this.repo.get(tx, ctx.tenantId, store.id, productId);
        return Object.assign(toDetail(row!), { published: changed });
      }),
    );
  }

  /**
   * Resets a product to the default design: the customization (draft and live copy) is removed, so the live
   * storefront goes back to inheriting the store design at once. Removing nothing is not an error.
   */
  async reset(
    ctx: OrgContext,
    productId: string,
  ): Promise<ProductPresentationDto> {
    return this.db.withUser(ctx.userId, (tx) =>
      mapErrors(async () => {
        const store = await requireStore(tx, ctx);
        if (!(await this.repo.productExists(tx, ctx.tenantId, productId)))
          throw productNotFound();
        await this.repo.lock(tx, ctx.tenantId, store.id, productId);
        await this.repo.remove(tx, ctx.tenantId, store.id, productId);
        return defaultDetail(productId);
      }),
    );
  }

  // ---- publish-all (called by TemplatesService.publishTheme inside its transaction) ------------------------------

  /**
   * Locks every draft of the store that is waiting to go live and validates it, WITHOUT writing anything, so the
   * caller can report every problem of the whole design before publishing a single document.
   */
  async prepareThemePublish(
    tx: DbTx,
    ctx: OrgContext,
    storeId: string,
  ): Promise<{
    candidates: ProductPresentation[];
    problems: Record<string, string>;
  }> {
    const candidates = await this.repo.lockPublishCandidates(
      tx,
      ctx.tenantId,
      storeId,
    );
    const problems: Record<string, string> = {};
    for (const c of candidates)
      Object.assign(
        problems,
        issuesToFieldErrors(
          presentationFieldKey(c.productId),
          validatePresentationDocument(c.draft),
        ),
      );
    return { candidates, problems };
  }

  /** Publishes the candidates returned (and locked) by `prepareThemePublish`; returns how many went live. */
  async publishCandidates(
    tx: DbTx,
    ctx: OrgContext,
    storeId: string,
    candidates: ProductPresentation[],
  ): Promise<number> {
    for (const c of candidates)
      await this.repo.setPublished(tx, {
        tenantId: ctx.tenantId,
        storeId,
        productId: c.productId,
        published: c.draft,
      });
    return candidates.length;
  }

  /** A draft needs publishing unless it equals the live copy, or it is an empty never-published draft. */
  private needsPublish(row: ProductPresentation): boolean {
    if (row.published === null)
      return !isDeepStrictEqual(row.draft, { ...EMPTY_PRESENTATION });
    return !isDeepStrictEqual(row.draft, row.published);
  }
}
