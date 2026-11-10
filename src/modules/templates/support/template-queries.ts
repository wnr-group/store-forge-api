import { sql } from 'drizzle-orm';
import type { DbTx } from '../../../infrastructure/database/database.types.js';
import type { TemplateDocument } from '../../../infrastructure/database/template-deps/document.js';
import { LIMITS } from '../../../infrastructure/database/template-deps/limits.js';
import { TemplateConflictError } from './template-errors.js';

export type TemplateRow = {
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
};

export type VersionRow = {
  id: string;
  templateId: string;
  versionNumber: number;
  document: TemplateDocument;
  source: string;
  rolledBackFrom: string | null;
  label: string | null;
  publishedAt: string;
  publishedBy: string | null;
};

export const TEMPLATE_SELECT_COLUMNS = sql`id, tenant_id as "tenantId", store_id as "storeId", kind, name, status, 
          is_default as "isDefault", draft, revision, 
          published_version_id as "publishedVersionId", 
          created_at as "createdAt", updated_at as "updatedAt"`;

export async function getTemplateRow(
  tx: DbTx,
  templateId: string,
): Promise<TemplateRow | undefined> {
  const rows = await tx.execute<TemplateRow>(
    sql`SELECT ${TEMPLATE_SELECT_COLUMNS} FROM templates WHERE id = ${templateId}`,
  );
  return rows[0];
}

export async function assertVersionQuota(
  tx: DbTx,
  templateId: string,
): Promise<void> {
  const verCount = await tx.execute<{ count: number }>(
    sql`SELECT count(*)::int as count FROM template_versions WHERE template_id = ${templateId}`,
  );
  if ((verCount[0]?.count ?? 0) >= LIMITS.maxVersionsPerTemplate) {
    throw new TemplateConflictError(
      `Version history quota exceeded (${LIMITS.maxVersionsPerTemplate})`,
      'quota_exceeded',
    );
  }
}
