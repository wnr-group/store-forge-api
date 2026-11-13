import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { dbSchema } from '../src/infrastructure/database/database.types.js';
import { getPresetDocument } from '../src/infrastructure/templates-engine/presets.js';
import { TemplatePublishService } from '../src/modules/templates/services/template-publish.service.js';
import {
  mapTemplateDbError,
  TemplateConflictError,
} from '../src/modules/templates/support/template-errors.js';
import {
  isRealPostgresAvailable,
  REAL_PG_URL,
  setupRealPostgres,
} from './support/database/real-pg-setup.js';

describe('Real PostgreSQL Concurrency Verification (AC-LIFE-013, 014, 017, 018)', () => {
  let isAvailable = false;
  let adminSql: postgres.Sql;

  let tenantId: string;
  let storeId: string;
  let ownerId: string;

  let publishService: TemplatePublishService;

  beforeAll(async () => {
    isAvailable = await isRealPostgresAvailable();
    if (!isAvailable) {
      console.warn(
        'Real PostgreSQL container not reachable. Skipping real concurrency suite.',
      );
      return;
    }

    adminSql = await setupRealPostgres();
    publishService = new TemplatePublishService();

    // Seed test tenant & store
    const userRes = await adminSql`
      INSERT INTO auth.users (email, raw_user_meta_data)
      VALUES ('concurrency.owner@example.test', '{"full_name": "Concurrency Owner"}'::jsonb)
      ON CONFLICT (email) DO UPDATE SET email = EXCLUDED.email
      RETURNING id
    `;
    ownerId = userRes[0].id;

    const tenantRes = await adminSql`
      INSERT INTO tenants (name, slug, status)
      VALUES ('Concurrency Tenant', 'concurrency-tenant', 'active')
      ON CONFLICT (slug) DO UPDATE SET name = EXCLUDED.name
      RETURNING id
    `;
    tenantId = tenantRes[0].id;

    const storeRes = await adminSql`
      INSERT INTO stores (tenant_id, name, slug, status)
      VALUES (${tenantId}, 'Concurrency Store', 'concurrency-store', 'active')
      ON CONFLICT (slug) DO UPDATE SET name = EXCLUDED.name
      RETURNING id
    `;
    storeId = storeRes[0].id;

    await adminSql`
      INSERT INTO memberships (tenant_id, user_id, role, status, permissions)
      VALUES (${tenantId}, ${ownerId}, 'owner', 'active', '{}'::jsonb)
      ON CONFLICT (tenant_id, user_id) DO NOTHING
    `;
  });

  afterAll(async () => {
    if (adminSql) {
      await adminSql.end();
    }
  });

  it('AC-LIFE-017: Concurrent autosaves — winner advances revision, loser receives stale_revision conflict', async () => {
    if (!isAvailable) return;

    // Create a fresh template
    const tmplRows = await adminSql`
      INSERT INTO templates (tenant_id, store_id, kind, name, is_default, draft, revision)
      VALUES (${tenantId}, ${storeId}, 'index', 'Concurrent Save Template', false, ${adminSql.json(getPresetDocument('index', 'classic'))}, 1)
      RETURNING id, draft, revision
    `;
    const templateId = tmplRows[0].id;
    const initialDoc = tmplRows[0].draft;

    const modifiedDoc1 = structuredClone(initialDoc);
    modifiedDoc1.schemaVersion = 1;
    modifiedDoc1.sections = { ...modifiedDoc1.sections };
    const secKey = Object.keys(modifiedDoc1.sections)[0];
    if (secKey) {
      modifiedDoc1.sections[secKey].settings = {
        ...modifiedDoc1.sections[secKey].settings,
        title: 'Title by Connection 1',
      };
    }

    const modifiedDoc2 = structuredClone(initialDoc);
    if (secKey) {
      modifiedDoc2.sections[secKey].settings = {
        ...modifiedDoc2.sections[secKey].settings,
        title: 'Title by Connection 2',
      };
    }

    // Two independent connections
    const conn1 = postgres(REAL_PG_URL, { max: 1 });
    const conn2 = postgres(REAL_PG_URL, { max: 1 });

    try {
      const db1 = drizzle(conn1, { schema: dbSchema });
      const db2 = drizzle(conn2, { schema: dbSchema });

      let c1Won = false;
      let c2FailedWithConflict = false;

      // Conn 1 saves
      await db1.transaction(async (tx1) => {
        const res = await publishService.saveDraft(
          tx1 as never,
          tenantId,
          storeId,
          templateId,
          1,
          modifiedDoc1,
        );
        expect(res.outcome).toBe('saved');
        expect(res.template.revision).toBe(2);
        c1Won = true;
      });

      // Conn 2 attempts with stale revision 1
      try {
        await db2.transaction(async (tx2) => {
          await publishService.saveDraft(
            tx2 as never,
            tenantId,
            storeId,
            templateId,
            1, // Stale!
            modifiedDoc2,
          );
        });
      } catch (err) {
        if (
          err instanceof TemplateConflictError &&
          err.reason === 'stale_revision'
        ) {
          c2FailedWithConflict = true;
        }
      }

      expect(c1Won).toBe(true);
      expect(c2FailedWithConflict).toBe(true);
    } finally {
      await conn1.end();
      await conn2.end();
    }
  });

  it('AC-LIFE-017 & D50/D51: Lock timeout behavior — lock timeout aborts blocked transaction with 55P03 busy conflict', async () => {
    if (!isAvailable) return;

    const tmplRows = await adminSql`
      INSERT INTO templates (tenant_id, store_id, kind, name, is_default, draft, revision)
      VALUES (${tenantId}, ${storeId}, 'index', 'Lock Timeout Template', false, ${adminSql.json(getPresetDocument('index', 'classic'))}, 1)
      RETURNING id
    `;
    const templateId = tmplRows[0].id;

    const conn1 = postgres(REAL_PG_URL, { max: 1 });
    const conn2 = postgres(REAL_PG_URL, { max: 1 });

    const barrierAcquired = new Promise<void>((resolve) => {
      // Conn 1 acquires row lock and holds it
      void conn1.begin(async (sql1) => {
        await sql1`SELECT id FROM templates WHERE id = ${templateId} FOR UPDATE`;
        resolve();
        // Hold lock for 1 second
        await new Promise((r) => setTimeout(r, 1000));
      });
    });

    await barrierAcquired;

    // Conn 2 sets lock_timeout to 100ms and tries to acquire lock
    let caughtBusyError = false;
    try {
      await conn2.begin(async (sql2) => {
        await sql2`SET LOCAL lock_timeout = '100ms'`;
        await sql2`SELECT id FROM templates WHERE id = ${templateId} FOR UPDATE`;
      });
    } catch (err: unknown) {
      const mapped = mapTemplateDbError(err);
      if (mapped instanceof TemplateConflictError && mapped.reason === 'busy') {
        caughtBusyError = true;
      }
    }

    expect(caughtBusyError).toBe(true);

    await conn1.end();
    await conn2.end();
  });

  it('AC-LIFE-018: Publishing transaction failure leaves no partial state', async () => {
    if (!isAvailable) return;

    const tmplRows = await adminSql`
      INSERT INTO templates (tenant_id, store_id, kind, name, is_default, draft, revision)
      VALUES (${tenantId}, ${storeId}, 'index', 'Fault Injection Template', false, ${adminSql.json(getPresetDocument('index', 'classic'))}, 1)
      RETURNING id
    `;
    const templateId = tmplRows[0].id;

    // Count versions before
    const verCountBefore = await adminSql`
      SELECT count(*)::int as count FROM template_versions WHERE template_id = ${templateId}
    `;
    expect(verCountBefore[0].count).toBe(0);

    const conn = postgres(REAL_PG_URL, { max: 1 });
    const db = drizzle(conn, { schema: dbSchema });

    // Intentionally inject an error after publish attempt
    try {
      await db.transaction(async (tx) => {
        await publishService.publish(
          tx as never,
          tenantId,
          storeId,
          templateId,
          1,
        );
        // Force transaction abort
        throw new Error('Simulated crash inside publish transaction');
      });
    } catch {
      // Expected rollback
    } finally {
      await conn.end();
    }

    // Verify zero orphaned versions exist
    const verCountAfter = await adminSql`
      SELECT count(*)::int as count FROM template_versions WHERE template_id = ${templateId}
    `;
    expect(verCountAfter[0].count).toBe(0);

    // Verify template published_version_id is still NULL
    const tmplAfter = await adminSql`
      SELECT published_version_id FROM templates WHERE id = ${templateId}
    `;
    expect(tmplAfter[0].published_version_id).toBeNull();
  });

  it('AC-LIFE-014: Enforces 500-version limit on real PostgreSQL', async () => {
    if (!isAvailable) return;

    const tmplRows = await adminSql`
      INSERT INTO templates (tenant_id, store_id, kind, name, is_default, draft, revision)
      VALUES (${tenantId}, ${storeId}, 'index', 'Version Limit Template', false, ${adminSql.json(getPresetDocument('index', 'classic'))}, 1)
      RETURNING id
    `;
    const templateId = tmplRows[0].id;

    // Fast seed 500 dummy version rows
    await adminSql`
      INSERT INTO template_versions (tenant_id, store_id, template_id, version_number, document, source)
      SELECT 
        ${tenantId}, ${storeId}, ${templateId}, g, '{"schemaVersion": 1, "layout": "classic"}'::jsonb, 'publish'
      FROM generate_series(1, 500) g
    `;

    const countRes = await adminSql`
      SELECT count(*)::int as count FROM template_versions WHERE template_id = ${templateId}
    `;
    expect(countRes[0].count).toBe(500);

    const conn = postgres(REAL_PG_URL, { max: 1 });
    const db = drizzle(conn, { schema: dbSchema });

    // Attempting to publish when 500 versions already exist must fail with quota_exceeded
    let quotaErrorCaught = false;
    try {
      await db.transaction(async (tx) => {
        await publishService.publish(
          tx as never,
          tenantId,
          storeId,
          templateId,
          1,
        );
      });
    } catch (err) {
      if (
        err instanceof TemplateConflictError &&
        err.reason === 'quota_exceeded'
      ) {
        quotaErrorCaught = true;
      }
    } finally {
      await conn.end();
    }

    expect(quotaErrorCaught).toBe(true);
  });
});
