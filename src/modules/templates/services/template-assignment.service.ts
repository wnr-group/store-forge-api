import { Injectable } from '@nestjs/common';
import { sql } from 'drizzle-orm';
import type { DbTx } from '../../../infrastructure/database/database.types.js';
import { lockSharedTemplates } from '../support/lock-order.js';
import {
  TemplateConflictError,
  TemplateValidationError,
} from '../support/template-errors.js';

export const ASSIGNMENT_BATCH_MAX = 100;

export interface AssignmentItemDto {
  resourceType: 'product' | 'collection';
  resourceId: string;
  templateId: string;
}

export interface AssignmentResultItem {
  resourceType: 'product' | 'collection';
  resourceId: string;
  templateId: string;
  outcome: 'created' | 'replaced' | 'unchanged';
}

export interface UnassignItemDto {
  resourceType: 'product' | 'collection';
  resourceId: string;
}

export interface UnassignResultItem {
  resourceType: 'product' | 'collection';
  resourceId: string;
  outcome: 'removed' | 'absent';
}

@Injectable()
export class TemplateAssignmentService {
  /**
   * Assigns or replaces templates for catalog resources (D14, D15, D16, AC-LIFE-012).
   */
  async assign(
    tx: DbTx,
    tenantId: string,
    storeId: string,
    assignments: AssignmentItemDto[],
  ): Promise<{ results: AssignmentResultItem[] }> {
    if (assignments.length === 0) {
      return { results: [] };
    }
    if (assignments.length > ASSIGNMENT_BATCH_MAX) {
      throw new TemplateValidationError(
        `Assignment batch size cannot exceed ${ASSIGNMENT_BATCH_MAX} items`,
      );
    }

    // Check for duplicate resources in the same batch
    const seenResources = new Set<string>();
    for (const a of assignments) {
      const key = `${a.resourceType}:${a.resourceId}`;
      if (seenResources.has(key)) {
        throw new TemplateValidationError(
          `Duplicate resource in assignment batch: ${a.resourceType} ${a.resourceId}`,
        );
      }
      seenResources.add(key);
    }

    // Lock target templates FOR SHARE (D50 rule 3)
    const distinctTemplateIds = [
      ...new Set(assignments.map((a) => a.templateId)),
    ];
    await lockSharedTemplates(tx, distinctTemplateIds);

    // Verify target templates (must be active, matching kind, same store and tenant)
    const tplParams = sql.join(
      distinctTemplateIds.map((id) => sql`${id}`),
      sql`, `,
    );
    const templates = await tx.execute<{
      id: string;
      kind: string;
      status: string;
      storeId: string;
      tenantId: string;
    }>(
      sql`SELECT id, kind, status, store_id as "storeId", tenant_id as "tenantId" 
          FROM templates WHERE id IN (${tplParams})`,
    );
    const templateMap = new Map(templates.map((t) => [t.id, t]));

    for (const a of assignments) {
      const t = templateMap.get(a.templateId);
      if (!t || t.storeId !== storeId || t.tenantId !== tenantId) {
        throw new TemplateValidationError(
          `Template ${a.templateId} not found in this store`,
        );
      }
      if (t.status === 'archived') {
        throw new TemplateConflictError(
          `Cannot assign archived template ${a.templateId}`,
          'archived',
        );
      }
      if (t.kind !== a.resourceType) {
        throw new TemplateValidationError(
          `Template kind "${t.kind}" is incompatible with resource type "${a.resourceType}"`,
        );
      }
    }

    // Verify resource existence (tenant-wide, catalog entities)
    const productIds = assignments
      .filter((a) => a.resourceType === 'product')
      .map((a) => a.resourceId);
    const collectionIds = assignments
      .filter((a) => a.resourceType === 'collection')
      .map((a) => a.resourceId);

    if (productIds.length > 0) {
      const prodParams = sql.join(
        productIds.map((id) => sql`${id}`),
        sql`, `,
      );
      const existingProducts = await tx.execute<{ id: string }>(
        sql`SELECT id FROM products WHERE id IN (${prodParams}) AND tenant_id = ${tenantId}`,
      );
      const prodSet = new Set(existingProducts.map((p) => p.id));
      for (const id of productIds) {
        if (!prodSet.has(id)) {
          throw new TemplateValidationError(
            `Product resource not found: ${id}`,
          );
        }
      }
    }

    if (collectionIds.length > 0) {
      const colParams = sql.join(
        collectionIds.map((id) => sql`${id}`),
        sql`, `,
      );
      const existingCollections = await tx.execute<{ id: string }>(
        sql`SELECT id FROM collections WHERE id IN (${colParams}) AND tenant_id = ${tenantId}`,
      );
      const colSet = new Set(existingCollections.map((c) => c.id));
      for (const id of collectionIds) {
        if (!colSet.has(id)) {
          throw new TemplateValidationError(
            `Collection resource not found: ${id}`,
          );
        }
      }
    }

    // Query existing assignments to determine outcomes (created vs replaced vs unchanged)
    const prodClauses =
      productIds.length > 0
        ? sql`product_id IN (${sql.join(
            productIds.map((id) => sql`${id}`),
            sql`, `,
          )})`
        : sql`false`;
    const colClauses =
      collectionIds.length > 0
        ? sql`collection_id IN (${sql.join(
            collectionIds.map((id) => sql`${id}`),
            sql`, `,
          )})`
        : sql`false`;

    const existingAssignments = await tx.execute<{
      id: string;
      productId: string | null;
      collectionId: string | null;
      templateId: string;
    }>(
      sql`SELECT id, product_id as "productId", collection_id as "collectionId", template_id as "templateId"
          FROM template_assignments 
          WHERE store_id = ${storeId} AND tenant_id = ${tenantId}
            AND (${prodClauses} OR ${colClauses})`,
    );

    const existingMap = new Map<string, string>();
    for (const ea of existingAssignments) {
      if (ea.productId)
        existingMap.set(`product:${ea.productId}`, ea.templateId);
      if (ea.collectionId)
        existingMap.set(`collection:${ea.collectionId}`, ea.templateId);
    }

    const results: AssignmentResultItem[] = [];

    // Perform upsert
    for (const a of assignments) {
      const key = `${a.resourceType}:${a.resourceId}`;
      const prevTemplateId = existingMap.get(key);

      if (prevTemplateId === a.templateId) {
        results.push({ ...a, outcome: 'unchanged' });
        continue;
      }

      if (a.resourceType === 'product') {
        await tx.execute(
          sql`INSERT INTO template_assignments (tenant_id, store_id, template_id, product_id)
              VALUES (${tenantId}, ${storeId}, ${a.templateId}, ${a.resourceId})
              ON CONFLICT (store_id, product_id) DO UPDATE 
              SET template_id = EXCLUDED.template_id`,
        );
      } else {
        await tx.execute(
          sql`INSERT INTO template_assignments (tenant_id, store_id, template_id, collection_id)
              VALUES (${tenantId}, ${storeId}, ${a.templateId}, ${a.resourceId})
              ON CONFLICT (store_id, collection_id) DO UPDATE 
              SET template_id = EXCLUDED.template_id`,
        );
      }

      results.push({
        ...a,
        outcome: prevTemplateId ? 'replaced' : 'created',
      });
    }

    return { results };
  }

  /**
   * Unassigns resources (D16, D32).
   */
  async unassign(
    tx: DbTx,
    tenantId: string,
    storeId: string,
    resources: UnassignItemDto[],
  ): Promise<{ results: UnassignResultItem[] }> {
    if (resources.length === 0) {
      return { results: [] };
    }
    if (resources.length > ASSIGNMENT_BATCH_MAX) {
      throw new TemplateValidationError(
        `Unassign batch size cannot exceed ${ASSIGNMENT_BATCH_MAX} items`,
      );
    }

    const results: UnassignResultItem[] = [];

    for (const r of resources) {
      let delRes;
      if (r.resourceType === 'product') {
        delRes = await tx.execute(
          sql`DELETE FROM template_assignments 
              WHERE store_id = ${storeId} AND tenant_id = ${tenantId} AND product_id = ${r.resourceId}
              RETURNING id`,
        );
      } else {
        delRes = await tx.execute(
          sql`DELETE FROM template_assignments 
              WHERE store_id = ${storeId} AND tenant_id = ${tenantId} AND collection_id = ${r.resourceId}
              RETURNING id`,
        );
      }

      results.push({
        resourceType: r.resourceType,
        resourceId: r.resourceId,
        outcome: delRes && delRes.length > 0 ? 'removed' : 'absent',
      });
    }

    return { results };
  }
}
