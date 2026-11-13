import { Injectable } from '@nestjs/common';
import { sql } from 'drizzle-orm';
import type { DbTx } from '../../../infrastructure/database/database.types.js';
import {
  SHARED_KINDS,
  type TemplateDocument,
  type TemplateKind,
} from '../../../infrastructure/database/template-deps/document.js';
import { migrateDocument } from '../../../infrastructure/templates-engine/engine/migrate.js';
import { validateDocument } from '../../../infrastructure/templates-engine/engine/validate.js';
import { getRegistry } from '../../../infrastructure/templates-engine/registry/index.js';
import { collectImagePaths } from '../support/image-paths.js';
import { lockTemplates } from '../support/lock-order.js';
import {
  TemplateConflictError,
  TemplateMissingAssetError,
  TemplateNotFoundError,
  TemplateValidationError,
} from '../support/template-errors.js';
import {
  assertVersionQuota,
  getTemplateRow,
  TEMPLATE_SELECT_COLUMNS,
  type TemplateRow,
  type VersionRow,
} from '../support/template-queries.js';

@Injectable()
export class TemplatePublishService {
  private readonly registry = getRegistry();

  /**
   * Saves a mutable draft with optimistic concurrency check (D24, AC-LIFE-005).
   */
  async saveDraft(
    tx: DbTx,
    tenantId: string,
    storeId: string,
    templateId: string,
    expectedRevision: number,
    newDoc: TemplateDocument,
  ): Promise<{ outcome: 'saved' | 'unchanged'; template: TemplateRow }> {
    await lockTemplates(tx, [templateId]);

    const targetRows = await tx.execute<{
      id: string;
      kind: TemplateKind;
      status: string;
      draft: TemplateDocument;
      revision: number;
    }>(
      sql`SELECT id, kind, status, draft, revision FROM templates 
          WHERE id = ${templateId} AND store_id = ${storeId} AND tenant_id = ${tenantId}`,
    );
    if (!targetRows[0]) {
      throw new TemplateNotFoundError(`Template not found: ${templateId}`);
    }
    const current = targetRows[0];

    if (current.status === 'archived') {
      throw new TemplateConflictError(
        'Cannot save draft for archived template',
        'archived',
      );
    }
    if (current.revision !== expectedRevision) {
      throw new TemplateConflictError('Revision conflict', 'stale_revision', {
        currentRevision: current.revision,
      });
    }

    if (JSON.stringify(current.draft) === JSON.stringify(newDoc)) {
      const fullRow = await getTemplateRow(tx, templateId);
      return { outcome: 'unchanged', template: fullRow! };
    }

    const migrated = migrateDocument(current.kind, newDoc);
    const validation = validateDocument(current.kind, migrated, this.registry, {
      tenantId,
    });
    if (!validation.ok) {
      throw new TemplateValidationError(
        'Invalid template document',
        validation.issues,
      );
    }

    const updatedRows = await tx.execute<TemplateRow>(
      sql`UPDATE templates 
          SET draft = ${sql.raw(`'${JSON.stringify(migrated)}'::jsonb`)}
          WHERE id = ${templateId}
          RETURNING ${TEMPLATE_SELECT_COLUMNS}`,
    );

    return { outcome: 'saved', template: updatedRows[0] };
  }

  /**
   * Two-phase publishing pipeline (D8, D25, AC-LIFE-006, AC-LIFE-007).
   */
  async publish(
    tx: DbTx,
    tenantId: string,
    storeId: string,
    templateId: string,
    expectedRevision: number,
    imageChecker?: (paths: string[]) => Promise<string[]>,
  ): Promise<{
    outcome: 'published' | 'unchanged';
    version: VersionRow | null;
    template: TemplateRow;
  }> {
    const initialRows = await tx.execute<{
      id: string;
      kind: TemplateKind;
      status: string;
      draft: TemplateDocument;
      revision: number;
      publishedVersionId: string | null;
    }>(
      sql`SELECT id, kind, status, draft, revision, published_version_id as "publishedVersionId"
          FROM templates 
          WHERE id = ${templateId} AND store_id = ${storeId} AND tenant_id = ${tenantId}`,
    );
    if (!initialRows[0]) {
      throw new TemplateNotFoundError(`Template not found: ${templateId}`);
    }
    const target = initialRows[0];

    if (target.status === 'archived') {
      throw new TemplateConflictError(
        'Cannot publish archived template',
        'archived',
      );
    }
    if (target.revision !== expectedRevision) {
      throw new TemplateConflictError('Revision conflict', 'stale_revision', {
        currentRevision: target.revision,
      });
    }

    const migrated = migrateDocument(target.kind, target.draft);
    const validation = validateDocument(target.kind, migrated, this.registry, {
      tenantId,
    });
    if (!validation.ok) {
      throw new TemplateValidationError(
        'Document failed validation before publishing',
        validation.issues,
      );
    }

    const imagePaths = collectImagePaths(migrated);
    if (imageChecker && imagePaths.length > 0) {
      const missing = await imageChecker(imagePaths);
      if (missing.length > 0) {
        throw new TemplateMissingAssetError(
          'Referenced images do not exist in storage',
          missing,
        );
      }
    }

    await lockTemplates(tx, [templateId]);
    const lockedRows = await tx.execute<{
      revision: number;
      publishedVersionId: string | null;
    }>(
      sql`SELECT revision, published_version_id as "publishedVersionId" FROM templates WHERE id = ${templateId} FOR UPDATE`,
    );
    const locked = lockedRows[0];

    if (locked.revision !== expectedRevision) {
      throw new TemplateConflictError(
        'Revision changed during publishing pipeline',
        'stale_revision',
        { currentRevision: locked.revision },
      );
    }

    if (locked.publishedVersionId) {
      const pubVersion = await tx.execute<{ document: TemplateDocument }>(
        sql`SELECT document FROM template_versions WHERE id = ${locked.publishedVersionId}`,
      );
      if (
        pubVersion[0] &&
        JSON.stringify(pubVersion[0].document) === JSON.stringify(migrated)
      ) {
        const fullTemplate = await getTemplateRow(tx, templateId);
        return {
          outcome: 'unchanged',
          version: null,
          template: fullTemplate!,
        };
      }
    }

    await assertVersionQuota(tx, templateId);

    const newVersionRows = await tx.execute<VersionRow>(
      sql`INSERT INTO template_versions (tenant_id, store_id, template_id, document, source)
          VALUES (${tenantId}, ${storeId}, ${templateId}, ${sql.raw(`'${JSON.stringify(migrated)}'::jsonb`)}, 'publish')
          RETURNING id, template_id as "templateId", version_number as "versionNumber",
                    document, source, rolled_back_from as "rolledBackFrom", label,
                    published_at as "publishedAt", published_by as "publishedBy"`,
    );
    const version = newVersionRows[0];

    const updatedTemplateRows = await tx.execute<TemplateRow>(
      sql`UPDATE templates 
          SET published_version_id = ${version.id}
          WHERE id = ${templateId}
          RETURNING ${TEMPLATE_SELECT_COLUMNS}`,
    );

    return { outcome: 'published', version, template: updatedTemplateRows[0] };
  }

  /**
   * Unpublishes a template by nulling its published pointer (D35, AC-LIFE-008).
   */
  async unpublish(
    tx: DbTx,
    tenantId: string,
    storeId: string,
    templateId: string,
  ): Promise<TemplateRow> {
    await lockTemplates(tx, [templateId]);

    const targetRows = await tx.execute<{
      id: string;
      status: string;
      publishedVersionId: string | null;
    }>(
      sql`SELECT id, status, published_version_id as "publishedVersionId" FROM templates 
          WHERE id = ${templateId} AND store_id = ${storeId} AND tenant_id = ${tenantId}`,
    );
    if (!targetRows[0]) {
      throw new TemplateNotFoundError(`Template not found: ${templateId}`);
    }
    const current = targetRows[0];

    if (current.status === 'archived') {
      throw new TemplateConflictError(
        'Cannot unpublish archived template',
        'archived',
      );
    }
    if (current.publishedVersionId === null) {
      const fullTemplate = await getTemplateRow(tx, templateId);
      return fullTemplate!;
    }

    const updatedRows = await tx.execute<TemplateRow>(
      sql`UPDATE templates 
          SET published_version_id = null
          WHERE id = ${templateId}
          RETURNING ${TEMPLATE_SELECT_COLUMNS}`,
    );

    return updatedRows[0];
  }

  /**
   * Rollback creates a new immutable version pointing to an earlier version (D9, D10, D28, AC-LIFE-009).
   */
  async rollback(
    tx: DbTx,
    tenantId: string,
    storeId: string,
    templateId: string,
    versionId: string,
    imageChecker?: (paths: string[]) => Promise<string[]>,
  ): Promise<{
    outcome: 'rolled_back' | 'unchanged';
    version: VersionRow | null;
    template: TemplateRow;
  }> {
    const targetVersion = await tx.execute<{
      id: string;
      versionNumber: number;
      document: TemplateDocument;
    }>(
      sql`SELECT id, version_number as "versionNumber", document FROM template_versions
          WHERE id = ${versionId} AND template_id = ${templateId} 
            AND store_id = ${storeId} AND tenant_id = ${tenantId}`,
    );
    if (!targetVersion[0]) {
      throw new TemplateNotFoundError(`Source version not found: ${versionId}`);
    }

    const templateRows = await tx.execute<{
      id: string;
      kind: TemplateKind;
      status: string;
      publishedVersionId: string | null;
    }>(
      sql`SELECT id, kind, status, published_version_id as "publishedVersionId"
          FROM templates WHERE id = ${templateId} AND store_id = ${storeId} AND tenant_id = ${tenantId}`,
    );
    if (!templateRows[0]) {
      throw new TemplateNotFoundError(`Template not found: ${templateId}`);
    }
    const currentTemplate = templateRows[0];

    if (currentTemplate.status === 'archived') {
      throw new TemplateConflictError(
        'Cannot rollback archived template',
        'archived',
      );
    }

    const migrated = migrateDocument(
      currentTemplate.kind,
      targetVersion[0].document,
    );
    const validation = validateDocument(
      currentTemplate.kind,
      migrated,
      this.registry,
      { tenantId },
    );
    if (!validation.ok) {
      throw new TemplateValidationError(
        'Target version document is invalid',
        validation.issues,
      );
    }

    const imagePaths = collectImagePaths(migrated);
    if (imageChecker && imagePaths.length > 0) {
      const missing = await imageChecker(imagePaths);
      if (missing.length > 0) {
        throw new TemplateMissingAssetError(
          'Target version contains missing images',
          missing,
        );
      }
    }

    await lockTemplates(tx, [templateId]);

    if (currentTemplate.publishedVersionId) {
      const liveVer = await tx.execute<{ document: TemplateDocument }>(
        sql`SELECT document FROM template_versions WHERE id = ${currentTemplate.publishedVersionId}`,
      );
      if (
        liveVer[0] &&
        JSON.stringify(liveVer[0].document) === JSON.stringify(migrated)
      ) {
        const fullTemplate = await getTemplateRow(tx, templateId);
        return {
          outcome: 'unchanged',
          version: null,
          template: fullTemplate!,
        };
      }
    }

    await assertVersionQuota(tx, templateId);

    const newVersionRows = await tx.execute<VersionRow>(
      sql`INSERT INTO template_versions (tenant_id, store_id, template_id, document, source, rolled_back_from)
          VALUES (${tenantId}, ${storeId}, ${templateId}, ${sql.raw(`'${JSON.stringify(migrated)}'::jsonb`)}, 'rollback', ${versionId})
          RETURNING id, template_id as "templateId", version_number as "versionNumber",
                    document, source, rolled_back_from as "rolledBackFrom", label,
                    published_at as "publishedAt", published_by as "publishedBy"`,
    );
    const newVersion = newVersionRows[0];

    const updatedTemplateRows = await tx.execute<TemplateRow>(
      sql`UPDATE templates 
          SET published_version_id = ${newVersion.id}
          WHERE id = ${templateId}
          RETURNING ${TEMPLATE_SELECT_COLUMNS}`,
    );

    return {
      outcome: 'rolled_back',
      version: newVersion,
      template: updatedTemplateRows[0],
    };
  }

  /**
   * Restores a historical version into the mutable draft (D10, AC-LIFE-010).
   */
  async restoreVersion(
    tx: DbTx,
    tenantId: string,
    storeId: string,
    templateId: string,
    versionId: string,
    expectedRevision: number,
  ): Promise<{ outcome: 'restored' | 'unchanged'; template: TemplateRow }> {
    await lockTemplates(tx, [templateId]);

    const targetVersion = await tx.execute<{ document: TemplateDocument }>(
      sql`SELECT document FROM template_versions
          WHERE id = ${versionId} AND template_id = ${templateId} 
            AND store_id = ${storeId} AND tenant_id = ${tenantId}`,
    );
    if (!targetVersion[0]) {
      throw new TemplateNotFoundError(`Version not found: ${versionId}`);
    }

    const templateRows = await tx.execute<{
      id: string;
      kind: TemplateKind;
      status: string;
      revision: number;
      draft: TemplateDocument;
    }>(
      sql`SELECT id, kind, status, revision, draft FROM templates
          WHERE id = ${templateId} AND store_id = ${storeId} AND tenant_id = ${tenantId}`,
    );
    if (!templateRows[0]) {
      throw new TemplateNotFoundError(`Template not found: ${templateId}`);
    }
    const currentTemplate = templateRows[0];

    if (currentTemplate.status === 'archived') {
      throw new TemplateConflictError(
        'Cannot restore version on archived template',
        'archived',
      );
    }
    if (currentTemplate.revision !== expectedRevision) {
      throw new TemplateConflictError('Revision conflict', 'stale_revision', {
        currentRevision: currentTemplate.revision,
      });
    }

    const migrated = migrateDocument(
      currentTemplate.kind,
      targetVersion[0].document,
    );
    const validation = validateDocument(
      currentTemplate.kind,
      migrated,
      this.registry,
      { tenantId },
    );
    if (!validation.ok) {
      throw new TemplateValidationError(
        'Target version document is invalid',
        validation.issues,
      );
    }

    if (JSON.stringify(currentTemplate.draft) === JSON.stringify(migrated)) {
      const fullTemplate = await getTemplateRow(tx, templateId);
      return { outcome: 'unchanged', template: fullTemplate! };
    }

    const updatedTemplateRows = await tx.execute<TemplateRow>(
      sql`UPDATE templates 
          SET draft = ${sql.raw(`'${JSON.stringify(migrated)}'::jsonb`)}
          WHERE id = ${templateId}
          RETURNING ${TEMPLATE_SELECT_COLUMNS}`,
    );

    return { outcome: 'restored', template: updatedTemplateRows[0] };
  }

  /**
   * Saves a shared document draft (D13, D27, AC-LIFE-021). Lazy create on expectedRevision: 0.
   */
  async saveSharedDraft(
    tx: DbTx,
    tenantId: string,
    storeId: string,
    kind: string,
    expectedRevision: number,
    newDoc: unknown,
  ): Promise<{ outcome: 'saved'; template: TemplateRow }> {
    if (!SHARED_KINDS.includes(kind as (typeof SHARED_KINDS)[number])) {
      throw new TemplateValidationError(
        `Invalid shared document kind: ${kind}`,
      );
    }

    const migrated = migrateDocument(kind as TemplateKind, newDoc);
    const validation = validateDocument(
      kind as TemplateKind,
      migrated,
      this.registry,
      { tenantId },
    );
    if (!validation.ok) {
      throw new TemplateValidationError(
        'Invalid shared template document',
        validation.issues,
      );
    }

    if (expectedRevision === 0) {
      const inserted = await tx.execute<TemplateRow>(
        sql`INSERT INTO templates (tenant_id, store_id, kind, name, is_default, draft)
            VALUES (${tenantId}, ${storeId}, ${kind}, ${kind}, false, ${sql.raw(`'${JSON.stringify(migrated)}'::jsonb`)})
            ON CONFLICT (store_id, kind) WHERE kind IN (${sql.raw(SHARED_KINDS.map((k) => `'${k}'`).join(', '))}) DO NOTHING
            RETURNING ${TEMPLATE_SELECT_COLUMNS}`,
      );

      if (inserted[0]) {
        return { outcome: 'saved', template: inserted[0] };
      }

      const existing = await tx.execute<{ revision: number }>(
        sql`SELECT revision FROM templates WHERE store_id = ${storeId} AND tenant_id = ${tenantId} AND kind = ${kind}`,
      );
      throw new TemplateConflictError(
        'Revision conflict on shared document creation',
        'stale_revision',
        { currentRevision: existing[0]?.revision ?? 1 },
      );
    }

    const existing = await tx.execute<{ id: string }>(
      sql`SELECT id FROM templates WHERE store_id = ${storeId} AND tenant_id = ${tenantId} AND kind = ${kind}`,
    );
    if (!existing[0]) {
      throw new TemplateConflictError(
        'Shared document does not exist yet; expectedRevision must be 0',
        'stale_revision',
        { currentRevision: 0 },
      );
    }

    const res = await this.saveDraft(
      tx,
      tenantId,
      storeId,
      existing[0].id,
      expectedRevision,
      migrated as TemplateDocument,
    );
    return { outcome: 'saved', template: res.template };
  }
}
