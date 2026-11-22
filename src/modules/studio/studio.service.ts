import { createHash } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import { sql } from 'drizzle-orm';
import {
  AppException,
  forbidden,
  invalid,
  notFound,
} from '../../common/app.exception.js';
import { errorChain, mapDbError } from '../../common/db-errors.js';
import type {
  AuthUser,
  OrgContext,
} from '../../common/interfaces/request-context.js';
import {
  DatabaseService,
  rowsOf,
  type DbTx,
} from '../../database/database.service.js';
import { requireStore } from '../themes/themes.shared.js';
import {
  featureAvailability,
  STUDIO_FEATURE_KEYS,
  type FeatureAvailability,
} from './feature-availability.js';
import type {
  AttestationDto,
  CreateAttestationDto,
  DiscardDraftDto,
  LegalWordingDto,
  StudioSettingsDto,
  StudioStatusDto,
  UpdateStudioSettingsDto,
} from './studio.dto.js';

type WordingJson = {
  id: string;
  key: string;
  version: number;
  languageTag: string;
  text: string;
  status: string;
  createdAt: string;
};

export const toWordingDto = (w: WordingJson): LegalWordingDto => ({
  ...w,
  createdAt: new Date(w.createdAt),
});

/** Runs `fn`, mapping the Studio SQL guards' RAISE codes, then the standard constraint mapping. */
export async function withStudioErrors<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (e) {
    if (e instanceof AppException) throw e;
    const msg = errorChain(e);
    if (msg.includes('wording_not_approved'))
      throw invalid(
        'That wording is not approved.',
        { wordingVersion: 'Use an approved version of the wording.' },
        'WORDING_NOT_APPROVED',
      );
    if (msg.includes('asset_not_found'))
      throw invalid(
        'That file could not be found in this store.',
        { assetId: 'Unknown file' },
        'MEDIA_NOT_FOUND',
      );
    if (msg.includes('attestation_mismatch'))
      throw invalid(
        'That attestation does not belong to this file.',
        { attestationId: 'Does not match this file' },
        'ATTESTATION_MISMATCH',
      );
    if (msg.includes('attestation_already_linked'))
      throw invalid(
        'This file already has an attestation.',
        { attestationId: 'Already linked' },
        'ATTESTATION_ALREADY_LINKED',
      );
    throw mapDbError(e);
  }
}

/** Studio state for the signed-in member's store, the legal wording they must accept, and their attestations. */
@Injectable()
export class StudioService {
  constructor(private readonly db: DatabaseService) {}

  async status(org: OrgContext): Promise<StudioStatusDto> {
    return this.db.withUser(org.userId, async (tx) => {
      const rows = rowsOf<{
        s: { enabled: boolean; pointOfNoReturnAt: string | null };
      }>(
        await tx.execute(
          sql`select public.studio_rollout_status(${org.tenantId}::uuid) as s`,
        ),
      );
      const s = rows[0]?.s;
      if (!s)
        throw notFound(
          'No store was found for this organization.',
          'STORE_NOT_FOUND',
        );
      const features = {} as Record<string, FeatureAvailability>;
      for (const key of STUDIO_FEATURE_KEYS)
        features[key] = await featureAvailability(tx, key);
      return {
        enabled: s.enabled,
        schemaV2Capable: s.enabled,
        schemaVersion: s.enabled ? 2 : 1,
        pointOfNoReturnAt: s.pointOfNoReturnAt
          ? new Date(s.pointOfNoReturnAt)
          : null,
        features,
      };
    });
  }

  /** The newest approved version of a wording. Drafts and retired versions are never returned. */
  async approvedWording(
    org: OrgContext,
    key: string,
  ): Promise<LegalWordingDto> {
    return this.db.withUser(org.userId, async (tx) => {
      const rows = rowsOf<{ w: WordingJson | null }>(
        await tx.execute(
          sql`select public.get_approved_legal_wording(${key}) as w`,
        ),
      );
      const w = rows[0]?.w;
      if (!w)
        throw notFound(
          'There is no approved wording with that key.',
          'WORDING_NOT_FOUND',
        );
      return toWordingDto(w);
    });
  }

  /**
   * Records that the signed-in member accepted an exact wording version. The database insert policy requires the
   * `attest` capability (the Owner holds it) and the trigger refuses wording that is not approved.
   */
  async attest(
    org: OrgContext,
    dto: CreateAttestationDto,
  ): Promise<AttestationDto> {
    if (dto.type === 'badge_upload' && dto.importId)
      throw invalid('A badge attestation cannot reference an import.', {
        importId: 'Not allowed for this type',
      });
    if (dto.type === 'review_import' && dto.assetId)
      throw invalid('A review import attestation cannot reference a file.', {
        assetId: 'Not allowed for this type',
      });
    return withStudioErrors(() =>
      this.db.withUser(org.userId, (tx) =>
        this.insertAttestation(tx, org, dto),
      ),
    );
  }

  private async insertAttestation(
    tx: DbTx,
    org: OrgContext,
    dto: CreateAttestationDto,
  ): Promise<AttestationDto> {
    const wording = rowsOf<{ id: string | null }>(
      await tx.execute(
        sql`select public.resolve_approved_legal_wording(${dto.wordingKey}, ${dto.wordingVersion}::int) as id`,
      ),
    )[0]?.id;
    if (!wording)
      throw invalid(
        'That wording is unknown or not approved.',
        { wordingVersion: 'Use an approved version of the wording.' },
        'WORDING_NOT_APPROVED',
      );
    const store = await requireStore(tx, org);
    // Raw SQL: the app role may only insert specific columns (migration 0037), so no DEFAULT for the others.
    const rows = rowsOf<{
      id: string;
      accepted_at: string | Date;
      asset_id: string | null;
      import_id: string | null;
    }>(
      await tx.execute(sql`insert into public.attestations
        (tenant_id, store_id, user_id, type, wording_id, asset_id, import_id, context)
        values (${org.tenantId}::uuid, ${store.id}::uuid, ${org.userId}::uuid, ${dto.type}, ${wording}::uuid,
                ${dto.assetId ?? null}::uuid, ${dto.importId ?? null}::uuid, ${JSON.stringify(dto.context ?? {})}::jsonb)
        returning id, accepted_at, asset_id, import_id`),
    );
    const r = rows[0];
    return {
      id: r.id,
      type: dto.type,
      wordingId: wording,
      wordingKey: dto.wordingKey,
      wordingVersion: dto.wordingVersion,
      userId: org.userId,
      acceptedAt: new Date(r.accepted_at),
      assetId: r.asset_id,
      importId: r.import_id,
    };
  }

  /** Read current store studio settings (disclosure text and language). */
  async getSettings(org: OrgContext): Promise<StudioSettingsDto> {
    return this.db.withUser(org.userId, async (tx) => {
      const store = await requireStore(tx, org);
      const rows = rowsOf<{
        review_disclosure_text: string;
        review_disclosure_language: string;
      }>(
        await tx.execute(
          sql`SELECT review_disclosure_text, review_disclosure_language
              FROM public.store_studio_settings
              WHERE store_id = ${store.id}`,
        ),
      );
      if (rows[0]) {
        return {
          reviewDisclosureText: rows[0].review_disclosure_text,
          reviewDisclosureLanguage: rows[0].review_disclosure_language,
        };
      }
      return {
        reviewDisclosureText: 'Feedback collected by the store.',
        reviewDisclosureLanguage: 'en',
      };
    });
  }

  /** Update store studio settings. */
  async updateSettings(
    org: OrgContext,
    user: AuthUser,
    dto: UpdateStudioSettingsDto,
  ): Promise<StudioSettingsDto> {
    return this.db.withUser(user.id, async (tx) => {
      const store = await requireStore(tx, org);
      const text =
        dto.reviewDisclosureText ?? 'Feedback collected by the store.';
      const lang = dto.reviewDisclosureLanguage ?? 'en';

      await tx.execute(
        sql`INSERT INTO public.store_studio_settings
              (store_id, tenant_id, review_disclosure_text, review_disclosure_language, updated_by, updated_at)
            VALUES
              (${store.id}, ${org.tenantId}, ${text}, ${lang}, ${user.id}, now())
            ON CONFLICT (store_id) DO UPDATE SET
              review_disclosure_text = COALESCE(${dto.reviewDisclosureText}, public.store_studio_settings.review_disclosure_text),
              review_disclosure_language = COALESCE(${dto.reviewDisclosureLanguage}, public.store_studio_settings.review_disclosure_language),
              updated_by = ${user.id},
              updated_at = now()`,
      );

      return this.getSettings(org);
    });
  }

  /** Aggregated Web Vitals performance statistics for the store. */
  async getSpeed(org: OrgContext) {
    return this.db.withUser(org.userId, async (tx) => {
      const store = await requireStore(tx, org);

      const rows = rowsOf<{
        metric: string;
        route_kind: string;
        device_class: string;
        sample_count: number;
        bucket_counts: Record<string, number>;
      }>(
        await tx.execute(
          sql`SELECT metric, route_kind, device_class, sum(sample_count) as sample_count,
                     jsonb_object_agg(key, sum_val) as bucket_counts
              FROM (
                SELECT metric, route_kind, device_class, sample_count,
                       (b.key)::text as key, sum((b.value)::numeric) as sum_val
                FROM public.web_vitals_daily w,
                     jsonb_each_text(w.bucket_counts) b
                WHERE w.store_id = ${store.id} AND w.day >= CURRENT_DATE - INTERVAL '30 days'
                GROUP BY metric, route_kind, device_class, sample_count, b.key
              ) sub
              GROUP BY metric, route_kind, device_class`,
        ),
      );

      return {
        storeId: store.id,
        metrics: rows,
      };
    });
  }

  /** Mark store design drafts ready for review, locking draft revision fingerprint. */
  async requestReview(org: OrgContext, user: AuthUser) {
    return this.db.withUser(user.id, async (tx) => {
      const store = await requireStore(tx, org);

      const templates = rowsOf<{
        id: string;
        name: string;
        kind: string;
        draft_revision: number | null;
        draft_document: unknown;
      }>(
        await tx.execute(
          sql`SELECT id, name, kind, draft_revision, draft_document
              FROM public.templates
              WHERE tenant_id = ${org.tenantId} AND store_id = ${store.id} AND status <> 'archived'
              ORDER BY id ASC`,
        ),
      );

      const items = templates.map((t) => ({
        templateId: t.id,
        name: t.name,
        kind: t.kind,
        draftRevision: t.draft_revision ?? 1,
      }));

      const hashPayload = JSON.stringify(
        templates.map((t) => ({
          id: t.id,
          revision: t.draft_revision ?? 1,
          doc: t.draft_document,
        })),
      );
      const fingerprint = createHash('sha256')
        .update(hashPayload)
        .digest('hex');

      // Clear any prior active review requests
      await tx.execute(
        sql`UPDATE public.draft_review_requests
            SET cleared_at = now(), cleared_reason = 'superceded'
            WHERE tenant_id = ${org.tenantId} AND store_id = ${store.id} AND cleared_at IS NULL`,
      );

      const rows = rowsOf<{
        id: string;
        fingerprint: string;
        submitted_at: string;
      }>(
        await tx.execute(
          sql`INSERT INTO public.draft_review_requests
                (tenant_id, store_id, fingerprint, items, submitted_by)
              VALUES
                (${org.tenantId}, ${store.id}, ${fingerprint}, ${JSON.stringify(items)}::jsonb, ${user.id})
              RETURNING id, fingerprint, submitted_at`,
        ),
      );

      const r = rows[0];
      return {
        id: r.id,
        fingerprint: r.fingerprint,
        items,
        submittedBy: user.id,
        submittedAt: new Date(r.submitted_at),
      };
    });
  }

  /** Get active review request if one exists. */
  async getCurrentReview(org: OrgContext) {
    return this.db.withUser(org.userId, async (tx) => {
      const store = await requireStore(tx, org);

      const rows = rowsOf<{
        id: string;
        fingerprint: string;
        items: unknown[];
        submitted_by: string;
        submitted_at: string;
      }>(
        await tx.execute(
          sql`SELECT id, fingerprint, items, submitted_by, submitted_at
              FROM public.draft_review_requests
              WHERE tenant_id = ${org.tenantId} AND store_id = ${store.id} AND cleared_at IS NULL
              ORDER BY submitted_at DESC
              LIMIT 1`,
        ),
      );

      if (!rows[0]) return null;

      const r = rows[0];
      return {
        id: r.id,
        fingerprint: r.fingerprint,
        items: r.items,
        submittedBy: r.submitted_by,
        submittedAt: new Date(r.submitted_at),
      };
    });
  }

  /** Compares drafts of all templates in the store against published versions. */
  async getChanges(org: OrgContext) {
    return this.db.withUser(org.userId, async (tx) => {
      const store = await requireStore(tx, org);

      const rows = rowsOf<{
        id: string;
        name: string;
        kind: string;
        published_version_id: string | null;
        draft_document: Record<string, unknown>;
        published_document: Record<string, unknown> | null;
      }>(
        await tx.execute(
          sql`SELECT t.id, t.name, t.kind, t.published_version_id, t.draft_document,
                     tv.document as published_document
              FROM public.templates t
              LEFT JOIN public.template_versions tv ON tv.id = t.published_version_id
              WHERE t.tenant_id = ${org.tenantId} AND t.store_id = ${store.id} AND t.status <> 'archived'
              ORDER BY t.name ASC`,
        ),
      );

      return rows.map((r) => {
        const draftSections = (r.draft_document?.sections as unknown[]) ?? [];
        const pubSections = (r.published_document?.sections as unknown[]) ?? [];

        const hasChanges =
          !r.published_version_id ||
          JSON.stringify(r.draft_document) !==
            JSON.stringify(r.published_document);

        return {
          templateId: r.id,
          name: r.name,
          kind: r.kind,
          publishedVersionId: r.published_version_id,
          hasChanges,
          draftSectionCount: Array.isArray(draftSections)
            ? draftSections.length
            : 0,
          publishedSectionCount: Array.isArray(pubSections)
            ? pubSections.length
            : 0,
        };
      });
    });
  }

  /** Query change ledger entries for template or store. */
  async getLedger(org: OrgContext, templateId?: string) {
    return this.db.withUser(org.userId, async (tx) => {
      const store = await requireStore(tx, org);

      const query = templateId
        ? sql`SELECT * FROM public.change_ledger
              WHERE tenant_id = ${org.tenantId} AND store_id = ${store.id} AND document_id = ${templateId}
              ORDER BY created_at DESC LIMIT 100`
        : sql`SELECT * FROM public.change_ledger
              WHERE tenant_id = ${org.tenantId} AND store_id = ${store.id}
              ORDER BY created_at DESC LIMIT 100`;

      return rowsOf(await tx.execute(query));
    });
  }

  /**
   * Discard draft changes back to published version.
   * Requires 'discard' capability or store owner. Writes to append-only draft_discard_audit.
   */
  async discardDraft(org: OrgContext, user: AuthUser, dto: DiscardDraftDto) {
    return this.db.withUser(user.id, async (tx) => {
      const store = await requireStore(tx, org);

      // Verify permission/capability: user must have 'discard' in capabilities or role = 'owner'
      const memberRows = rowsOf<{
        role: string;
        capabilities: string[] | null;
      }>(
        await tx.execute(
          sql`SELECT role, capabilities FROM public.memberships
              WHERE tenant_id = ${org.tenantId} AND user_id = ${user.id} AND status = 'active'`,
        ),
      );
      const member = memberRows[0];
      const hasDiscardCap =
        member &&
        (member.role === 'owner' ||
          (member.capabilities && member.capabilities.includes('discard')));

      if (!hasDiscardCap) {
        throw forbidden(
          'You do not have permission to discard draft changes. The discard capability is required.',
        );
      }

      // Find template
      const templateRows = rowsOf<{
        id: string;
        published_version_id: string | null;
        draft_document: unknown;
        draft_revision: number | null;
        updated_by: string | null;
      }>(
        await tx.execute(
          sql`SELECT id, published_version_id, draft_document, draft_revision, updated_by
              FROM public.templates
              WHERE tenant_id = ${org.tenantId} AND store_id = ${store.id} AND id = ${dto.templateId}`,
        ),
      );

      const t = templateRows[0];
      if (!t) {
        throw notFound('Template not found.', 'TEMPLATE_NOT_FOUND');
      }

      // Get target document from published version if present
      let targetDoc: unknown = null;
      if (t.published_version_id) {
        const pubRows = rowsOf<{ document: unknown }>(
          await tx.execute(
            sql`SELECT document FROM public.template_versions WHERE id = ${t.published_version_id}`,
          ),
        );
        targetDoc = pubRows[0]?.document;
      }

      const beforeHash = createHash('sha256')
        .update(JSON.stringify(t.draft_document))
        .digest('hex');
      const afterHash = targetDoc
        ? createHash('sha256').update(JSON.stringify(targetDoc)).digest('hex')
        : null;
      const discardedRevision = t.draft_revision ?? 1;

      // Reset draft document
      if (targetDoc) {
        await tx.execute(
          sql`UPDATE public.templates
              SET draft_document = ${JSON.stringify(targetDoc)}::jsonb,
                  draft_revision = COALESCE(draft_revision, 1) + 1,
                  updated_by = ${user.id},
                  updated_at = now()
              WHERE id = ${dto.templateId}`,
        );
      }

      // Record in draft_discard_audit
      await tx.execute(
        sql`INSERT INTO public.draft_discard_audit
              (tenant_id, store_id, acting_user_id, affected_user_id, document_type, document_id, node_id, discarded_revisions, reason, before_hash, after_hash)
            VALUES
              (${org.tenantId}, ${store.id}, ${user.id}, ${t.updated_by ?? user.id}, 'template', ${dto.templateId}, 'root', ARRAY[${discardedRevision}], ${dto.reason}, ${beforeHash}, ${afterHash})`,
      );

      return {
        success: true,
        templateId: dto.templateId,
        discardedRevision,
      };
    });
  }
}
