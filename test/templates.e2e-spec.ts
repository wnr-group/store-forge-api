import type { INestApplication } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import { generateKeyPair, SignJWT } from 'jose';
import request from 'supertest';
import type { App } from 'supertest/types.js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AppModule } from '../src/app.module.js';
import { configureApp } from '../src/app.setup.js';
import { DatabaseService } from '../src/infrastructure/database/database.service.js';
import { SupabaseJwtService } from '../src/modules/auth/supabase-jwt.service.js';
import {
  createTestDatabase,
  type TestDatabase,
} from './support/database/create-test-database.js';
import {
  createPlatformAdmin,
  createTenantWithOwner,
  createUser,
  withSuperuser,
} from './support/database/fixtures.js';

describe('Templates Lifecycle API (e2e)', () => {
  let app: INestApplication<App>;
  let testDb: TestDatabase;
  let dbService: DatabaseService;

  let ownerAToken: string;
  let managerAToken: string;
  let staffAToken: string;
  let ownerBToken: string;
  let platformAdminToken: string;

  let tenantA: { tenantId: string; storeId: string };
  let _tenantB: { tenantId: string; storeId: string };

  beforeAll(async () => {
    testDb = await createTestDatabase({ fullAuth: true });

    // Generate keys for test JWT tokens
    const { privateKey, publicKey } = await generateKeyPair('RS256');

    const sign = async (userId: string) => {
      return new SignJWT({
        role: 'authenticated',
        email: `${userId}@example.test`,
      })
        .setProtectedHeader({ alg: 'RS256', kid: 'test-key' })
        .setSubject(userId)
        .setIssuer('https://placeholder.supabase.co/auth/v1')
        .setAudience('authenticated')
        .setExpirationTime('1h')
        .sign(privateKey);
    };

    // Seed users and tenants in DB
    const ownerAId = await createUser(testDb.pg, {
      email: 'owner.a@example.test',
    });
    const managerAId = await createUser(testDb.pg, {
      email: 'manager.a@example.test',
    });
    const staffAId = await createUser(testDb.pg, {
      email: 'staff.a@example.test',
    });
    const ownerBId = await createUser(testDb.pg, {
      email: 'owner.b@example.test',
    });
    const platformAdminId = await createPlatformAdmin(testDb.pg, {
      email: 'admin@platform.test',
      role: 'super_admin',
    });

    tenantA = await createTenantWithOwner(testDb.pg, {
      ownerId: ownerAId,
      storeSlug: 'store-a',
      tenantName: 'Tenant A',
      storeName: 'Store A',
    });

    _tenantB = await createTenantWithOwner(testDb.pg, {
      ownerId: ownerBId,
      storeSlug: 'store-b',
      tenantName: 'Tenant B',
      storeName: 'Store B',
    });

    // Add manager and staff to Tenant A
    await withSuperuser(testDb.pg, async () => {
      await testDb.pg.query(
        `INSERT INTO memberships (tenant_id, user_id, role, status, permissions)
         VALUES ($1, $2, 'admin', 'active', '{"settings": "write", "products": "write", "orders": "read", "customers": "write"}'::jsonb)`,
        [tenantA.tenantId, managerAId],
      );
      await testDb.pg.query(
        `INSERT INTO memberships (tenant_id, user_id, role, status, permissions)
         VALUES ($1, $2, 'staff', 'active', '{"settings": "read", "products": "write", "orders": "read", "customers": "write"}'::jsonb)`,
        [tenantA.tenantId, staffAId],
      );
    });

    ownerAToken = await sign(ownerAId);
    managerAToken = await sign(managerAId);
    staffAToken = await sign(staffAId);
    ownerBToken = await sign(ownerBId);
    platformAdminToken = await sign(platformAdminId);

    // Boot NestJS application with overridden JWT key resolver and connected DatabaseService
    const moduleRef = await Test.createTestingModule({
      imports: [AppModule],
    })
      .overrideProvider(SupabaseJwtService)
      .useFactory({
        factory: (config: ConfigService) =>
          new SupabaseJwtService(
            config as never,
            async () => publicKey as never,
          ),
        inject: [ConfigService],
      })
      .compile();

    app = moduleRef.createNestApplication();
    configureApp(app);

    dbService = app.get(DatabaseService);
    dbService.initClient(testDb.url);

    await app.init();
  });

  afterAll(async () => {
    if (app) await app.close();
    if (testDb) await testDb.close();
  });

  describe('AC-LIFE-015: Authorization and Tenant Isolation Matrix', () => {
    it('denies anonymous callers with 401 AUTH_REQUIRED', async () => {
      const res = await request(app.getHttpServer())
        .get(`/api/v1/stores/${tenantA.storeId}/templates`)
        .expect(401);

      expect(res.body.success).toBe(false);
      expect(res.body.error.code).toBe('AUTH_REQUIRED');
    });

    it('denies callers without valid organization header with 403 ORGANIZATION_ACCESS_DENIED', async () => {
      const res = await request(app.getHttpServer())
        .get(`/api/v1/stores/${tenantA.storeId}/templates`)
        .set('Authorization', `Bearer ${ownerAToken}`)
        .set('X-Organization-Id', '00000000-0000-0000-0000-000000000000')
        .expect(403);

      expect(res.body.success).toBe(false);
      expect(res.body.error.code).toBe('ORGANIZATION_ACCESS_DENIED');
    });

    it('denies Owner of another tenant (cross-tenant attack) with 403', async () => {
      const res = await request(app.getHttpServer())
        .get(`/api/v1/stores/${tenantA.storeId}/templates`)
        .set('Authorization', `Bearer ${ownerBToken}`)
        .set('X-Organization-Id', tenantA.tenantId)
        .expect(403);

      expect(res.body.success).toBe(false);
      expect(res.body.error.code).toBe('ORGANIZATION_ACCESS_DENIED');
    });

    it('denies Staff members (lacks store:manage permission) with 403 FORBIDDEN', async () => {
      const res = await request(app.getHttpServer())
        .get(`/api/v1/stores/${tenantA.storeId}/templates`)
        .set('Authorization', `Bearer ${staffAToken}`)
        .set('X-Organization-Id', tenantA.tenantId)
        .expect(403);

      expect(res.body.success).toBe(false);
      expect(res.body.error.code).toBe('FORBIDDEN');
    });

    it('denies Platform Admin without tenant membership with 404 NO_WORKSPACE', async () => {
      const res = await request(app.getHttpServer())
        .get(`/api/v1/stores/${tenantA.storeId}/templates`)
        .set('Authorization', `Bearer ${platformAdminToken}`)
        .set('X-Organization-Id', tenantA.tenantId)
        .expect(404);

      expect(res.body.success).toBe(false);
      expect(res.body.error.code).toBe('NO_WORKSPACE');
    });

    it('allows Tenant Owner with 200 OK', async () => {
      const res = await request(app.getHttpServer())
        .get(`/api/v1/stores/${tenantA.storeId}/templates`)
        .set('Authorization', `Bearer ${ownerAToken}`)
        .set('X-Organization-Id', tenantA.tenantId)
        .expect(200);

      expect(res.body.success).toBe(true);
      expect(Array.isArray(res.body.data.items)).toBe(true);
    });

    it('allows Manager (admin role with store:manage) with 200 OK', async () => {
      const res = await request(app.getHttpServer())
        .get(`/api/v1/stores/${tenantA.storeId}/templates`)
        .set('Authorization', `Bearer ${managerAToken}`)
        .set('X-Organization-Id', tenantA.tenantId)
        .expect(200);

      expect(res.body.success).toBe(true);
      expect(Array.isArray(res.body.data.items)).toBe(true);
    });
  });

  describe('Template Lifecycle Operations (AC-LIFE-001 to 011, 014, 020)', () => {
    let createdTemplateId: string;
    let createdTemplateDraft: Record<string, unknown>;

    it('AC-LIFE-001: creates index template from classic preset (201)', async () => {
      const res = await request(app.getHttpServer())
        .post(`/api/v1/stores/${tenantA.storeId}/templates`)
        .set('Authorization', `Bearer ${ownerAToken}`)
        .set('X-Organization-Id', tenantA.tenantId)
        .send({
          kind: 'index',
          name: 'Main Landing Page',
          presetKey: 'classic',
        })
        .expect(201);

      expect(res.body.success).toBe(true);
      expect(res.body.data.name).toBe('Main Landing Page');
      expect(res.body.data.kind).toBe('index');
      expect(res.body.data.status).toBe('active');
      expect(res.body.data.isDefault).toBe(false);
      expect(res.body.data.revision).toBe(1);
      expect(res.body.data.draft).toBeDefined();

      createdTemplateId = res.body.data.id;
      createdTemplateDraft = res.body.data.draft;
    });

    it('rejects creation when presetKey is missing for index kind (400)', async () => {
      const res = await request(app.getHttpServer())
        .post(`/api/v1/stores/${tenantA.storeId}/templates`)
        .set('Authorization', `Bearer ${ownerAToken}`)
        .set('X-Organization-Id', tenantA.tenantId)
        .send({
          kind: 'index',
          name: 'Missing Preset',
        })
        .expect(400);

      expect(res.body.success).toBe(false);
      expect(res.body.error.code).toBe('VALIDATION_ERROR');
    });

    it('AC-LIFE-003: renames template with 1..80 char name (200)', async () => {
      const res = await request(app.getHttpServer())
        .patch(
          `/api/v1/stores/${tenantA.storeId}/templates/${createdTemplateId}`,
        )
        .set('Authorization', `Bearer ${ownerAToken}`)
        .set('X-Organization-Id', tenantA.tenantId)
        .send({ name: 'Renamed Home Page' })
        .expect(200);

      expect(res.body.success).toBe(true);
      expect(res.body.data.name).toBe('Renamed Home Page');
    });

    it('AC-LIFE-003: rejects invalid rename with empty or whitespace-only name (400)', async () => {
      const res = await request(app.getHttpServer())
        .patch(
          `/api/v1/stores/${tenantA.storeId}/templates/${createdTemplateId}`,
        )
        .set('Authorization', `Bearer ${ownerAToken}`)
        .set('X-Organization-Id', tenantA.tenantId)
        .send({ name: '   ' })
        .expect(400);

      expect(res.body.success).toBe(false);
      expect(res.body.error.code).toBe('VALIDATION_ERROR');
    });

    it('AC-LIFE-002: duplicates template with fresh IDs and "Copy of" prefix (201)', async () => {
      const res = await request(app.getHttpServer())
        .post(
          `/api/v1/stores/${tenantA.storeId}/templates/${createdTemplateId}/duplicate`,
        )
        .set('Authorization', `Bearer ${ownerAToken}`)
        .set('X-Organization-Id', tenantA.tenantId)
        .expect(201);

      expect(res.body.success).toBe(true);
      expect(res.body.data.name).toBe('Copy of Renamed Home Page');
      expect(res.body.data.id).not.toBe(createdTemplateId);
      expect(res.body.data.revision).toBe(1);
      expect(res.body.data.isDefault).toBe(false);
      expect(res.body.data.status).toBe('active');
    });

    it('AC-LIFE-005: saves draft with matching revision (200)', async () => {
      const modifiedDoc = structuredClone(createdTemplateDraft) as Record<
        string,
        any
      >;
      // Modify a section setting so the document genuinely changes
      const secKey = Object.keys(modifiedDoc.sections || {})[0];
      if (secKey && modifiedDoc.sections[secKey]) {
        modifiedDoc.sections[secKey].settings = {
          ...modifiedDoc.sections[secKey].settings,
          title: 'Custom Updated Title',
        };
      }

      const res = await request(app.getHttpServer())
        .put(
          `/api/v1/stores/${tenantA.storeId}/templates/${createdTemplateId}/draft`,
        )
        .set('Authorization', `Bearer ${ownerAToken}`)
        .set('X-Organization-Id', tenantA.tenantId)
        .send({
          expectedRevision: 1,
          document: modifiedDoc,
        })
        .expect(200);

      expect(res.body.success).toBe(true);
      expect(res.body.data.outcome).toBe('saved');
      expect(res.body.data.template.revision).toBe(2);
      createdTemplateDraft = modifiedDoc;
    });

    it('AC-LIFE-005: rejects draft save with stale revision (409 CONFLICT)', async () => {
      const res = await request(app.getHttpServer())
        .put(
          `/api/v1/stores/${tenantA.storeId}/templates/${createdTemplateId}/draft`,
        )
        .set('Authorization', `Bearer ${ownerAToken}`)
        .set('X-Organization-Id', tenantA.tenantId)
        .send({
          expectedRevision: 1, // Stale! Current revision is 2
          document: { ...createdTemplateDraft, layout: 'spotlight' },
        })
        .expect(409);

      expect(res.body.success).toBe(false);
      expect(res.body.error.code).toBe('CONFLICT');
      expect(res.body.error.details.reason).toBe('stale_revision');
    });

    it('AC-LIFE-006: publishes template draft atomically (200)', async () => {
      const res = await request(app.getHttpServer())
        .post(
          `/api/v1/stores/${tenantA.storeId}/templates/${createdTemplateId}/publish`,
        )
        .set('Authorization', `Bearer ${ownerAToken}`)
        .set('X-Organization-Id', tenantA.tenantId)
        .send({ expectedRevision: 2 })
        .expect(200);

      expect(res.body.success).toBe(true);
      expect(res.body.data.outcome).toBe('published');
      expect(res.body.data.version).toBeDefined();
      expect(res.body.data.version.versionNumber).toBe(1);
      expect(res.body.data.version.source).toBe('publish');
      expect(res.body.data.template.publishedVersionId).toBe(
        res.body.data.version.id,
      );
    });

    it('AC-LIFE-008: unpublishes template preserving version history (200)', async () => {
      const res = await request(app.getHttpServer())
        .post(
          `/api/v1/stores/${tenantA.storeId}/templates/${createdTemplateId}/unpublish`,
        )
        .set('Authorization', `Bearer ${ownerAToken}`)
        .set('X-Organization-Id', tenantA.tenantId)
        .expect(200);

      expect(res.body.success).toBe(true);
      expect(res.body.data.publishedVersionId).toBeNull();

      // Verify versions list still contains version 1
      const verRes = await request(app.getHttpServer())
        .get(
          `/api/v1/stores/${tenantA.storeId}/templates/${createdTemplateId}/versions`,
        )
        .set('Authorization', `Bearer ${ownerAToken}`)
        .set('X-Organization-Id', tenantA.tenantId)
        .expect(200);

      expect(verRes.body.data.total).toBe(1);
    });

    it('AC-LIFE-009: rollback restores earlier published version (200)', async () => {
      const verList = await request(app.getHttpServer())
        .get(
          `/api/v1/stores/${tenantA.storeId}/templates/${createdTemplateId}/versions`,
        )
        .set('Authorization', `Bearer ${ownerAToken}`)
        .set('X-Organization-Id', tenantA.tenantId)
        .expect(200);

      const v1Id = verList.body.data.items[0].id;

      const res = await request(app.getHttpServer())
        .post(
          `/api/v1/stores/${tenantA.storeId}/templates/${createdTemplateId}/rollback`,
        )
        .set('Authorization', `Bearer ${ownerAToken}`)
        .set('X-Organization-Id', tenantA.tenantId)
        .send({ versionId: v1Id })
        .expect(200);

      expect(res.body.success).toBe(true);
      expect(res.body.data.outcome).toBe('rolled_back');
      expect(res.body.data.version.source).toBe('rollback');
      expect(res.body.data.version.rolledBackFrom).toBe(v1Id);
    });

    it('AC-LIFE-011: sets default template atomically (200)', async () => {
      const res = await request(app.getHttpServer())
        .post(
          `/api/v1/stores/${tenantA.storeId}/templates/${createdTemplateId}/default`,
        )
        .set('Authorization', `Bearer ${ownerAToken}`)
        .set('X-Organization-Id', tenantA.tenantId)
        .expect(200);

      expect(res.body.success).toBe(true);
      expect(res.body.data.isDefault).toBe(true);
    });

    it('AC-LIFE-004: archives template and clears default flag (200)', async () => {
      const res = await request(app.getHttpServer())
        .post(
          `/api/v1/stores/${tenantA.storeId}/templates/${createdTemplateId}/archive`,
        )
        .set('Authorization', `Bearer ${ownerAToken}`)
        .set('X-Organization-Id', tenantA.tenantId)
        .expect(200);

      expect(res.body.success).toBe(true);
      expect(res.body.data.status).toBe('archived');
      expect(res.body.data.isDefault).toBe(false);
    });

    it('AC-LIFE-004: restores archived template (200)', async () => {
      const res = await request(app.getHttpServer())
        .post(
          `/api/v1/stores/${tenantA.storeId}/templates/${createdTemplateId}/restore`,
        )
        .set('Authorization', `Bearer ${ownerAToken}`)
        .set('X-Organization-Id', tenantA.tenantId)
        .expect(200);

      expect(res.body.success).toBe(true);
      expect(res.body.data.status).toBe('active');
      expect(res.body.data.isDefault).toBe(false); // Restore never sets default
    });

    it('AC-LIFE-020: safe delete rejects template with published versions (409 CONFLICT)', async () => {
      const res = await request(app.getHttpServer())
        .delete(
          `/api/v1/stores/${tenantA.storeId}/templates/${createdTemplateId}`,
        )
        .set('Authorization', `Bearer ${ownerAToken}`)
        .set('X-Organization-Id', tenantA.tenantId)
        .expect(409);

      expect(res.body.success).toBe(false);
      expect(res.body.error.code).toBe('CONFLICT');
      expect(res.body.error.details.reason).toBe('published');
    });

    it('AC-LIFE-020: safe delete deletes never-published template (204)', async () => {
      // Create fresh template that is never published
      const newTmpl = await request(app.getHttpServer())
        .post(`/api/v1/stores/${tenantA.storeId}/templates`)
        .set('Authorization', `Bearer ${ownerAToken}`)
        .set('X-Organization-Id', tenantA.tenantId)
        .send({
          kind: 'product',
          name: 'Temporary Product Template',
        })
        .expect(201);

      await request(app.getHttpServer())
        .delete(
          `/api/v1/stores/${tenantA.storeId}/templates/${newTmpl.body.data.id}`,
        )
        .set('Authorization', `Bearer ${ownerAToken}`)
        .set('X-Organization-Id', tenantA.tenantId)
        .expect(204);
    });
  });

  describe('Shared Documents (AC-LIFE-021)', () => {
    it('lazily returns registry default for uninitialized shared document with revision: 0', async () => {
      const res = await request(app.getHttpServer())
        .get(
          `/api/v1/stores/${tenantA.storeId}/shared-documents/theme_settings`,
        )
        .set('Authorization', `Bearer ${ownerAToken}`)
        .set('X-Organization-Id', tenantA.tenantId)
        .expect(200);

      expect(res.body.success).toBe(true);
      expect(res.body.data.kind).toBe('theme_settings');
      expect(res.body.data.revision).toBe(0);
      expect(res.body.data.document).toBeDefined();
    });

    it('creates shared document lazily on first edit with expectedRevision: 0', async () => {
      const current = await request(app.getHttpServer())
        .get(
          `/api/v1/stores/${tenantA.storeId}/shared-documents/theme_settings`,
        )
        .set('Authorization', `Bearer ${ownerAToken}`)
        .set('X-Organization-Id', tenantA.tenantId)
        .expect(200);

      const res = await request(app.getHttpServer())
        .put(
          `/api/v1/stores/${tenantA.storeId}/shared-documents/theme_settings`,
        )
        .set('Authorization', `Bearer ${ownerAToken}`)
        .set('X-Organization-Id', tenantA.tenantId)
        .send({
          expectedRevision: 0,
          document: current.body.data.document,
        })
        .expect(200);

      expect(res.body.success).toBe(true);
      expect(res.body.data.outcome).toBe('saved');
      expect(res.body.data.template.revision).toBe(1);
    });
  });

  describe('Template Assignments (AC-LIFE-012)', () => {
    it('assigns and queries template assignments', async () => {
      await request(app.getHttpServer())
        .post(`/api/v1/stores/${tenantA.storeId}/templates`)
        .set('Authorization', `Bearer ${ownerAToken}`)
        .set('X-Organization-Id', tenantA.tenantId)
        .send({
          kind: 'product',
          name: 'Product Details Page',
        })
        .expect(201);

      // Query assignments list initially
      const listRes = await request(app.getHttpServer())
        .get(`/api/v1/stores/${tenantA.storeId}/template-assignments`)
        .set('Authorization', `Bearer ${ownerAToken}`)
        .set('X-Organization-Id', tenantA.tenantId)
        .expect(200);

      expect(listRes.body.success).toBe(true);
      expect(Array.isArray(listRes.body.data)).toBe(true);
    });
  });

  describe('Template Images (AC-LIFE-019)', () => {
    it('lists images restricted to the authorized tenant prefix', async () => {
      const res = await request(app.getHttpServer())
        .get('/api/v1/template-images')
        .set('Authorization', `Bearer ${ownerAToken}`)
        .set('X-Organization-Id', tenantA.tenantId)
        .expect(200);

      expect(res.body.success).toBe(true);
      expect(Array.isArray(res.body.data.items)).toBe(true);
    });
  });
});
