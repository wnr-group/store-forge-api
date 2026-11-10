import { Injectable } from '@nestjs/common';
import { sql } from 'drizzle-orm';
import type { DbTx } from '../../../infrastructure/database/database.types.js';
import {
  PAGE_KINDS,
  SHARED_KINDS,
  type TemplateDocument,
} from '../../../infrastructure/database/template-deps/document.js';
import { getPresetDocument } from '../../../infrastructure/templates-engine/presets.js';
import { TemplateNotFoundError } from '../support/template-errors.js';

export type TemplateSummaryItem = {
  id: string;
  kind: string;
  name: string;
  status: string;
  isDefault: boolean;
  revision: number;
  publishedVersionId: string | null;
  publicationState:
    'archived' | 'draft' | 'published' | 'published_with_changes';
  createdAt: string;
  updatedAt: string;
};

export type VersionMetadataItem = {
  id: string;
  versionNumber: number;
  source: string;
  rolledBackFrom: string | null;
  label: string | null;
  publishedAt: string;
  publishedBy: string | null;
};

@Injectable()
export class TemplateQueryService {
  /**
   * Lists page templates with calculated 4-state publication status in a single SQL query (D36, D49).
   */
  async listTemplates(
    tx: DbTx,
    tenantId: string,
    storeId: string,
    opts: { page?: number; pageSize?: number } = {},
  ): Promise<{
    items: TemplateSummaryItem[];
    total: number;
    page: number;
    pageSize: number;
  }> {
    const page = Math.max(1, opts.page ?? 1);
    const pageSize = opts.pageSize ?? 20;
    const offset = (page - 1) * pageSize;

    const countRes = await tx.execute<{ count: number }>(
      sql`SELECT count(*)::int as count FROM templates 
          WHERE store_id = ${storeId} 
            AND tenant_id = ${tenantId} 
            AND kind IN (${sql.raw(PAGE_KINDS.map((k) => `'${k}'`).join(', '))})`,
    );
    const total = countRes[0]?.count ?? 0;

    const items = await tx.execute<TemplateSummaryItem>(
      sql`SELECT 
            t.id, t.kind, t.name, t.status, t.is_default as "isDefault", 
            t.revision, t.published_version_id as "publishedVersionId",
            t.created_at as "createdAt", t.updated_at as "updatedAt",
            CASE 
              WHEN t.status = 'archived' THEN 'archived'
              WHEN t.published_version_id IS NULL THEN 'draft'
              WHEN t.draft = v.document THEN 'published'
              ELSE 'published_with_changes'
            END AS "publicationState"
          FROM templates t
          LEFT JOIN template_versions v 
            ON v.id = t.published_version_id AND v.template_id = t.id
          WHERE t.store_id = ${storeId}
            AND t.tenant_id = ${tenantId}
            AND t.kind IN (${sql.raw(PAGE_KINDS.map((k) => `'${k}'`).join(', '))})
          ORDER BY t.created_at DESC, t.id DESC
          LIMIT ${pageSize} OFFSET ${offset}`,
    );

    return { items, total, page, pageSize };
  }

  /**
   * Gets a single page template with full draft document. Returns 404 for shared kinds or cross-tenant (D43).
   */
  async getTemplate(
    tx: DbTx,
    tenantId: string,
    storeId: string,
    templateId: string,
  ): Promise<{
    id: string;
    tenantId: string;
    storeId: string;
    kind: string;
    name: string;
    status: string;
    isDefault: boolean;
    draft: TemplateDocument;
    revision: number;
    publishedVersionId: string | null;
    createdAt: string;
    updatedAt: string;
  }> {
    const rows = await tx.execute<{
      id: string;
      tenantId: string;
      storeId: string;
      kind: string;
      name: string;
      status: string;
      isDefault: boolean;
      draft: TemplateDocument;
      revision: number;
      publishedVersionId: string | null;
      createdAt: string;
      updatedAt: string;
    }>(
      sql`SELECT 
            id, tenant_id as "tenantId", store_id as "storeId", kind, name, status, 
            is_default as "isDefault", draft, revision, 
            published_version_id as "publishedVersionId", 
            created_at as "createdAt", updated_at as "updatedAt"
          FROM templates
          WHERE id = ${templateId}
            AND store_id = ${storeId}
            AND tenant_id = ${tenantId}
            AND kind IN (${sql.raw(PAGE_KINDS.map((k) => `'${k}'`).join(', '))})`,
    );

    if (!rows[0]) {
      throw new TemplateNotFoundError(`Template not found: ${templateId}`);
    }
    return rows[0];
  }

  /**
   * Lists version metadata for a template (D22).
   */
  async listVersions(
    tx: DbTx,
    tenantId: string,
    storeId: string,
    templateId: string,
    opts: { page?: number; pageSize?: number } = {},
  ): Promise<{
    items: VersionMetadataItem[];
    total: number;
    page: number;
    pageSize: number;
  }> {
    // Check page template existence first
    await this.getTemplate(tx, tenantId, storeId, templateId);

    const page = Math.max(1, opts.page ?? 1);
    const pageSize = opts.pageSize ?? 20;
    const offset = (page - 1) * pageSize;

    const countRes = await tx.execute<{ count: number }>(
      sql`SELECT count(*)::int as count FROM template_versions 
          WHERE template_id = ${templateId} AND store_id = ${storeId} AND tenant_id = ${tenantId}`,
    );
    const total = countRes[0]?.count ?? 0;

    const items = await tx.execute<VersionMetadataItem>(
      sql`SELECT 
            id, version_number as "versionNumber", source, 
            rolled_back_from as "rolledBackFrom", label, 
            published_at as "publishedAt", published_by as "publishedBy"
          FROM template_versions
          WHERE template_id = ${templateId}
            AND store_id = ${storeId}
            AND tenant_id = ${tenantId}
          ORDER BY version_number DESC
          LIMIT ${pageSize} OFFSET ${offset}`,
    );

    return { items, total, page, pageSize };
  }

  /**
   * Gets a specific historical version including its document (D22).
   */
  async getVersion(
    tx: DbTx,
    tenantId: string,
    storeId: string,
    templateId: string,
    versionId: string,
  ): Promise<{
    id: string;
    templateId: string;
    versionNumber: number;
    document: TemplateDocument;
    source: string;
    rolledBackFrom: string | null;
    label: string | null;
    publishedAt: string;
    publishedBy: string | null;
  }> {
    // Check template existence
    await this.getTemplate(tx, tenantId, storeId, templateId);

    const rows = await tx.execute<{
      id: string;
      templateId: string;
      versionNumber: number;
      document: TemplateDocument;
      source: string;
      rolledBackFrom: string | null;
      label: string | null;
      publishedAt: string;
      publishedBy: string | null;
    }>(
      sql`SELECT 
            id, template_id as "templateId", version_number as "versionNumber", 
            document, source, rolled_back_from as "rolledBackFrom", label, 
            published_at as "publishedAt", published_by as "publishedBy"
          FROM template_versions
          WHERE id = ${versionId}
            AND template_id = ${templateId}
            AND store_id = ${storeId}
            AND tenant_id = ${tenantId}`,
    );

    if (!rows[0]) {
      throw new TemplateNotFoundError(`Version not found: ${versionId}`);
    }
    return rows[0];
  }

  /**
   * Gets effective shared document. If no row exists yet, returns registry default with revision 0 (D13, D27, AC-LIFE-021).
   */
  async getSharedDocument(
    tx: DbTx,
    tenantId: string,
    storeId: string,
    kind: string,
  ): Promise<{
    id: string | null;
    kind: string;
    document: unknown;
    revision: number;
    isDefault: boolean;
    publishedVersionId: string | null;
    publicationState: string;
  }> {
    if (!SHARED_KINDS.includes(kind as (typeof SHARED_KINDS)[number])) {
      throw new TemplateNotFoundError(`Unknown shared document kind: ${kind}`);
    }

    const rows = await tx.execute<{
      id: string;
      kind: string;
      draft: unknown;
      revision: number;
      publishedVersionId: string | null;
      publicationState: string;
    }>(
      sql`SELECT 
            t.id, t.kind, t.draft, t.revision, 
            t.published_version_id as "publishedVersionId",
            CASE 
              WHEN t.published_version_id IS NULL THEN 'draft'
              WHEN t.draft = v.document THEN 'published'
              ELSE 'published_with_changes'
            END AS "publicationState"
          FROM templates t
          LEFT JOIN template_versions v ON v.id = t.published_version_id AND v.template_id = t.id
          WHERE t.store_id = ${storeId}
            AND t.tenant_id = ${tenantId}
            AND t.kind = ${kind}`,
    );

    if (rows[0]) {
      return {
        id: rows[0].id,
        kind: rows[0].kind,
        document: rows[0].draft,
        revision: rows[0].revision,
        isDefault: false,
        publishedVersionId: rows[0].publishedVersionId,
        publicationState: rows[0].publicationState,
      };
    }

    // Lazy default from preset registry (D13, D21, D27)
    return {
      id: null,
      kind,
      document: getPresetDocument(kind as (typeof SHARED_KINDS)[number]),
      revision: 0,
      isDefault: false,
      publishedVersionId: null,
      publicationState: 'draft',
    };
  }
}
