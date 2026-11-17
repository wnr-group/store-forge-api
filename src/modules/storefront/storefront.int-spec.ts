import { ConfigModule } from '@nestjs/config';
import { Test, type TestingModule } from '@nestjs/testing';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  createTestDatabase,
  type TestDatabase,
} from '../../../test/support/database/create-test-database.js';
import {
  createUser,
  createTenantWithOwner,
  withSuperuser,
} from '../../../test/support/database/fixtures.js';
import { DatabaseModule } from '../../database/database.module.js';
import { DatabaseService } from '../../database/database.service.js';
import { rowsOf } from '../../database/user-context.js';
import { StorefrontModule } from './storefront.module.js';
import { StorefrontService } from './storefront.service.js';
import {
  layoutPayloadSchema,
  publicCollectionPayloadSchema,
  publicCollectionsListSchema,
  publicProductPayloadSchema,
  storefrontSchema,
} from './storefront.schemas.js';

describe('Public Storefront Database Contract Suite (PR-D, T-D1)', () => {
  let testDb: TestDatabase;
  let moduleRef: TestingModule;
  let dbService: DatabaseService;
  let storefrontService: StorefrontService;

  let ownerId: string;
  let tenantA: { tenantId: string; storeId: string; storeSlug: string };
  let tenantSuspended: { tenantId: string; storeId: string; storeSlug: string };

  let activeProductId: string;
  let relatedProductId: string;
  let collectionId: string;
  let assignedTemplateId: string;
  let defaultTemplateId: string;

  beforeAll(async () => {
    testDb = await createTestDatabase();

    ownerId = await createUser(testDb.pg, {
      email: 'owner@example.test',
      fullName: 'Store Owner',
    });

    // 1. Active Tenant and Store
    tenantA = await createTenantWithOwner(testDb.pg, {
      ownerId,
      storeSlug: 'store-alpha',
      tenantName: 'Alpha Corp',
      storeName: 'Alpha Store',
    });

    // 2. Suspended Tenant
    tenantSuspended = await createTenantWithOwner(testDb.pg, {
      ownerId,
      storeSlug: 'store-suspended',
      tenantName: 'Suspended Corp',
      storeName: 'Suspended Store',
    });

    await withSuperuser(testDb.pg, async () => {
      // Mark suspended tenant
      await testDb.pg.query(
        "update public.tenants set status = 'suspended' where id = $1",
        [tenantSuspended.tenantId],
      );

      // Create an inactive store in active tenantA
      await testDb.pg.query(
        "insert into public.stores (tenant_id, name, slug, status) values ($1, 'Inactive Store', 'store-inactive', 'inactive')",
        [tenantA.tenantId],
      );

      // Store template settings for store-alpha
      await testDb.pg.query(
        `insert into public.store_template_settings (store_id, tenant_id, template_key, accent_color, hero_heading, hero_subheading, hero_image_path)
         values ($1, $2, 'minimal', '#112233', 'Alpha Hero', 'Welcome to Alpha Store', $3)`,
        [
          tenantA.storeId,
          tenantA.tenantId,
          `${tenantA.tenantId}/store/hero.jpg`,
        ],
      );

      // Category
      const catRes = await testDb.pg.query<{ id: string }>(
        "insert into public.categories (tenant_id, name, slug) values ($1, 'Apparel', 'apparel') returning id",
        [tenantA.tenantId],
      );
      const catId = catRes.rows[0].id;

      // Active Product 1 (main product)
      const p1Res = await testDb.pg.query<{ id: string }>(
        `insert into public.products (
           tenant_id, category_id, name, slug, description, short_description, product_type, sku, price_minor, compare_at_price_minor, cost_minor, has_variants, quantity, status
         ) values (
           $1, $2, 'Alpha Tee', 'alpha-tee', 'Full description of alpha tee', 'Short alpha tee', 'T-Shirt', 'ALPHA-TEE-01', 199900, 249900, 50000, true, 100, 'active'
         ) returning id`,
        [tenantA.tenantId, catId],
      );
      activeProductId = p1Res.rows[0].id;

      // Product 1 Images (1 primary, 1 secondary)
      await testDb.pg.query(
        `insert into public.product_images (tenant_id, product_id, storage_path, alt_text, position, is_primary, mime_type, size_bytes)
         values ($1, $2, $3, 'Alpha Tee Front', 0, true, 'image/jpeg', 12345)`,
        [
          tenantA.tenantId,
          activeProductId,
          `${tenantA.tenantId}/${activeProductId}/front.jpg`,
        ],
      );
      const img2Res = await testDb.pg.query<{ id: string }>(
        `insert into public.product_images (tenant_id, product_id, storage_path, alt_text, position, is_primary, mime_type, size_bytes)
         values ($1, $2, $3, 'Alpha Tee Back', 1, false, 'image/jpeg', 23456) returning id`,
        [
          tenantA.tenantId,
          activeProductId,
          `${tenantA.tenantId}/${activeProductId}/back.jpg`,
        ],
      );
      const img2Id = img2Res.rows[0].id;

      // Product 1 Options (Size)
      await testDb.pg.query(
        `insert into public.product_options (tenant_id, product_id, name, position, "values")
         values ($1, $2, 'Size', 0, ARRAY['S', 'M', 'L'])`,
        [tenantA.tenantId, activeProductId],
      );

      // Product 1 Variants (1 active, 1 inactive)
      await testDb.pg.query(
        `insert into public.product_variants (tenant_id, product_id, title, options, sku, price_minor, compare_at_price_minor, image_id, position, is_active)
         values ($1, $2, 'Alpha Tee - S', '{"Size": "S"}'::jsonb, 'ALPHA-TEE-S', 199900, 249900, $3, 0, true)`,
        [tenantA.tenantId, activeProductId, img2Id],
      );
      await testDb.pg.query(
        `insert into public.product_variants (tenant_id, product_id, title, options, sku, price_minor, compare_at_price_minor, image_id, position, is_active)
         values ($1, $2, 'Alpha Tee - M (Inactive)', '{"Size": "M"}'::jsonb, 'ALPHA-TEE-M', 199900, 249900, null, 1, false)`,
        [tenantA.tenantId, activeProductId],
      );

      // Related Active Product 2 (same category)
      const p2Res = await testDb.pg.query<{ id: string }>(
        `insert into public.products (
           tenant_id, category_id, name, slug, description, short_description, product_type, sku, price_minor, status
         ) values (
           $1, $2, 'Alpha Hoodie', 'alpha-hoodie', 'Cozy hoodie', 'Warm alpha hoodie', 'Hoodie', 'ALPHA-HD-01', 399900, 'active'
         ) returning id`,
        [tenantA.tenantId, catId],
      );
      relatedProductId = p2Res.rows[0].id;

      // Draft Product (must never be returned in public endpoints)
      await testDb.pg.query(
        `insert into public.products (
           tenant_id, category_id, name, slug, description, short_description, product_type, sku, price_minor, status
         ) values (
           $1, $2, 'Alpha Secret Draft', 'alpha-secret-draft', 'Draft product', 'Not yet released', 'Special', 'ALPHA-DRAFT', 999900, 'draft'
         )`,
        [tenantA.tenantId, catId],
      );

      // Active Collection
      const c1Res = await testDb.pg.query<{ id: string }>(
        `insert into public.collections (tenant_id, name, slug, description, image_path, status)
         values ($1, 'Alpha Summer', 'alpha-summer', 'Summer catalog', null, 'active') returning id`,
        [tenantA.tenantId],
      );
      collectionId = c1Res.rows[0].id;

      // Associate Active Products to Collection
      await testDb.pg.query(
        `insert into public.collection_products (collection_id, product_id, tenant_id, position)
         values ($1, $2, $3, 0), ($1, $4, $3, 1)`,
        [collectionId, activeProductId, tenantA.tenantId, relatedProductId],
      );

      // Draft Collection
      await testDb.pg.query(
        `insert into public.collections (tenant_id, name, slug, description, status)
         values ($1, 'Draft Collection', 'draft-collection', 'Draft only', 'draft')`,
        [tenantA.tenantId],
      );

      // Templates Setup:
      // Default product template
      const defaultTmplRes = await testDb.pg.query<{ id: string }>(
        `insert into public.templates (tenant_id, store_id, kind, name, is_default, draft, status)
         values ($1, $2, 'product', 'Default Product Template', true, '{"schemaVersion": 1}'::jsonb, 'active') returning id`,
        [tenantA.tenantId, tenantA.storeId],
      );
      defaultTemplateId = defaultTmplRes.rows[0].id;
      const defVerRes = await testDb.pg.query<{ id: string }>(
        `insert into public.template_versions (tenant_id, store_id, template_id, version_number, document, source)
         values ($1, $2, $3, 1, '{"schemaVersion": 1, "sections": {"def": {"type": "default-view"}}}'::jsonb, 'publish') returning id`,
        [tenantA.tenantId, tenantA.storeId, defaultTemplateId],
      );
      await testDb.pg.query(
        'update public.templates set published_version_id = $1 where id = $2',
        [defVerRes.rows[0].id, defaultTemplateId],
      );

      // Assigned product template for activeProductId
      const assignedTmplRes = await testDb.pg.query<{ id: string }>(
        `insert into public.templates (tenant_id, store_id, kind, name, is_default, draft, status)
         values ($1, $2, 'product', 'Assigned Product Template', false, '{"schemaVersion": 1}'::jsonb, 'active') returning id`,
        [tenantA.tenantId, tenantA.storeId],
      );
      assignedTemplateId = assignedTmplRes.rows[0].id;
      const assVerRes = await testDb.pg.query<{ id: string }>(
        `insert into public.template_versions (tenant_id, store_id, template_id, version_number, document, source)
         values ($1, $2, $3, 1, '{"schemaVersion": 1, "sections": {"custom": {"type": "assigned-view"}}}'::jsonb, 'publish') returning id`,
        [tenantA.tenantId, tenantA.storeId, assignedTemplateId],
      );
      await testDb.pg.query(
        'update public.templates set published_version_id = $1 where id = $2',
        [assVerRes.rows[0].id, assignedTemplateId],
      );

      // Create assignment
      await testDb.pg.query(
        `insert into public.template_assignments (tenant_id, store_id, template_id, template_kind, product_id)
         values ($1, $2, $3, 'product', $4)`,
        [
          tenantA.tenantId,
          tenantA.storeId,
          assignedTemplateId,
          activeProductId,
        ],
      );

      // Theme settings template
      const themeRes = await testDb.pg.query<{ id: string }>(
        `insert into public.templates (tenant_id, store_id, kind, name, is_default, draft, status)
         values ($1, $2, 'theme_settings', 'Store Theme', false, '{"schemaVersion": 1}'::jsonb, 'active') returning id`,
        [tenantA.tenantId, tenantA.storeId],
      );
      const themeVerRes = await testDb.pg.query<{ id: string }>(
        `insert into public.template_versions (tenant_id, store_id, template_id, version_number, document, source)
         values ($1, $2, $3, 1, '{"schemaVersion": 1, "settings": {"primaryColor": "#ff0000"}}'::jsonb, 'publish') returning id`,
        [tenantA.tenantId, tenantA.storeId, themeRes.rows[0].id],
      );
      await testDb.pg.query(
        'update public.templates set published_version_id = $1 where id = $2',
        [themeVerRes.rows[0].id, themeRes.rows[0].id],
      );

      // Group header
      const headerRes = await testDb.pg.query<{ id: string }>(
        `insert into public.templates (tenant_id, store_id, kind, name, is_default, draft, status)
         values ($1, $2, 'group_header', 'Main Header', false, '{"schemaVersion": 1}'::jsonb, 'active') returning id`,
        [tenantA.tenantId, tenantA.storeId],
      );
      const headerVerRes = await testDb.pg.query<{ id: string }>(
        `insert into public.template_versions (tenant_id, store_id, template_id, version_number, document, source)
         values ($1, $2, $3, 1, '{"schemaVersion": 1, "sections": {"hdr": {"type": "header-bar"}}}'::jsonb, 'publish') returning id`,
        [tenantA.tenantId, tenantA.storeId, headerRes.rows[0].id],
      );
      await testDb.pg.query(
        'update public.templates set published_version_id = $1 where id = $2',
        [headerVerRes.rows[0].id, headerRes.rows[0].id],
      );
    });

    moduleRef = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({
          isGlobal: true,
          load: [
            () => ({
              databaseUrl: testDb.url,
            }),
          ],
        }),
        DatabaseModule,
        StorefrontModule,
      ],
    }).compile();

    await moduleRef.init();
    dbService = moduleRef.get(DatabaseService);
    storefrontService = moduleRef.get(StorefrontService);
  });

  afterAll(async () => {
    if (moduleRef) {
      await moduleRef.close();
    }
    if (testDb) {
      await testDb.close();
    }
  });

  // ===========================================================================
  // AC-D-01: All five operations implemented & return correct payloads
  // ===========================================================================

  it('AC-D-01: get_public_storefront returns active store and products matching storefrontSchema', async () => {
    await dbService.withPublic(async (tx) => {
      const rows = rowsOf<{ s: unknown }>(
        await tx.execute(
          sql`select public.get_public_storefront(${tenantA.storeSlug}) as s`,
        ),
      );
      expect(rows[0]?.s).toBeDefined();
      const payload = rows[0].s;

      const parsed = storefrontSchema.parse(payload);
      expect(parsed.name).toBe('Alpha Store');
      expect(parsed.slug).toBe('store-alpha');
      expect(parsed.products.length).toBeGreaterThanOrEqual(2);
      expect(parsed.products.some((p) => p.slug === 'alpha-tee')).toBe(true);
      expect(parsed.products.some((p) => p.slug === 'alpha-secret-draft')).toBe(
        false,
      );
      expect(parsed.template?.key).toBe('minimal');
      expect(parsed.template?.hero_heading).toBe('Alpha Hero');
    });
  });

  it('AC-D-01: get_public_template_layout returns assigned template when assigned to product', async () => {
    await dbService.withPublic(async (tx) => {
      const rows = rowsOf<{ l: unknown }>(
        await tx.execute(
          sql`select public.get_public_template_layout(${tenantA.storeSlug}, 'product', 'alpha-tee') as l`,
        ),
      );
      expect(rows[0]?.l).toBeDefined();
      const parsed = layoutPayloadSchema.parse(rows[0].l);

      expect(parsed.source).toBe('assigned');
      expect(parsed.template?.name).toBe('Assigned Product Template');
      expect(parsed.theme).toBeDefined();
      expect(parsed.groups?.header).toBeDefined();
    });
  });

  it('AC-D-01: get_public_template_layout returns default template when unassigned', async () => {
    await dbService.withPublic(async (tx) => {
      const rows = rowsOf<{ l: unknown }>(
        await tx.execute(
          sql`select public.get_public_template_layout(${tenantA.storeSlug}, 'product', 'alpha-hoodie') as l`,
        ),
      );
      expect(rows[0]?.l).toBeDefined();
      const parsed = layoutPayloadSchema.parse(rows[0].l);

      expect(parsed.source).toBe('default');
      expect(parsed.template?.name).toBe('Default Product Template');
    });
  });

  it('AC-D-01: get_public_product returns product, primary image, options, active variants only, and related', async () => {
    await dbService.withPublic(async (tx) => {
      const rows = rowsOf<{ p: unknown }>(
        await tx.execute(
          sql`select public.get_public_product(${tenantA.storeSlug}, 'alpha-tee') as p`,
        ),
      );
      expect(rows[0]?.p).toBeDefined();
      const parsed = publicProductPayloadSchema.parse(rows[0].p);

      expect(parsed.store.slug).toBe('store-alpha');
      expect(parsed.product.slug).toBe('alpha-tee');
      expect(parsed.product.sku).toBe('ALPHA-TEE-01');
      expect(parsed.product.has_variants).toBe(true);
      expect(parsed.images).toHaveLength(2);
      expect(parsed.images[0].is_primary).toBe(true);
      expect(parsed.options).toHaveLength(1);
      expect(parsed.options[0].name).toBe('Size');
      expect(parsed.variants).toHaveLength(1);
      expect(parsed.variants[0].sku).toBe('ALPHA-TEE-S');
      expect(parsed.related).toHaveLength(1);
      expect(parsed.related[0].slug).toBe('alpha-hoodie');
    });
  });

  it('AC-D-01: get_public_collection returns collection details and products in position order', async () => {
    await dbService.withPublic(async (tx) => {
      const rows = rowsOf<{ c: unknown }>(
        await tx.execute(
          sql`select public.get_public_collection(${tenantA.storeSlug}, 'alpha-summer') as c`,
        ),
      );
      expect(rows[0]?.c).toBeDefined();
      const parsed = publicCollectionPayloadSchema.parse(rows[0].c);

      expect(parsed.store.slug).toBe('store-alpha');
      expect(parsed.collection.slug).toBe('alpha-summer');
      expect(parsed.products).toHaveLength(2);
      expect(parsed.products[0].slug).toBe('alpha-tee');
      expect(parsed.products[1].slug).toBe('alpha-hoodie');
    });
  });

  it('AC-D-01: get_public_collections returns active collections with product counts and excludes drafts', async () => {
    await dbService.withPublic(async (tx) => {
      const rows = rowsOf<{ cols: unknown }>(
        await tx.execute(
          sql`select public.get_public_collections(${tenantA.storeSlug}) as cols`,
        ),
      );
      expect(rows[0]?.cols).toBeDefined();
      const parsed = publicCollectionsListSchema.parse(rows[0].cols);

      expect(parsed).toHaveLength(1);
      expect(parsed[0].slug).toBe('alpha-summer');
      expect(parsed[0].product_count).toBe(2);
      expect(parsed.some((c) => c.slug === 'draft-collection')).toBe(false);
    });
  });

  // ===========================================================================
  // AC-D-02: No user session required (zero claims inside withPublic)
  // ===========================================================================

  it('AC-D-02: withPublic has zero JWT claims and cannot read direct tenant tables, but public functions succeed', async () => {
    await dbService.withPublic(async (tx) => {
      const claimsRow = rowsOf<{ claims: string }>(
        await tx.execute(
          sql`select current_setting('request.jwt.claims', true) as claims`,
        ),
      );
      expect(claimsRow[0].claims).toBe('');

      // Direct RLS query sees 0 rows
      const directStores = rowsOf<{ count: number }>(
        await tx.execute(sql`select count(*)::int as count from public.stores`),
      );
      expect(directStores[0].count).toBe(0);

      // Public functions succeed without session
      const storeRes = rowsOf<{ s: unknown }>(
        await tx.execute(
          sql`select public.get_public_storefront(${tenantA.storeSlug}) as s`,
        ),
      );
      expect(storeRes[0]?.s).not.toBeNull();
    });
  });

  // ===========================================================================
  // AC-D-04: Cutover gate fails closed
  // ===========================================================================

  it('AC-D-04: template_engine_cutover_complete() returns false when pending and true when complete with valid completed_at and verified_stores', async () => {
    await dbService.withPublic(async (tx) => {
      // 1. Initial state is 'pending' -> false
      const initial = rowsOf<{ ok: boolean }>(
        await tx.execute(
          sql`select public.template_engine_cutover_complete() as ok`,
        ),
      );
      expect(initial[0].ok).toBe(false);
    });

    // 2. Update to complete with superuser
    await withSuperuser(testDb.pg, async () => {
      await testDb.pg.query(
        `update public.template_engine_cutover
         set status = 'complete', completed_at = now(), verified_stores = 1
         where id = true`,
      );
    });

    await dbService.withPublic(async (tx) => {
      const complete = rowsOf<{ ok: boolean }>(
        await tx.execute(
          sql`select public.template_engine_cutover_complete() as ok`,
        ),
      );
      expect(complete[0].ok).toBe(true);
    });

    // 3. Reset back to pending for other tests
    await withSuperuser(testDb.pg, async () => {
      await testDb.pg.query(
        `update public.template_engine_cutover
         set status = 'pending', completed_at = null, verified_stores = null
         where id = true`,
      );
    });
  });

  // ===========================================================================
  // AC-D-05: Indistinguishability (unknown, inactive, suspended, malformed)
  // ===========================================================================

  it('AC-D-05: unknown, inactive, suspended, and malformed slugs return identical NULL across all 5 functions', async () => {
    const invalidSlugs = [
      'unknown-store-xyz',
      'store-inactive',
      'store-suspended',
      'INVALID_SLUG_UPPERCASE!',
      'slug with spaces',
      '',
      '..',
    ];

    await dbService.withPublic(async (tx) => {
      for (const slug of invalidSlugs) {
        // 1. get_public_storefront
        const sf = rowsOf<{ r: unknown }>(
          await tx.execute(
            sql`select public.get_public_storefront(${slug}) as r`,
          ),
        )[0]?.r;
        expect(sf).toBeNull();

        // 2. get_public_template_layout
        const tl = rowsOf<{ r: unknown }>(
          await tx.execute(
            sql`select public.get_public_template_layout(${slug}, 'index', null) as r`,
          ),
        )[0]?.r;
        expect(tl).toBeNull();

        // 3. get_public_product
        const pr = rowsOf<{ r: unknown }>(
          await tx.execute(
            sql`select public.get_public_product(${slug}, 'alpha-tee') as r`,
          ),
        )[0]?.r;
        expect(pr).toBeNull();

        // 4. get_public_collection
        const cl = rowsOf<{ r: unknown }>(
          await tx.execute(
            sql`select public.get_public_collection(${slug}, 'alpha-summer') as r`,
          ),
        )[0]?.r;
        expect(cl).toBeNull();

        // 5. get_public_collections
        const cls = rowsOf<{ r: unknown }>(
          await tx.execute(
            sql`select public.get_public_collections(${slug}) as r`,
          ),
        )[0]?.r;
        expect(cls).toBeNull();
      }
    });
  });

  // ===========================================================================
  // AC-D-05: Security / Forbidden-key scan
  // ===========================================================================

  it('AC-D-05: security scan: no response contains private tenant, store, user, cost, or inventory fields', async () => {
    const forbiddenSubstrings = [
      'tenant_id',
      'store_id',
      'user_id',
      'owner',
      'email',
      'cost_minor',
      'cost',
      'track_inventory',
      'low_stock_threshold',
      'alpha-secret-draft',
      'draft-collection',
    ];

    await dbService.withPublic(async (tx) => {
      const payloads = await Promise.all([
        tx.execute(
          sql`select public.get_public_storefront(${tenantA.storeSlug}) as r`,
        ),
        tx.execute(
          sql`select public.get_public_template_layout(${tenantA.storeSlug}, 'product', 'alpha-tee') as r`,
        ),
        tx.execute(
          sql`select public.get_public_product(${tenantA.storeSlug}, 'alpha-tee') as r`,
        ),
        tx.execute(
          sql`select public.get_public_collection(${tenantA.storeSlug}, 'alpha-summer') as r`,
        ),
        tx.execute(
          sql`select public.get_public_collections(${tenantA.storeSlug}) as r`,
        ),
      ]);

      for (const res of payloads) {
        const raw = rowsOf<{ r: unknown }>(res)[0]?.r;
        expect(raw).toBeDefined();
        const jsonStr = JSON.stringify(raw);

        for (const forbidden of forbiddenSubstrings) {
          expect(jsonStr).not.toContain(`"${forbidden}"`);
          expect(jsonStr).not.toContain(forbidden);
        }
      }
    });
  });

  // ===========================================================================
  // T-D3: StorefrontService End-to-End Integration Tests
  // ===========================================================================

  describe('StorefrontService integration through NestJS DI (T-D3)', () => {
    it('getStorefront returns parsed storefront when cutover gate is pending (ungated)', async () => {
      const sf = await storefrontService.getStorefront(tenantA.storeSlug);
      expect(sf).not.toBeNull();
      expect(sf?.name).toBe('Alpha Store');
      expect(sf?.slug).toBe('store-alpha');
      expect(sf?.template?.key).toBe('minimal');
    });

    it('gated methods return null when cutover gate is pending (AC-D-04, PD-O1)', async () => {
      expect(await storefrontService.isEngineReadEnabled()).toBe(false);

      expect(
        await storefrontService.getTemplateLayout(
          tenantA.storeSlug,
          'product',
          'alpha-tee',
        ),
      ).toBeNull();
      expect(
        await storefrontService.getProduct(tenantA.storeSlug, 'alpha-tee'),
      ).toBeNull();
      expect(
        await storefrontService.getCollection(
          tenantA.storeSlug,
          'alpha-summer',
        ),
      ).toBeNull();
      expect(
        await storefrontService.getCollections(tenantA.storeSlug),
      ).toBeNull();
    });

    it('gated methods return full payloads when cutover gate is complete', async () => {
      // Open the gate
      await withSuperuser(testDb.pg, async () => {
        await testDb.pg.query(
          `update public.template_engine_cutover
           set status = 'complete', completed_at = now(), verified_stores = 1
           where id = true`,
        );
      });

      try {
        expect(await storefrontService.isEngineReadEnabled()).toBe(true);

        const layout = await storefrontService.getTemplateLayout(
          tenantA.storeSlug,
          'product',
          'alpha-tee',
        );
        expect(layout).not.toBeNull();
        expect(layout?.source).toBe('assigned');
        expect(layout?.template?.name).toBe('Assigned Product Template');

        const product = await storefrontService.getProduct(
          tenantA.storeSlug,
          'alpha-tee',
        );
        expect(product).not.toBeNull();
        expect(product?.product.slug).toBe('alpha-tee');
        expect(product?.variants).toHaveLength(1);

        const collection = await storefrontService.getCollection(
          tenantA.storeSlug,
          'alpha-summer',
        );
        expect(collection).not.toBeNull();
        expect(collection?.collection.slug).toBe('alpha-summer');
        expect(collection?.products).toHaveLength(2);

        const collections = await storefrontService.getCollections(
          tenantA.storeSlug,
        );
        expect(collections).not.toBeNull();
        expect(collections).toHaveLength(1);
        expect(collections?.[0].slug).toBe('alpha-summer');
      } finally {
        // Reset gate to pending
        await withSuperuser(testDb.pg, async () => {
          await testDb.pg.query(
            `update public.template_engine_cutover
             set status = 'pending', completed_at = null, verified_stores = null
             where id = true`,
          );
        });
      }
    });
  });
});
