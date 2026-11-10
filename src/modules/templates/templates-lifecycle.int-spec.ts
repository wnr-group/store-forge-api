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
import { TemplateAssignmentService } from './services/template-assignment.service.js';
import { TemplatePublishService } from './services/template-publish.service.js';
import {
  TemplateConflictError,
  TemplateNotFoundError,
  TemplateValidationError,
} from './support/template-errors.js';

describe('Templates Lifecycle Integration (INT-PGLITE)', () => {
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
      email: 'alice.life@example.test',
      fullName: 'Alice',
    });
    bobId = await createUser(testDb.pg, {
      email: 'bob.life@example.test',
      fullName: 'Bob',
    });

    storeA = await createTenantWithOwner(testDb.pg, {
      ownerId: aliceId,
      storeSlug: 'alice-life-shop',
      tenantName: 'Alice Life Inc',
    });

    storeB = await createTenantWithOwner(testDb.pg, {
      ownerId: bobId,
      storeSlug: 'bob-life-shop',
      tenantName: 'Bob Life Inc',
    });

    await withSuperuser(testDb.pg, async () => {
      const prodRes = await testDb.pg.query<{ id: string }>(
        `INSERT INTO products (tenant_id, name, slug, status) 
         VALUES ($1, 'Test Product', 'test-prod', 'active') RETURNING id`,
        [storeA.tenantId],
      );
      dummyProductId = prodRes.rows[0].id;
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

      const renamed = await templateService.renameTemplate(
        tx,
        storeA.tenantId,
        storeA.storeId,
        t1.id,
        '  Collection Renamed  ',
      );
      expect(renamed.name).toBe('Collection Renamed');

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

      await templateService.setDefaultTemplate(
        tx,
        storeA.tenantId,
        storeA.storeId,
        t.id,
      );

      const archived = await templateService.archiveTemplate(
        tx,
        storeA.tenantId,
        storeA.storeId,
        t.id,
      );
      expect(archived.status).toBe('archived');
      expect(archived.isDefault).toBe(false);

      const reArchived = await templateService.archiveTemplate(
        tx,
        storeA.tenantId,
        storeA.storeId,
        t.id,
      );
      expect(reArchived.status).toBe('archived');

      const restored = await templateService.restoreTemplate(
        tx,
        storeA.tenantId,
        storeA.storeId,
        t.id,
      );
      expect(restored.status).toBe('active');
      expect(restored.isDefault).toBe(false);

      const reRestored = await templateService.restoreTemplate(
        tx,
        storeA.tenantId,
        storeA.storeId,
        t.id,
      );
      expect(reRestored.status).toBe('active');
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

      await assignmentService.assign(tx, storeA.tenantId, storeA.storeId, [
        {
          resourceType: 'product',
          resourceId: dummyProductId,
          templateId: t.id,
        },
      ]);

      await expect(
        templateService.deleteTemplate(
          tx,
          storeA.tenantId,
          storeA.storeId,
          t.id,
        ),
      ).rejects.toThrow(TemplateConflictError);

      await assignmentService.unassign(tx, storeA.tenantId, storeA.storeId, [
        { resourceType: 'product', resourceId: dummyProductId },
      ]);

      await publishService.publish(tx, storeA.tenantId, storeA.storeId, t.id, 1);

      await expect(
        templateService.deleteTemplate(
          tx,
          storeA.tenantId,
          storeA.storeId,
          t.id,
        ),
      ).rejects.toThrow(TemplateConflictError);

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

  it('cross-tenant isolation: requests referencing other tenants return 404 (D18)', async () => {
    await dbService.withUser(aliceId, async (tx) => {
      await expect(
        queryService.listTemplates(tx, storeA.tenantId, storeB.storeId),
      ).resolves.toEqual({ items: [], total: 0, page: 1, pageSize: 20 });

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
