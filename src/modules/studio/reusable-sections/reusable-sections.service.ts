import { ConflictException, Injectable } from '@nestjs/common';
import { and, desc, eq, sql } from 'drizzle-orm';
import { invalid, notFound } from '../../../common/app.exception.js';
import type {
  AuthUser,
  OrgContext,
} from '../../../common/interfaces/request-context.js';
import { DatabaseService, rowsOf } from '../../../database/database.service.js';
import {
  reusableSections,
  reusableSectionVersions,
} from '../../../database/schema/studio.js';
import { requireStore } from '../../themes/themes.shared.js';
import type {
  CreateReusableSectionDto,
  RestoreReusableSectionVersionDto,
  UpdateReusableSectionDto,
} from './reusable-sections.dto.js';

@Injectable()
export class ReusableSectionsService {
  constructor(private readonly db: DatabaseService) {}

  /** List all active reusable sections for the store with usage counts. */
  async list(org: OrgContext) {
    return this.db.withUser(org.userId, async (tx) => {
      const store = await requireStore(tx, org);

      const sections = await tx
        .select()
        .from(reusableSections)
        .where(
          and(
            eq(reusableSections.tenantId, org.tenantId),
            eq(reusableSections.storeId, store.id),
            eq(reusableSections.status, 'active'),
          ),
        )
        .orderBy(desc(reusableSections.updatedAt));

      if (sections.length === 0) return [];

      // Calculate usage count for each section by checking template drafts
      const usageCounts = await tx.execute(
        sql`SELECT (elem->>'reusableId')::text as reusable_id, count(distinct t.id) as count
            FROM public.templates t,
                 jsonb_array_elements(
                   CASE WHEN jsonb_typeof(t.draft_document->'sections') = 'array' 
                        THEN t.draft_document->'sections' 
                        ELSE '[]'::jsonb END
                 ) as elem
            WHERE t.tenant_id = ${org.tenantId} AND t.store_id = ${store.id} AND t.status <> 'archived'
              AND elem->>'reusableId' IS NOT NULL
            GROUP BY elem->>'reusableId'`,
      );

      const usageMap = new Map<string, number>();
      for (const row of rowsOf<{ reusable_id: string; count: string | number }>(
        usageCounts,
      )) {
        usageMap.set(row.reusable_id, Number(row.count));
      }

      // Fetch current versions
      const currentVersionIds = sections
        .map((s) => s.currentVersionId)
        .filter((id): id is string => Boolean(id));

      const versions =
        currentVersionIds.length > 0
          ? await tx
              .select()
              .from(reusableSectionVersions)
              .where(
                sql`${reusableSectionVersions.id} = ANY(${currentVersionIds}::uuid[])`,
              )
          : [];

      const versionMap = new Map(versions.map((v) => [v.id, v]));

      return sections.map((s) => {
        const cur = s.currentVersionId
          ? versionMap.get(s.currentVersionId)
          : null;
        return {
          id: s.id,
          componentId: s.componentId,
          name: s.name,
          description: s.description,
          currentVersionNumber: cur?.versionNumber ?? 1,
          content: cur?.content ?? {},
          usageCount: usageMap.get(s.id) ?? 0,
          createdAt: s.createdAt,
          updatedAt: s.updatedAt,
        };
      });
    });
  }

  /** Create a reusable section with version 1. */
  async create(org: OrgContext, user: AuthUser, dto: CreateReusableSectionDto) {
    return this.db.withUser(user.id, async (tx) => {
      const store = await requireStore(tx, org);

      const [sec] = await tx
        .insert(reusableSections)
        .values({
          tenantId: org.tenantId,
          storeId: store.id,
          componentId: dto.componentId,
          name: dto.name,
          description: dto.description ?? null,
          createdBy: user.id,
        })
        .returning();

      const [ver] = await tx
        .insert(reusableSectionVersions)
        .values({
          reusableId: sec.id,
          versionNumber: 1,
          content: dto.content,
          createdBy: user.id,
        })
        .returning();

      await tx
        .update(reusableSections)
        .set({ currentVersionId: ver.id, updatedAt: new Date() })
        .where(eq(reusableSections.id, sec.id));

      return {
        id: sec.id,
        componentId: sec.componentId,
        name: sec.name,
        description: sec.description,
        currentVersionNumber: 1,
        content: ver.content,
        usageCount: 0,
        createdAt: sec.createdAt,
        updatedAt: sec.createdAt,
      };
    });
  }

  /** Get a single reusable section with its current version. */
  async get(org: OrgContext, id: string) {
    return this.db.withUser(org.userId, async (tx) => {
      const store = await requireStore(tx, org);

      const [sec] = await tx
        .select()
        .from(reusableSections)
        .where(
          and(
            eq(reusableSections.tenantId, org.tenantId),
            eq(reusableSections.storeId, store.id),
            eq(reusableSections.id, id),
            eq(reusableSections.status, 'active'),
          ),
        );

      if (!sec) {
        throw notFound(
          'Reusable section not found.',
          'REUSABLE_SECTION_NOT_FOUND',
        );
      }

      let cur = null;
      if (sec.currentVersionId) {
        const [v] = await tx
          .select()
          .from(reusableSectionVersions)
          .where(eq(reusableSectionVersions.id, sec.currentVersionId));
        cur = v;
      }

      return {
        id: sec.id,
        componentId: sec.componentId,
        name: sec.name,
        description: sec.description,
        currentVersionNumber: cur?.versionNumber ?? 1,
        content: cur?.content ?? {},
        createdAt: sec.createdAt,
        updatedAt: sec.updatedAt,
      };
    });
  }

  /** Update a reusable section (creates a new immutable version if content is provided). */
  async update(
    org: OrgContext,
    user: AuthUser,
    id: string,
    dto: UpdateReusableSectionDto,
  ) {
    return this.db.withUser(user.id, async (tx) => {
      const store = await requireStore(tx, org);

      const [sec] = await tx
        .select()
        .from(reusableSections)
        .where(
          and(
            eq(reusableSections.tenantId, org.tenantId),
            eq(reusableSections.storeId, store.id),
            eq(reusableSections.id, id),
            eq(reusableSections.status, 'active'),
          ),
        );

      if (!sec) {
        throw notFound(
          'Reusable section not found.',
          'REUSABLE_SECTION_NOT_FOUND',
        );
      }

      let newVersionId = sec.currentVersionId;

      if (dto.content) {
        // Find latest version number
        const latest = await tx
          .select({ versionNumber: reusableSectionVersions.versionNumber })
          .from(reusableSectionVersions)
          .where(eq(reusableSectionVersions.reusableId, id))
          .orderBy(desc(reusableSectionVersions.versionNumber))
          .limit(1);

        const nextVersion = (latest[0]?.versionNumber ?? 0) + 1;

        const [ver] = await tx
          .insert(reusableSectionVersions)
          .values({
            reusableId: id,
            versionNumber: nextVersion,
            content: dto.content,
            createdBy: user.id,
          })
          .returning();

        newVersionId = ver.id;
      }

      await tx
        .update(reusableSections)
        .set({
          name: dto.name ?? sec.name,
          description:
            dto.description !== undefined ? dto.description : sec.description,
          currentVersionId: newVersionId,
          updatedAt: new Date(),
        })
        .where(eq(reusableSections.id, id));

      return this.get(org, id);
    });
  }

  /** List all versions of a reusable section. */
  async getVersions(org: OrgContext, id: string) {
    return this.db.withUser(org.userId, async (tx) => {
      const store = await requireStore(tx, org);

      const [sec] = await tx
        .select()
        .from(reusableSections)
        .where(
          and(
            eq(reusableSections.tenantId, org.tenantId),
            eq(reusableSections.storeId, store.id),
            eq(reusableSections.id, id),
          ),
        );

      if (!sec) {
        throw notFound(
          'Reusable section not found.',
          'REUSABLE_SECTION_NOT_FOUND',
        );
      }

      return tx
        .select()
        .from(reusableSectionVersions)
        .where(eq(reusableSectionVersions.reusableId, id))
        .orderBy(desc(reusableSectionVersions.versionNumber));
    });
  }

  /** Restore an earlier version as a new version. */
  async restoreVersion(
    org: OrgContext,
    user: AuthUser,
    id: string,
    dto: RestoreReusableSectionVersionDto,
  ) {
    return this.db.withUser(user.id, async (tx) => {
      const store = await requireStore(tx, org);

      const [sec] = await tx
        .select()
        .from(reusableSections)
        .where(
          and(
            eq(reusableSections.tenantId, org.tenantId),
            eq(reusableSections.storeId, store.id),
            eq(reusableSections.id, id),
            eq(reusableSections.status, 'active'),
          ),
        );

      if (!sec) {
        throw notFound(
          'Reusable section not found.',
          'REUSABLE_SECTION_NOT_FOUND',
        );
      }

      const [target] = await tx
        .select()
        .from(reusableSectionVersions)
        .where(
          and(
            eq(reusableSectionVersions.reusableId, id),
            eq(reusableSectionVersions.versionNumber, dto.versionNumber),
          ),
        );

      if (!target) {
        throw notFound('Target version not found.', 'VERSION_NOT_FOUND');
      }

      // Get latest version number
      const latest = await tx
        .select({ versionNumber: reusableSectionVersions.versionNumber })
        .from(reusableSectionVersions)
        .where(eq(reusableSectionVersions.reusableId, id))
        .orderBy(desc(reusableSectionVersions.versionNumber))
        .limit(1);

      const nextVersion = (latest[0]?.versionNumber ?? 0) + 1;

      const [newVer] = await tx
        .insert(reusableSectionVersions)
        .values({
          reusableId: id,
          versionNumber: nextVersion,
          content: target.content,
          createdBy: user.id,
        })
        .returning();

      await tx
        .update(reusableSections)
        .set({ currentVersionId: newVer.id, updatedAt: new Date() })
        .where(eq(reusableSections.id, id));

      return this.get(org, id);
    });
  }

  /** Delete a reusable section. Refuses if currently used in any active/draft template (409 Conflict). */
  async delete(org: OrgContext, id: string) {
    return this.db.withUser(org.userId, async (tx) => {
      const store = await requireStore(tx, org);

      // Check usage in template drafts
      const inUseRows = rowsOf<{ count: string | number }>(
        await tx.execute(
          sql`SELECT count(*) as count
              FROM public.templates t,
                   jsonb_array_elements(
                     CASE WHEN jsonb_typeof(t.draft_document->'sections') = 'array' 
                          THEN t.draft_document->'sections' 
                          ELSE '[]'::jsonb END
                   ) as elem
              WHERE t.tenant_id = ${org.tenantId} AND t.store_id = ${store.id} AND t.status <> 'archived'
                AND elem->>'reusableId' = ${id}`,
        ),
      );

      const inUseCount = Number(inUseRows[0]?.count ?? 0);
      if (inUseCount > 0) {
        throw new ConflictException({
          statusCode: 409,
          error: 'CONFLICT',
          message: `Cannot delete reusable section: it is currently used by ${inUseCount} template(s). Remove it from all pages first.`,
        });
      }

      await tx
        .update(reusableSections)
        .set({ status: 'archived', updatedAt: new Date() })
        .where(
          and(
            eq(reusableSections.tenantId, org.tenantId),
            eq(reusableSections.storeId, store.id),
            eq(reusableSections.id, id),
          ),
        );

      return { success: true };
    });
  }
}
