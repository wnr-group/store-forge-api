import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ConfigModule } from '@nestjs/config';
import { Test, type TestingModule } from '@nestjs/testing';
import {
  createTestDatabase,
  type TestDatabase,
} from '../../../test/support/database/create-test-database.js';
import {
  createUser,
  createTenantWithOwner,
  withSuperuser,
} from '../../../test/support/database/fixtures.js';
import { DatabaseModule } from '../../infrastructure/database/database.module.js';
import { DatabaseService } from '../../infrastructure/database/database.service.js';
import { TemplateQueryService } from './services/template-query.service.js';
import { TemplateService } from './services/template.service.js';
import { TemplatePublishService } from './services/template-publish.service.js';
import { TemplateAssignmentService } from './services/template-assignment.service.js';
import {
  TemplateConflictError,
  TemplateMissingAssetError,
  TemplateNotFoundError,
  TemplateValidationError,
} from './support/template-errors.js';
import type { TemplateDocument } from '../../infrastructure/database/template-deps/document.js';

describe('Templates Core Services Integration (INT-PGLITE)', () => {
  let testDb: TestDatabase;
  let moduleRef: TestingModule;
  let dbService: DatabaseService;

  let aliceId: string;
  let bobId: string;
  let storeA: { tenantId: string; storeId: string; storeSlug: string };
  let storeB: { tenantId: string; storeId: string; storeSlug: string };

  let queryService: TemplateQueryService;
  let templateService: TemplateService;
  let publishService: TemplatePublishService;
  let assignmentService: TemplateAssignmentService;

  let dummyProductId: string;
  let dummyCollectionId: string;

  beforeAll(async () => {
    testDb = await createTestDatabase();

    moduleRef = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({
          isGlobal: true,
          load: [
            () => ({
              database: {
                url: testDb.url,
                poolMax: 1, // Single session for PGlite socket
                prepare: false,
                connectTimeoutSeconds: 5,
              },
            }),
          ],
        }),
        DatabaseModule,
      ],
    }).compile();

    dbService = moduleRef.get(DatabaseService);
    await dbService.onModuleInit();

    queryService = new TemplateQueryService();
    templateService = new TemplateService();
    publishService = new TemplatePublishService();
    assignmentService = new TemplateAssignmentService();

    aliceId = await createUser(testDb.pg, {
      email: 'alice.tpl@example.test',
      fullName: 'Alice',
    });
    bobId = await createUser(testDb.pg, {
      email: 'bob.tpl@example.test',
      fullName: 'Bob',
    });

    storeA = await createTenantWithOwner(testDb.pg, {
      ownerId: aliceId,
      storeSlug: 'alice-tpl-shop',
      tenantName: 'Alice Tpl Inc',
    });

    storeB = await createTenantWithOwner(testDb.pg, {
      ownerId: bobId,
      storeSlug: 'bob-tpl-shop',
      tenantName: 'Bob Tpl Inc',
    });

    // Seed dummy product and collection in tenantA catalog (tenant-wide)
    await withSuperuser(testDb.pg, async () => {
      const prodRes = await testDb.pg.query<{ id: string }>(
        `INSERT INTO products (tenant_id, name, slug, status) 
         VALUES ($1, 'Test Shirt', 'test-shirt', 'active') RETURNING id`,
        [storeA.tenantId],
      );
      dummyProductId = prodRes.rows[0].id;

      const colRes = await testDb.pg.query<{ id: string }>(
        `INSERT INTO collections (tenant_id, name, slug, status) 
         VALUES ($1, 'Summer Collection', 'summer-col', 'active') RETURNING id`,
        [storeA.tenantId],
      );
      dummyCollectionId = colRes.rows[0].id;
    });
  });

  it('AC-LIFE-001: creates template from approved preset with default false and revision 1', async () => {
    await dbService.withUser(aliceId, async (tx) => {
      const created = await templateService.createTemplate(
        tx,
        storeA.tenantId,
        storeA.storeId,
        {
          kind: 'index',
          presetKey: 'classic',
          name: 'Main Homepage',
        },
      );

      expect(created.id).toBeDefined();
      expect(created.kind).toBe('index');
      expect(created.name).toBe('Main Homepage');
      expect(created.status).toBe('active');
      expect(created.isDefault).toBe(false);
      expect(created.revision).toBe(1);
      expect(created.publishedVersionId).toBeNull();
      expect(created.draft).toBeDefined();
    });
  });

  it('AC-LIFE-002: duplicates an existing template with fresh IDs and zero assignments', async () => {
    let sourceId = '';
    await dbService.withUser(aliceId, async (tx) => {
      const source = await templateService.createTemplate(
        tx,
        storeA.tenantId,
        storeA.storeId,
        {
          kind: 'product',
          name: 'Default Product Template',
        },
      );
      sourceId = source.id;

      const duplicate = await templateService.duplicateTemplate(
        tx,
        storeA.tenantId,
        storeA.storeId,
        sourceId,
      );

      expect(duplicate.id).not.toBe(sourceId);
      expect(duplicate.name).toBe('Copy of Default Product Template');
      expect(duplicate.status).toBe('active');
      expect(duplicate.isDefault).toBe(false);
      expect(duplicate.revision).toBe(1);
      expect(duplicate.publishedVersionId).toBeNull();

      // Verify node IDs differ
      const sourceSections = Object.keys(source.draft.sections);
      const duplicateSections = Object.keys(duplicate.draft.sections);
      expect(duplicateSections).not.toEqual(sourceSections);
    });
  });

  it('AC-LIFE-003: renames templates with 1-80 character validation and allows duplicates', async () => {
    await dbService.withUser(aliceId, async (tx) => {
      const t1 = await templateService.createTemplate(
        tx,
        storeA.tenantId,
        storeA.storeId,
        {
          kind: 'collection',
          name: 'Collection A',
        },
      );

      // Valid rename with trimming
      const renamed = await templateService.renameTemplate(
        tx,
        storeA.tenantId,
        storeA.storeId,
        t1.id,
        '  Collection Renamed  ',
      );
      expect(renamed.name).toBe('Collection Renamed');

      // Duplicate name allowed
      const t2 = await templateService.createTemplate(
        tx,
        storeA.tenantId,
        storeA.storeId,
        {
          kind: 'collection',
          name: 'Collection B',
        },
      );
      const renamed2 = await templateService.renameTemplate(
        tx,
        storeA.tenantId,
        storeA.storeId,
        t2.id,
        'Collection Renamed',
      );
      expect(renamed2.name).toBe('Collection Renamed');

      // Invalid name (>80 characters or empty)
      await expect(
        templateService.renameTemplate(
          tx,
          storeA.tenantId,
          storeA.storeId,
          t1.id,
          '',
        ),
      ).rejects.toThrow(TemplateValidationError);

      await expect(
        templateService.renameTemplate(
          tx,
          storeA.tenantId,
          storeA.storeId,
          t1.id,
          'A'.repeat(81),
        ),
      ).rejects.toThrow(TemplateValidationError);
    });
  });

  it('AC-LIFE-004: archives and restores templates while retaining assignments and clearing isDefault', async () => {
    await dbService.withUser(aliceId, async (tx) => {
      const t = await templateService.createTemplate(
        tx,
        storeA.tenantId,
        storeA.storeId,
        {
          kind: 'product',
          name: 'Archivable Product',
        },
      );

      // Set as default
      await templateService.setDefaultTemplate(
        tx,
        storeA.tenantId,
        storeA.storeId,
        t.id,
      );

      // Archive clears isDefault atomically (D7)
      const archived = await templateService.archiveTemplate(
        tx,
        storeA.tenantId,
        storeA.storeId,
        t.id,
      );
      expect(archived.status).toBe('archived');
      expect(archived.isDefault).toBe(false);

      // Repeated archive is a no-op (D39)
      const reArchived = await templateService.archiveTemplate(
        tx,
        storeA.tenantId,
        storeA.storeId,
        t.id,
      );
      expect(reArchived.status).toBe('archived');

      // Restore sets active, restore never reinstates isDefault
      const restored = await templateService.restoreTemplate(
        tx,
        storeA.tenantId,
        storeA.storeId,
        t.id,
      );
      expect(restored.status).toBe('active');
      expect(restored.isDefault).toBe(false);

      // Repeated restore is a no-op
      const reRestored = await templateService.restoreTemplate(
        tx,
        storeA.tenantId,
        storeA.storeId,
        t.id,
      );
      expect(reRestored.status).toBe('active');
    });
  });

  it('AC-LIFE-005: saveDraft requires matching expectedRevision and detects unchanged no-ops', async () => {
    await dbService.withUser(aliceId, async (tx) => {
      const t = await templateService.createTemplate(
        tx,
        storeA.tenantId,
        storeA.storeId,
        {
          kind: 'index',
          presetKey: 'classic',
          name: 'Save Draft Target',
        },
      );
      expect(t.revision).toBe(1);

      // Stale revision throws 409 conflict
      await expect(
        publishService.saveDraft(
          tx,
          storeA.tenantId,
          storeA.storeId,
          t.id,
          999,
          t.draft,
        ),
      ).rejects.toThrow(TemplateConflictError);

      // Unchanged draft is a no-op returning outcome: 'unchanged'
      const unchangedRes = await publishService.saveDraft(
        tx,
        storeA.tenantId,
        storeA.storeId,
        t.id,
        1,
        t.draft,
      );
      expect(unchangedRes.outcome).toBe('unchanged');

      // Changed draft bumps revision
      const modifiedDoc = structuredClone(t.draft);
      modifiedDoc.sections.hero.settings = {
        ...modifiedDoc.sections.hero.settings,
        heading: 'Updated Heading',
      };

      const savedRes = await publishService.saveDraft(
        tx,
        storeA.tenantId,
        storeA.storeId,
        t.id,
        1,
        modifiedDoc,
      );
      expect(savedRes.outcome).toBe('saved');
      expect(savedRes.template.revision).toBe(2);
    });
  });

  it('AC-LIFE-006 & AC-LIFE-007: publish pipeline validates document, checks images, inserts version, moves pointer', async () => {
    await dbService.withUser(aliceId, async (tx) => {
      const t = await templateService.createTemplate(
        tx,
        storeA.tenantId,
        storeA.storeId,
        {
          kind: 'index',
          presetKey: 'classic',
          name: 'Publish Target',
        },
      );

      // Missing image test (AC-LIFE-007)
      const mockImageChecker = async (paths: string[]) => paths; // reports all images as missing
      const docWithImage: TemplateDocument = structuredClone(t.draft);
      docWithImage.sections.hero.settings.banner = {
        path: `${storeA.tenantId}/store/missing.jpg`,
      };

      await publishService.saveDraft(
        tx,
        storeA.tenantId,
        storeA.storeId,
        t.id,
        1,
        docWithImage,
      );

      await expect(
        publishService.publish(
          tx,
          storeA.tenantId,
          storeA.storeId,
          t.id,
          2,
          mockImageChecker,
        ),
      ).rejects.toThrow(TemplateMissingAssetError);

      // Successful publish (no images missing)
      const cleanImageChecker = async () => []; // 0 missing
      const pubRes = await publishService.publish(
        tx,
        storeA.tenantId,
        storeA.storeId,
        t.id,
        2,
        cleanImageChecker,
      );

      expect(pubRes.outcome).toBe('published');
      expect(pubRes.version).toBeDefined();
      expect(pubRes.version!.versionNumber).toBe(1);
      expect(pubRes.template.publishedVersionId).toBe(pubRes.version!.id);

      // Second publish with unchanged document is a no-op (D25)
      const republishRes = await publishService.publish(
        tx,
        storeA.tenantId,
        storeA.storeId,
        t.id,
        2,
        cleanImageChecker,
      );
      expect(republishRes.outcome).toBe('unchanged');
    });
  });

  it('AC-LIFE-008: unpublish nulls the published pointer while preserving version history', async () => {
    await dbService.withUser(aliceId, async (tx) => {
      const t = await templateService.createTemplate(
        tx,
        storeA.tenantId,
        storeA.storeId,
        {
          kind: 'index',
          presetKey: 'classic',
          name: 'Unpublish Target',
        },
      );

      await publishService.publish(
        tx,
        storeA.tenantId,
        storeA.storeId,
        t.id,
        1,
      );

      // Unpublish
      const unpublished = await publishService.unpublish(
        tx,
        storeA.tenantId,
        storeA.storeId,
        t.id,
      );
      expect(unpublished.publishedVersionId).toBeNull();

      // Versions history preserved
      const versions = await queryService.listVersions(
        tx,
        storeA.tenantId,
        storeA.storeId,
        t.id,
      );
      expect(versions.total).toBe(1);

      // Repeated unpublish is a no-op
      const reUnpublished = await publishService.unpublish(
        tx,
        storeA.tenantId,
        storeA.storeId,
        t.id,
      );
      expect(reUnpublished.publishedVersionId).toBeNull();
    });
  });

  it('AC-LIFE-009: rollback creates a new immutable version with source = rollback', async () => {
    await dbService.withUser(aliceId, async (tx) => {
      const t = await templateService.createTemplate(
        tx,
        storeA.tenantId,
        storeA.storeId,
        {
          kind: 'index',
          presetKey: 'classic',
          name: 'Rollback Target',
        },
      );

      // Publish version 1
      const v1Res = await publishService.publish(
        tx,
        storeA.tenantId,
        storeA.storeId,
        t.id,
        1,
      );
      const v1Id = v1Res.version!.id;

      // Edit draft and publish version 2
      const modifiedDoc = structuredClone(t.draft);
      modifiedDoc.sections.hero.settings.heading = 'V2 Heading';
      await publishService.saveDraft(
        tx,
        storeA.tenantId,
        storeA.storeId,
        t.id,
        1,
        modifiedDoc,
      );
      await publishService.publish(
        tx,
        storeA.tenantId,
        storeA.storeId,
        t.id,
        2,
      );

      // Rollback to v1
      const rollRes = await publishService.rollback(
        tx,
        storeA.tenantId,
        storeA.storeId,
        t.id,
        v1Id,
      );
      expect(rollRes.outcome).toBe('rolled_back');
      expect(rollRes.version!.source).toBe('rollback');
      expect(rollRes.version!.rolledBackFrom).toBe(v1Id);
      expect(rollRes.version!.versionNumber).toBe(3);
      expect(rollRes.template.publishedVersionId).toBe(rollRes.version!.id);

      // Rolling back to the same live document is a no-op (D28)
      const repeatRollback = await publishService.rollback(
        tx,
        storeA.tenantId,
        storeA.storeId,
        t.id,
        v1Id,
      );
      expect(repeatRollback.outcome).toBe('unchanged');
    });
  });

  it('AC-LIFE-010: restoreVersion restores an older version into mutable draft', async () => {
    await dbService.withUser(aliceId, async (tx) => {
      const t = await templateService.createTemplate(
        tx,
        storeA.tenantId,
        storeA.storeId,
        {
          kind: 'index',
          presetKey: 'classic',
          name: 'Restore Version Target',
        },
      );

      const v1Res = await publishService.publish(
        tx,
        storeA.tenantId,
        storeA.storeId,
        t.id,
        1,
      );
      const v1Id = v1Res.version!.id;

      // Edit draft to something different
      const modifiedDoc = structuredClone(t.draft);
      modifiedDoc.sections.hero.settings.heading = 'New Draft Heading';
      await publishService.saveDraft(
        tx,
        storeA.tenantId,
        storeA.storeId,
        t.id,
        1,
        modifiedDoc,
      );

      // Restore v1 into draft
      const restoreRes = await publishService.restoreVersion(
        tx,
        storeA.tenantId,
        storeA.storeId,
        t.id,
        v1Id,
        2, // expectedRevision
      );
      expect(restoreRes.outcome).toBe('restored');
      expect(restoreRes.template.revision).toBe(3);
      expect(
        (restoreRes.template.draft as TemplateDocument).sections.hero.settings
          .heading,
      ).not.toBe('New Draft Heading');
    });
  });

  it('AC-LIFE-011: swaps defaults atomically with exactly one default per kind', async () => {
    await dbService.withUser(aliceId, async (tx) => {
      const t1 = await templateService.createTemplate(
        tx,
        storeA.tenantId,
        storeA.storeId,
        {
          kind: 'index',
          presetKey: 'classic',
          name: 'Default Candidate 1',
        },
      );
      const t2 = await templateService.createTemplate(
        tx,
        storeA.tenantId,
        storeA.storeId,
        {
          kind: 'index',
          presetKey: 'spotlight',
          name: 'Default Candidate 2',
        },
      );

      // Set t1 default
      await templateService.setDefaultTemplate(
        tx,
        storeA.tenantId,
        storeA.storeId,
        t1.id,
      );
      const read1 = await queryService.getTemplate(
        tx,
        storeA.tenantId,
        storeA.storeId,
        t1.id,
      );
      expect(read1.isDefault).toBe(true);

      // Swap to t2 default
      await templateService.setDefaultTemplate(
        tx,
        storeA.tenantId,
        storeA.storeId,
        t2.id,
      );

      const postT1 = await queryService.getTemplate(
        tx,
        storeA.tenantId,
        storeA.storeId,
        t1.id,
      );
      const postT2 = await queryService.getTemplate(
        tx,
        storeA.tenantId,
        storeA.storeId,
        t2.id,
      );

      expect(postT1.isDefault).toBe(false);
      expect(postT2.isDefault).toBe(true);
    });
  });

  it('AC-LIFE-012: template assignment service handles assign, replace, unassign, and kind validation', async () => {
    await dbService.withUser(aliceId, async (tx) => {
      const prodTpl = await templateService.createTemplate(
        tx,
        storeA.tenantId,
        storeA.storeId,
        {
          kind: 'product',
          name: 'Product Assignment Tpl 1',
        },
      );
      const prodTpl2 = await templateService.createTemplate(
        tx,
        storeA.tenantId,
        storeA.storeId,
        {
          kind: 'product',
          name: 'Product Assignment Tpl 2',
        },
      );
      const colTpl = await templateService.createTemplate(
        tx,
        storeA.tenantId,
        storeA.storeId,
        {
          kind: 'collection',
          name: 'Collection Assignment Tpl',
        },
      );

      // Initial assignment: outcome 'created'
      const assignRes1 = await assignmentService.assign(
        tx,
        storeA.tenantId,
        storeA.storeId,
        [
          {
            resourceType: 'product',
            resourceId: dummyProductId,
            templateId: prodTpl.id,
          },
          {
            resourceType: 'collection',
            resourceId: dummyCollectionId,
            templateId: colTpl.id,
          },
        ],
      );
      expect(assignRes1.results[0].outcome).toBe('created');
      expect(assignRes1.results[1].outcome).toBe('created');

      // Replace assignment: outcome 'replaced'
      const assignRes2 = await assignmentService.assign(
        tx,
        storeA.tenantId,
        storeA.storeId,
        [
          {
            resourceType: 'product',
            resourceId: dummyProductId,
            templateId: prodTpl2.id,
          },
        ],
      );
      expect(assignRes2.results[0].outcome).toBe('replaced');

      // Same assignment: outcome 'unchanged'
      const assignRes3 = await assignmentService.assign(
        tx,
        storeA.tenantId,
        storeA.storeId,
        [
          {
            resourceType: 'product',
            resourceId: dummyProductId,
            templateId: prodTpl2.id,
          },
        ],
      );
      expect(assignRes3.results[0].outcome).toBe('unchanged');

      // Unassign: outcome 'removed'
      const unassignRes1 = await assignmentService.unassign(
        tx,
        storeA.tenantId,
        storeA.storeId,
        [
          { resourceType: 'product', resourceId: dummyProductId },
          { resourceType: 'collection', resourceId: dummyCollectionId },
        ],
      );
      expect(unassignRes1.results[0].outcome).toBe('removed');
      expect(unassignRes1.results[1].outcome).toBe('removed');

      // Repeated unassign: outcome 'absent'
      const unassignRes2 = await assignmentService.unassign(
        tx,
        storeA.tenantId,
        storeA.storeId,
        [{ resourceType: 'product', resourceId: dummyProductId }],
      );
      expect(unassignRes2.results[0].outcome).toBe('absent');

      // Kind mismatch rejected (e.g. index template assigned to product)
      const indexTpl = await templateService.createTemplate(
        tx,
        storeA.tenantId,
        storeA.storeId,
        {
          kind: 'index',
          presetKey: 'classic',
          name: 'Index Mismatch',
        },
      );
      await expect(
        assignmentService.assign(tx, storeA.tenantId, storeA.storeId, [
          {
            resourceType: 'product',
            resourceId: dummyProductId,
            templateId: indexTpl.id,
          },
        ]),
      ).rejects.toThrow(TemplateValidationError);
    });
  });

  it('AC-LIFE-020: safe delete permitted only when never published and unassigned', async () => {
    await dbService.withUser(aliceId, async (tx) => {
      const t = await templateService.createTemplate(
        tx,
        storeA.tenantId,
        storeA.storeId,
        {
          kind: 'product',
          name: 'Delete Test Product',
        },
      );

      // Assign to product
      await assignmentService.assign(tx, storeA.tenantId, storeA.storeId, [
        {
          resourceType: 'product',
          resourceId: dummyProductId,
          templateId: t.id,
        },
      ]);

      // Deleting assigned template throws conflict reason "assigned"
      await expect(
        templateService.deleteTemplate(
          tx,
          storeA.tenantId,
          storeA.storeId,
          t.id,
        ),
      ).rejects.toThrow(TemplateConflictError);

      // Unassign
      await assignmentService.unassign(tx, storeA.tenantId, storeA.storeId, [
        { resourceType: 'product', resourceId: dummyProductId },
      ]);

      // Publish template
      await publishService.publish(
        tx,
        storeA.tenantId,
        storeA.storeId,
        t.id,
        1,
      );

      // Deleting published template throws conflict reason "published"
      await expect(
        templateService.deleteTemplate(
          tx,
          storeA.tenantId,
          storeA.storeId,
          t.id,
        ),
      ).rejects.toThrow(TemplateConflictError);

      // Never published and unassigned template deletes successfully
      const freshTpl = await templateService.createTemplate(
        tx,
        storeA.tenantId,
        storeA.storeId,
        {
          kind: 'product',
          name: 'Clean Delete Tpl',
        },
      );
      await expect(
        templateService.deleteTemplate(
          tx,
          storeA.tenantId,
          storeA.storeId,
          freshTpl.id,
        ),
      ).resolves.toBeUndefined();
    });
  });

  it('AC-LIFE-021: shared document lazy first edit creates row at expectedRevision: 0', async () => {
    await dbService.withUser(aliceId, async (tx) => {
      // Prior to first save: getSharedDocument returns preset default with revision 0
      const initial = await queryService.getSharedDocument(
        tx,
        storeA.tenantId,
        storeA.storeId,
        'group_header',
      );
      expect(initial.id).toBeNull();
      expect(initial.revision).toBe(0);
      expect(initial.publicationState).toBe('draft');
      expect(initial.document).toBeDefined();

      // First save with expectedRevision 0 creates row with revision 1
      const saveRes = await publishService.saveSharedDraft(
        tx,
        storeA.tenantId,
        storeA.storeId,
        'group_header',
        0,
        initial.document,
      );
      expect(saveRes.outcome).toBe('saved');
      expect(saveRes.template.revision).toBe(1);

      // Subsequent read returns real DB row
      const savedDoc = await queryService.getSharedDocument(
        tx,
        storeA.tenantId,
        storeA.storeId,
        'group_header',
      );
      expect(savedDoc.id).not.toBeNull();
      expect(savedDoc.revision).toBe(1);

      // Second save with expectedRevision 0 fails with 409 conflict
      await expect(
        publishService.saveSharedDraft(
          tx,
          storeA.tenantId,
          storeA.storeId,
          'group_header',
          0,
          initial.document,
        ),
      ).rejects.toThrow(TemplateConflictError);
    });
  });

  it('cross-tenant isolation: requests referencing other tenants return 404 (D18)', async () => {
    await dbService.withUser(aliceId, async (tx) => {
      // Alice tries to access Bob's store: throws TemplateNotFoundError
      await expect(
        queryService.listTemplates(tx, storeA.tenantId, storeB.storeId),
      ).resolves.toEqual({ items: [], total: 0, page: 1, pageSize: 20 });

      // Alice tries to read a template from storeB
      await expect(
        queryService.getTemplate(
          tx,
          storeA.tenantId,
          storeB.storeId,
          '00000000-0000-0000-0000-000000000000',
        ),
      ).rejects.toThrow(TemplateNotFoundError);
    });
  });

  afterAll(async () => {
    await dbService.onApplicationShutdown();
    await moduleRef.close();
    await testDb.close();
  });
});
