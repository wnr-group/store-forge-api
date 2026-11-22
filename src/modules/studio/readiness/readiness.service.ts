import { Injectable } from '@nestjs/common';
import { sql } from 'drizzle-orm';
import { isDeepStrictEqual } from 'node:util';
import { AppException, notFound } from '../../../common/app.exception.js';
import type { OrgContext } from '../../../common/interfaces/request-context.js';
import {
  DatabaseService,
  rowsOf,
  type DbTx,
} from '../../../database/database.service.js';
import {
  PAGE_TEMPLATE_KINDS,
  type Template,
} from '../../../database/schema/templates.js';
import { ThemesRepository } from '../../themes/themes.repository.js';
import type { TemplateRow } from '../../themes/themes.repository.js';
import { requireStore } from '../../themes/themes.shared.js';
import {
  featureAvailability,
  type FeatureAvailability,
} from '../feature-availability.js';
import { evaluateReadiness, unacknowledgedWarnings } from './engine.js';
import { loadManifests } from './manifests.js';
import type { ReadinessContext, ReadinessReport } from './types.js';

/**
 * Checkout is not part of the platform yet, so a component that requires the purchase flow is unavailable. The rule reads
 * this through the context, so turning checkout on later is one change here (never a client value).
 */
export const PURCHASE_FLOW_LIVE = false;

/** The document schema version a Studio-enabled store publishes under (see studio status: enabled means schema 2). */
export const STUDIO_PUBLISH_SCHEMA_VERSION = 2;

const MAX_RECORDED = 300;

type Store = Awaited<ReturnType<typeof requireStore>>;

export interface PublishedItem {
  templateId: string;
  kind: string;
  versionNumber: number;
}

const blocked = (code: string, message: string, report: ReadinessReport) =>
  new AppException('VALIDATION', message, {
    code,
    details: { issues: report.issues, counts: report.counts },
  });

/** True for the documents a theme publish would go through: active, and for page kinds the default one. */
export const isPublishCandidate = (
  t: Pick<Template, 'status' | 'kind' | 'isDefault'>,
) =>
  t.status === 'active' &&
  ((PAGE_TEMPLATE_KINDS as readonly string[]).includes(t.kind)
    ? t.isDefault
    : true);

const isChanged = (t: TemplateRow) =>
  !t.publishedVersionId || !isDeepStrictEqual(t.publishedDocument, t.draft);

@Injectable()
export class ReadinessService {
  constructor(
    private readonly db: DatabaseService,
    private readonly repo: ThemesRepository,
  ) {}

  /** Whether the new Studio is switched on for the caller's store (default off). The publish gate only runs when it is. */
  async isEnforced(tx: DbTx, org: OrgContext): Promise<boolean> {
    const rows = rowsOf<{ s: { enabled: boolean } | null }>(
      await tx.execute(
        sql`select public.studio_rollout_status(${org.tenantId}::uuid) as s`,
      ),
    );
    return rows[0]?.s?.enabled === true;
  }

  async buildContext(
    tx: DbTx,
    org: OrgContext,
    store: Store,
    documents: readonly TemplateRow[],
  ): Promise<ReadinessContext> {
    const manifests = loadManifests();
    const availability: Record<string, FeatureAvailability> = {};
    for (const m of manifests.values()) {
      const key = m.legal.featureKey;
      if (m.legal.required && key && !(key in availability))
        availability[key] = await featureAvailability(tx, key);
    }
    return {
      tenantId: org.tenantId,
      storeId: store.id,
      store: { timezone: store.timezone, currency: store.currency },
      documents: documents.map((t) => ({
        id: t.id,
        kind: t.kind,
        name: t.name,
        document: t.draft,
      })),
      manifests,
      now: new Date(),
      availability,
      purchaseFlowLive: PURCHASE_FLOW_LIVE,
      actor: { userId: org.userId },
    };
  }

  async evaluate(
    tx: DbTx,
    org: OrgContext,
    store: Store,
    documents: readonly TemplateRow[],
  ): Promise<ReadinessReport> {
    return evaluateReadiness(
      await this.buildContext(tx, org, store, documents),
    );
  }

  /** The report for the store's drafts (every active page and shared document), or for one document. */
  async report(
    org: OrgContext,
    templateId?: string,
  ): Promise<ReadinessReport & { enforced: boolean }> {
    return this.db.withUser(org.userId, async (tx) => {
      const store = await requireStore(tx, org);
      const all = await this.repo.listTemplates(tx, org.tenantId, store.id);
      const docs = templateId
        ? all.filter((t) => t.id === templateId && t.status === 'active')
        : all.filter(isPublishCandidate);
      if (templateId && !docs.length)
        throw notFound('That design could not be found.', 'TEMPLATE_NOT_FOUND');
      const report = await this.evaluate(tx, org, store, docs);
      return { ...report, enforced: await this.isEnforced(tx, org) };
    });
  }

  /**
   * The publish gate for a Studio-enabled store. Runs inside the publish transaction BEFORE any write: a BLOCKER is
   * refused with the issue list (no override exists), and every WARNING must be named in `acknowledged`. Returns the
   * report and the warnings that were acknowledged, to be stored with the publish. Only documents whose draft differs from
   * their live version are checked, because only those go live.
   */
  async enforcePublish(
    tx: DbTx,
    org: OrgContext,
    store: Store,
    candidates: readonly TemplateRow[],
    acknowledged: readonly string[] | undefined,
  ): Promise<{
    report: ReadinessReport;
    acknowledged: ReadinessReport['issues'];
  }> {
    const report = await this.evaluate(
      tx,
      org,
      store,
      candidates.filter(isChanged),
    );
    if (report.counts.blockers > 0)
      throw blocked(
        'READINESS_BLOCKED',
        'This design has problems that must be fixed before it can be published.',
        report,
      );
    const missing = unacknowledgedWarnings(report, acknowledged ?? []);
    if (missing.length)
      throw blocked(
        'READINESS_ACKNOWLEDGEMENT_REQUIRED',
        'Review the warnings and confirm them to publish.',
        { ...report, issues: missing },
      );
    return {
      report,
      acknowledged: report.issues.filter((i) => i.severity === 'WARNING'),
    };
  }

  /** Appends the publish record in the publish transaction. Does nothing when nothing went live. */
  async recordPublish(
    tx: DbTx,
    org: OrgContext,
    store: Store,
    items: readonly PublishedItem[],
    gate: { report: ReadinessReport; acknowledged: ReadinessReport['issues'] },
    extra: { productPresentations?: number } = {},
  ): Promise<void> {
    if (!items.length && !extra.productPresentations) return;
    const acknowledgements = gate.acknowledged
      .slice(0, MAX_RECORDED)
      .map((i) => ({
        key: i.key,
        ruleId: i.ruleId,
        documentId: i.target.documentId,
        nodeId: i.target.nodeId,
      }));
    const summary = {
      counts: gate.report.counts,
      evaluatedAt: gate.report.evaluatedAt,
      warningKeys: gate.report.issues
        .filter((i) => i.severity === 'WARNING')
        .slice(0, MAX_RECORDED)
        .map((i) => i.key),
      productPresentations: extra.productPresentations ?? 0,
    };
    // Raw SQL: the app role may only insert specific columns (migration 0037), so no DEFAULT for the others.
    await tx.execute(sql`insert into public.studio_publishes
      (tenant_id, store_id, published_by, items, warning_acknowledgements, readiness_summary, studio_schema_version)
      values (${org.tenantId}::uuid, ${store.id}::uuid, ${org.userId}::uuid,
              ${JSON.stringify(items)}::jsonb, ${JSON.stringify(acknowledgements)}::jsonb,
              ${JSON.stringify(summary)}::jsonb, ${STUDIO_PUBLISH_SCHEMA_VERSION})`);
  }
}
