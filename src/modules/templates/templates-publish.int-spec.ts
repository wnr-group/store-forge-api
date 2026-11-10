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
import type { TemplateDocument } from '../../infrastructure/database/template-deps/document.js';
import { TemplateQueryService } from './services/template-query.service.js';
import { TemplateService } from './services/template.service.js';
import { TemplateAssignmentService } from './services/template-assignment.service.js';
import { TemplatePublishService } from './services/template-publish.service.js';
import {
  TemplateConflictError,
  TemplateMissingAssetError,
  TemplateValidationError,
} from './support/template-errors.js';

describe('Templates Publishing and Assignments Integration (INT-PGLITE)', () => {
  let testDb: TestDatabase;
  let moduleRef: TestingModule;
  let dbService: DatabaseService;

  let aliceId: string;
  let storeA: { tenantId: string; storeId: string; storeSlug: string };

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
                poolMax: 1,
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
      email: 'alice.pub@example.test',
      fullName: 'Alice',
    });

    storeA = await createTenantWithOwner(testDb.pg, {
      ownerId: aliceId,
      storeSlug: 'alice-pub-shop',
      tenantName: 'Alice Pub Inc',
    });

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

      const unchangedRes = await publishService.saveDraft(
        tx,
        storeA.tenantId,
        storeA.storeId,
        t.id,
        1,
        t.draft,
      );
      expect(unchangedRes.outcome).toBe('unchanged');

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

      const mockImageChecker = async (paths: string[]) => paths;
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

      const cleanImageChecker = async () => [];
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

      const unpublished = await publishService.unpublish(
        tx,
        storeA.tenantId,
        storeA.storeId,
        t.id,
      );
      expect(unpublished.publishedVersionId).toBeNull();

      const versions = await queryService.listVersions(
        tx,
        storeA.tenantId,
        storeA.storeId,
        t.id,
      );
      expect(versions.total).toBe(1);

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

      const v1Res = await publishService.publish(
        tx,
        storeA.tenantId,
        storeA.storeId,
        t.id,
        1,
      );
      const v1Id = v1Res.version!.id;

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

      const restoreRes = await publishService.restoreVersion(
        tx,
        storeA.tenantId,
        storeA.storeId,
        t.id,
        v1Id,
        2,
      );
      expect(restoreRes.outcome).toBe('restored');
      expect(restoreRes.template.revision).toBe(3);
      expect(
        (restoreRes.template.draft as TemplateDocument).sections.hero.settings
          .heading,
      ).not.toBe('New Draft Heading');
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

      const unassignRes2 = await assignmentService.unassign(
        tx,
        storeA.tenantId,
        storeA.storeId,
        [{ resourceType: 'product', resourceId: dummyProductId }],
      );
      expect(unassignRes2.results[0].outcome).toBe('absent');

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

  it('AC-LIFE-021: shared document lazy first edit creates row at expectedRevision: 0', async () => {
    await dbService.withUser(aliceId, async (tx) => {
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

      const savedDoc = await queryService.getSharedDocument(
        tx,
        storeA.tenantId,
        storeA.storeId,
        'group_header',
      );
      expect(savedDoc.id).not.toBeNull();
      expect(savedDoc.revision).toBe(1);

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

  afterAll(async () => {
    await dbService.onApplicationShutdown();
    await moduleRef.close();
    await testDb.close();
  });
});
