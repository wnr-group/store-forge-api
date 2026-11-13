import { Injectable } from '@nestjs/common';
import { sql } from 'drizzle-orm';
import type { DbTx } from '../../../infrastructure/database/database.types.js';
import {
  PAGE_KINDS,
  type TemplateDocument,
  type TemplateKind,
} from '../../../infrastructure/database/template-deps/document.js';
import { LIMITS } from '../../../infrastructure/database/template-deps/limits.js';
import { migrateDocument } from '../../../infrastructure/templates-engine/engine/migrate.js';
import { validateDocument } from '../../../infrastructure/templates-engine/engine/validate.js';
import {
  getPresetDocument,
  isIndexPresetKey,
} from '../../../infrastructure/templates-engine/presets.js';
import { getRegistry } from '../../../infrastructure/templates-engine/registry/index.js';
import { cloneWithFreshIds } from '../support/fresh-ids.js';
import { lockStore, lockTemplates } from '../support/lock-order.js';
import { copyName, normalizeName } from '../support/names.js';
import {
  TemplateConflictError,
  TemplateNotFoundError,
  TemplateValidationError,
} from '../support/template-errors.js';
import {
  TEMPLATE_SELECT_COLUMNS,
  type TemplateRow,
} from '../support/template-queries.js';

export interface CreateTemplateDto {
  kind: string;
  name: string;
  presetKey?: string;
}

@Injectable()
export class TemplateService {
  private readonly registry = getRegistry();

  /**
   * Creates a template from an approved preset (D30, AC-LIFE-001).
   */
  async createTemplate(
    tx: DbTx,
    tenantId: string,
    storeId: string,
    dto: CreateTemplateDto,
  ) {
    if (!PAGE_KINDS.includes(dto.kind as (typeof PAGE_KINDS)[number])) {
      throw new TemplateValidationError(`Invalid page kind: ${dto.kind}`);
    }

    if (dto.kind === 'index') {
      if (!dto.presetKey || !isIndexPresetKey(dto.presetKey)) {
        throw new TemplateValidationError(
          `presetKey must be "classic" or "spotlight" for index templates`,
        );
      }
    }

    const name = normalizeName(dto.name);
    if (!name) {
      throw new TemplateValidationError('Name must be 1 to 80 characters');
    }

    const presetDoc = getPresetDocument(
      dto.kind as TemplateKind,
      dto.presetKey,
    );
    const migrated = migrateDocument(dto.kind as TemplateKind, presetDoc);
    const validation = validateDocument(
      dto.kind as TemplateKind,
      migrated,
      this.registry,
      { tenantId },
    );
    if (!validation.ok) {
      throw new TemplateValidationError(
        'Preset document failed validation',
        validation.issues,
      );
    }

    // Lock store row for quota enforcement (D5, D50)
    await lockStore(tx, tenantId, storeId);

    // Active quota check (D6, D13)
    const countRes = await tx.execute<{ count: number }>(
      sql`SELECT count(*)::int as count FROM templates 
          WHERE store_id = ${storeId} AND tenant_id = ${tenantId} 
            AND status = 'active' AND kind IN (${sql.raw(PAGE_KINDS.map((k) => `'${k}'`).join(', '))})`,
    );
    if ((countRes[0]?.count ?? 0) >= LIMITS.maxActiveTemplatesPerStore) {
      throw new TemplateConflictError(
        `Active templates quota exceeded (${LIMITS.maxActiveTemplatesPerStore})`,
        'quota_exceeded',
      );
    }

    const rows = await tx.execute<TemplateRow>(
      sql`INSERT INTO templates (tenant_id, store_id, kind, name, is_default, draft)
          VALUES (${tenantId}, ${storeId}, ${dto.kind}, ${name}, false, ${sql.raw(`'${JSON.stringify(migrated)}'::jsonb`)})
          RETURNING ${TEMPLATE_SELECT_COLUMNS}`,
    );

    return rows[0];
  }

  /**
   * Duplicates an existing template (D21, AC-LIFE-002).
   */
  async duplicateTemplate(
    tx: DbTx,
    tenantId: string,
    storeId: string,
    templateId: string,
  ) {
    // Read source template unlocked (D21)
    const sourceRows = await tx.execute<{
      id: string;
      kind: TemplateKind;
      name: string;
      draft: TemplateDocument;
    }>(
      sql`SELECT id, kind, name, draft FROM templates
          WHERE id = ${templateId} AND store_id = ${storeId} AND tenant_id = ${tenantId}
            AND kind IN (${sql.raw(PAGE_KINDS.map((k) => `'${k}'`).join(', '))})`,
    );
    if (!sourceRows[0]) {
      throw new TemplateNotFoundError(`Template not found: ${templateId}`);
    }
    const source = sourceRows[0];

    // Validate source draft before duplicating
    const validation = validateDocument(
      source.kind,
      source.draft,
      this.registry,
      { tenantId },
    );
    if (!validation.ok) {
      throw new TemplateValidationError(
        'Source template draft is invalid',
        validation.issues,
      );
    }

    // Fresh ID clone and copy name
    const clonedDoc = cloneWithFreshIds(source.draft, (prefix) => {
      const hex = Math.random().toString(16).substring(2, 10);
      return `${prefix}_${hex}`;
    });
    const newName = copyName(source.name);

    // Lock store for quota
    await lockStore(tx, tenantId, storeId);

    const countRes = await tx.execute<{ count: number }>(
      sql`SELECT count(*)::int as count FROM templates 
          WHERE store_id = ${storeId} AND tenant_id = ${tenantId} 
            AND status = 'active' AND kind IN (${sql.raw(PAGE_KINDS.map((k) => `'${k}'`).join(', '))})`,
    );
    if ((countRes[0]?.count ?? 0) >= LIMITS.maxActiveTemplatesPerStore) {
      throw new TemplateConflictError(
        `Active templates quota exceeded (${LIMITS.maxActiveTemplatesPerStore})`,
        'quota_exceeded',
      );
    }

    const rows = await tx.execute<TemplateRow>(
      sql`INSERT INTO templates (tenant_id, store_id, kind, name, is_default, draft)
          VALUES (${tenantId}, ${storeId}, ${source.kind}, ${newName}, false, ${sql.raw(`'${JSON.stringify(clonedDoc)}'::jsonb`)})
          RETURNING ${TEMPLATE_SELECT_COLUMNS}`,
    );

    return rows[0];
  }

  /**
   * Renames a template (D20, AC-LIFE-003).
   */
  async renameTemplate(
    tx: DbTx,
    tenantId: string,
    storeId: string,
    templateId: string,
    newName: string,
  ) {
    const name = normalizeName(newName);
    if (!name) {
      throw new TemplateValidationError('Name must be 1 to 80 characters');
    }

    await lockTemplates(tx, [templateId]);

    const rows = await tx.execute<{
      id: string;
      kind: string;
      name: string;
      status: string;
      isDefault: boolean;
      revision: number;
      publishedVersionId: string | null;
      createdAt: string;
      updatedAt: string;
    }>(
      sql`UPDATE templates 
          SET name = ${name}
          WHERE id = ${templateId} AND store_id = ${storeId} AND tenant_id = ${tenantId}
            AND kind IN (${sql.raw(PAGE_KINDS.map((k) => `'${k}'`).join(', '))})
          RETURNING id, kind, name, status, is_default as "isDefault", revision, 
                    published_version_id as "publishedVersionId", 
                    created_at as "createdAt", updated_at as "updatedAt"`,
    );

    if (!rows[0]) {
      throw new TemplateNotFoundError(`Template not found: ${templateId}`);
    }
    return rows[0];
  }

  /**
   * Archives a template (D7, D39, AC-LIFE-004). Clears isDefault atomically.
   */
  async archiveTemplate(
    tx: DbTx,
    tenantId: string,
    storeId: string,
    templateId: string,
  ) {
    // Store lock then template lock (D50)
    await lockStore(tx, tenantId, storeId);
    await lockTemplates(tx, [templateId]);

    const targetRows = await tx.execute<{
      id: string;
      kind: string;
      name: string;
      status: string;
      isDefault: boolean;
      revision: number;
      publishedVersionId: string | null;
      createdAt: string;
      updatedAt: string;
    }>(
      sql`SELECT id, kind, name, status, is_default as "isDefault", revision, 
                 published_version_id as "publishedVersionId", 
                 created_at as "createdAt", updated_at as "updatedAt"
          FROM templates 
          WHERE id = ${templateId} AND store_id = ${storeId} AND tenant_id = ${tenantId}
            AND kind IN (${sql.raw(PAGE_KINDS.map((k) => `'${k}'`).join(', '))})`,
    );
    if (!targetRows[0]) {
      throw new TemplateNotFoundError(`Template not found: ${templateId}`);
    }

    const current = targetRows[0];
    if (current.status === 'archived') {
      // No-op idempotency: return unchanged without modifying updated_at (D39)
      return current;
    }

    // Check archived quota (D13)
    const countRes = await tx.execute<{ count: number }>(
      sql`SELECT count(*)::int as count FROM templates 
          WHERE store_id = ${storeId} AND tenant_id = ${tenantId} 
            AND status = 'archived' AND kind IN (${sql.raw(PAGE_KINDS.map((k) => `'${k}'`).join(', '))})`,
    );
    if ((countRes[0]?.count ?? 0) >= LIMITS.maxArchivedTemplatesPerStore) {
      throw new TemplateConflictError(
        `Archived templates quota exceeded (${LIMITS.maxArchivedTemplatesPerStore})`,
        'quota_exceeded',
      );
    }

    const updatedRows = await tx.execute<{
      id: string;
      kind: string;
      name: string;
      status: string;
      isDefault: boolean;
      revision: number;
      publishedVersionId: string | null;
      createdAt: string;
      updatedAt: string;
    }>(
      sql`UPDATE templates 
          SET status = 'archived', is_default = false
          WHERE id = ${templateId}
          RETURNING id, kind, name, status, is_default as "isDefault", revision, 
                    published_version_id as "publishedVersionId", 
                    created_at as "createdAt", updated_at as "updatedAt"`,
    );

    return updatedRows[0];
  }

  /**
   * Restores an archived template (D7, D39, AC-LIFE-004). Never sets isDefault.
   */
  async restoreTemplate(
    tx: DbTx,
    tenantId: string,
    storeId: string,
    templateId: string,
  ) {
    await lockStore(tx, tenantId, storeId);
    await lockTemplates(tx, [templateId]);

    const targetRows = await tx.execute<{
      id: string;
      kind: string;
      name: string;
      status: string;
      isDefault: boolean;
      revision: number;
      publishedVersionId: string | null;
      createdAt: string;
      updatedAt: string;
    }>(
      sql`SELECT id, kind, name, status, is_default as "isDefault", revision, 
                 published_version_id as "publishedVersionId", 
                 created_at as "createdAt", updated_at as "updatedAt"
          FROM templates 
          WHERE id = ${templateId} AND store_id = ${storeId} AND tenant_id = ${tenantId}
            AND kind IN (${sql.raw(PAGE_KINDS.map((k) => `'${k}'`).join(', '))})`,
    );
    if (!targetRows[0]) {
      throw new TemplateNotFoundError(`Template not found: ${templateId}`);
    }

    const current = targetRows[0];
    if (current.status === 'active') {
      // No-op idempotency (D39)
      return current;
    }

    // Active quota check
    const countRes = await tx.execute<{ count: number }>(
      sql`SELECT count(*)::int as count FROM templates 
          WHERE store_id = ${storeId} AND tenant_id = ${tenantId} 
            AND status = 'active' AND kind IN (${sql.raw(PAGE_KINDS.map((k) => `'${k}'`).join(', '))})`,
    );
    if ((countRes[0]?.count ?? 0) >= LIMITS.maxActiveTemplatesPerStore) {
      throw new TemplateConflictError(
        `Active templates quota exceeded (${LIMITS.maxActiveTemplatesPerStore})`,
        'quota_exceeded',
      );
    }

    const updatedRows = await tx.execute<{
      id: string;
      kind: string;
      name: string;
      status: string;
      isDefault: boolean;
      revision: number;
      publishedVersionId: string | null;
      createdAt: string;
      updatedAt: string;
    }>(
      sql`UPDATE templates 
          SET status = 'active'
          WHERE id = ${templateId}
          RETURNING id, kind, name, status, is_default as "isDefault", revision, 
                    published_version_id as "publishedVersionId", 
                    created_at as "createdAt", updated_at as "updatedAt"`,
    );

    return updatedRows[0];
  }

  /**
   * Deletes a template safely (D12, AC-LIFE-020). Permitted only when never published and not assigned.
   */
  async deleteTemplate(
    tx: DbTx,
    tenantId: string,
    storeId: string,
    templateId: string,
  ): Promise<void> {
    await lockTemplates(tx, [templateId]);

    const targetRows = await tx.execute<{ id: string }>(
      sql`SELECT id FROM templates 
          WHERE id = ${templateId} AND store_id = ${storeId} AND tenant_id = ${tenantId}
            AND kind IN (${sql.raw(PAGE_KINDS.map((k) => `'${k}'`).join(', '))})`,
    );
    if (!targetRows[0]) {
      throw new TemplateNotFoundError(`Template not found: ${templateId}`);
    }

    // Check version history (never published requirement)
    const verCount = await tx.execute<{ count: number }>(
      sql`SELECT count(*)::int as count FROM template_versions WHERE template_id = ${templateId}`,
    );
    if ((verCount[0]?.count ?? 0) > 0) {
      throw new TemplateConflictError(
        'Cannot delete template: template has historical versions',
        'published',
      );
    }

    // Check active assignments
    const assignCount = await tx.execute<{ count: number }>(
      sql`SELECT count(*)::int as count FROM template_assignments WHERE template_id = ${templateId}`,
    );
    if ((assignCount[0]?.count ?? 0) > 0) {
      throw new TemplateConflictError(
        'Cannot delete template: template is assigned to resources',
        'assigned',
      );
    }

    const delRes = await tx.execute(
      sql`DELETE FROM templates WHERE id = ${templateId} AND store_id = ${storeId} AND tenant_id = ${tenantId}`,
    );
    // Explicit 0-row check (D12)
    if (!delRes) {
      throw new TemplateNotFoundError(`Template not found: ${templateId}`);
    }
  }

  /**
   * Sets default template atomically for a given kind (D7, D11, AC-LIFE-011).
   */
  async setDefaultTemplate(
    tx: DbTx,
    tenantId: string,
    storeId: string,
    templateId: string,
  ) {
    await lockStore(tx, tenantId, storeId);

    const targetRows = await tx.execute<{
      id: string;
      kind: string;
      name: string;
      status: string;
      isDefault: boolean;
      revision: number;
      publishedVersionId: string | null;
      createdAt: string;
      updatedAt: string;
    }>(
      sql`SELECT id, kind, name, status, is_default as "isDefault", revision, 
                 published_version_id as "publishedVersionId", 
                 created_at as "createdAt", updated_at as "updatedAt"
          FROM templates 
          WHERE id = ${templateId} AND store_id = ${storeId} AND tenant_id = ${tenantId}
            AND kind IN (${sql.raw(PAGE_KINDS.map((k) => `'${k}'`).join(', '))})`,
    );
    if (!targetRows[0]) {
      throw new TemplateNotFoundError(`Template not found: ${templateId}`);
    }

    const target = targetRows[0];
    if (target.status === 'archived') {
      throw new TemplateConflictError(
        'Cannot set archived template as default',
        'archived',
      );
    }

    if (target.isDefault) {
      // No-op if already default
      return target;
    }

    // Find current default to lock both in ascending order
    const oldDefaultRows = await tx.execute<{ id: string }>(
      sql`SELECT id FROM templates 
          WHERE store_id = ${storeId} AND tenant_id = ${tenantId} AND kind = ${target.kind} AND is_default = true`,
    );
    const idsToLock = oldDefaultRows[0]
      ? [oldDefaultRows[0].id, templateId]
      : [templateId];
    await lockTemplates(tx, idsToLock);

    // Atomically clear old default then set new
    await tx.execute(
      sql`UPDATE templates 
          SET is_default = false
          WHERE store_id = ${storeId} AND tenant_id = ${tenantId} AND kind = ${target.kind} AND is_default = true`,
    );

    const updatedRows = await tx.execute<{
      id: string;
      kind: string;
      name: string;
      status: string;
      isDefault: boolean;
      revision: number;
      publishedVersionId: string | null;
      createdAt: string;
      updatedAt: string;
    }>(
      sql`UPDATE templates 
          SET is_default = true
          WHERE id = ${templateId}
          RETURNING id, kind, name, status, is_default as "isDefault", revision, 
                    published_version_id as "publishedVersionId", 
                    created_at as "createdAt", updated_at as "updatedAt"`,
    );

    return updatedRows[0];
  }
}
