import type { INestApplication } from '@nestjs/common';
import SwaggerParser from '@apidevtools/swagger-parser';
import AjvModule from 'ajv';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestApp } from './support/create-test-app.js';
import {
  createTestDatabase,
  type TestDatabase,
} from './support/database/create-test-database.js';
import { ProbeModule } from './support/probe/probe.module.js';
import { extractRouteInventory } from './support/route-inventory.js';

const Ajv =
  (AjvModule as unknown as { default: new (opts?: unknown) => any }).default ??
  (AjvModule as unknown as new (opts?: unknown) => any);

describe('Swagger Documentation and OpenAPI Contracts (AC-B-89 to AC-B-94, SWG)', () => {
  let app: INestApplication;
  let testDb: TestDatabase;
  let spec: Record<string, any>;

  beforeAll(async () => {
    testDb = await createTestDatabase();
    process.env.DATABASE_URL = testDb.url;
    process.env.DB_POOL_MAX = '1';
    process.env.DB_PREPARE = 'false';
    process.env.SWAGGER_ENABLED = 'true';

    app = await createTestApp({
      modules: [ProbeModule],
    });

    const res = await request(app.getHttpServer())
      .get('/api/docs-json')
      .expect(200);

    spec = res.body;
  });

  afterAll(async () => {
    await app.close();
    await testDb.close();
  });

  it('AC-B-89: Swagger starts; /api/docs and /api/docs-json respond with valid info', async () => {
    await request(app.getHttpServer()).get('/api/docs').expect(200);

    expect(spec.openapi).toMatch(/^3\./);
    expect(spec.info.title).toBe('Store Forge API');
    expect(spec.info.version).toBe('0.1.0');
    expect(spec.info.description).toContain('Supabase Auth ES256 JWT');
    expect(spec.info.description).toContain('X-Tenant-Id');
    expect(spec.info.description).toContain('Next.js caller convention');
  });

  it('AC-B-90: generated spec is valid OpenAPI', async () => {
    // Validate the spec against the OpenAPI 3.0 specification
    const validated = await SwaggerParser.validate(
      JSON.parse(JSON.stringify(spec)),
    );
    expect(validated).toBeDefined();
    expect(validated.info.title).toBe('Store Forge API');
  });

  it('AC-B-91: every registered controller route appears in the spec', () => {
    const routes = extractRouteInventory(app).filter((r) =>
      r.path.startsWith('/api/v1'),
    );
    expect(routes.length).toBeGreaterThan(0);

    for (const route of routes) {
      // Convert express route param :id to OpenAPI {id}
      const openApiPath = route.path.replace(/:([a-zA-Z0-9_]+)/g, '{$1}');
      const pathItem = spec.paths[openApiPath];

      expect(
        pathItem,
        `Expected route ${route.method} ${openApiPath} to be documented in Swagger`,
      ).toBeDefined();

      const operation = pathItem[route.method.toLowerCase()];
      expect(
        operation,
        `Expected operation ${route.method} on ${openApiPath} to be documented in Swagger`,
      ).toBeDefined();
    }
  });

  it('AC-B-92: public routes have no security; authenticated routes require Bearer; tenant routes require X-Tenant-Id and document x-permission', () => {
    // 1. Public route
    const healthGet = spec.paths['/api/v1/health'].get;
    expect(healthGet['x-public']).toBe(true);
    expect(healthGet.security).toBeUndefined();

    const readyGet = spec.paths['/api/v1/health/ready'].get;
    expect(readyGet['x-public']).toBe(true);
    expect(readyGet.security).toBeUndefined();

    // 2. Authenticated route without tenant
    const noTenantGet = spec.paths['/api/v1/probe/no-tenant'].get;
    expect(noTenantGet.security).toEqual([{ bearer: [] }]);
    const noTenantHeaders = (noTenantGet.parameters ?? []).filter(
      (p: { in: string; name: string }) =>
        p.in === 'header' && p.name.toLowerCase() === 'x-tenant-id',
    );
    expect(noTenantHeaders.length).toBe(0);

    // 3. Tenant route
    const defaultGet = spec.paths['/api/v1/probe/default'].get;
    expect(defaultGet.security).toEqual([{ bearer: [] }]);
    const tenantHeader = (defaultGet.parameters ?? []).find(
      (p: { in: string; name: string }) =>
        p.in === 'header' && p.name === 'X-Tenant-Id',
    );
    expect(tenantHeader).toBeDefined();
    expect(tenantHeader.required).toBe(true);
    expect(tenantHeader.schema).toEqual({ type: 'string', format: 'uuid' });

    // 4. Permission route with x-permission extension
    const permissionGet = spec.paths['/api/v1/probe/permission'].get;
    expect(permissionGet['x-permission']).toBe('catalog:view');
    expect(permissionGet.security).toEqual([{ bearer: [] }]);
  });

  it('AC-B-93: health and probe responses validate against published schemas (ajv)', async () => {
    const AjvConstructor = Ajv as unknown as new (
      opts?: Record<string, unknown>,
    ) => {
      compile: (schema: unknown) => (data: unknown) => boolean;
      addSchema: (schema: unknown, key: string) => void;
    };
    const ajv = new AjvConstructor({ allErrors: true, strict: false });

    // Register all component schemas in Ajv
    if (spec.components?.schemas) {
      for (const [name, schema] of Object.entries(spec.components.schemas)) {
        ajv.addSchema(schema as object, `#/components/schemas/${name}`);
      }
    }

    // 1. Validate GET /api/v1/health response
    const healthRes = await request(app.getHttpServer())
      .get('/api/v1/health')
      .expect(200);

    const healthSchema =
      spec.paths['/api/v1/health'].get.responses['200'].content[
        'application/json'
      ].schema;
    const validateHealth = ajv.compile(healthSchema);
    const validHealth = validateHealth(healthRes.body);
    expect(validHealth).toBe(true);

    // 2. Validate GET /api/v1/health/ready response
    const readyRes = await request(app.getHttpServer())
      .get('/api/v1/health/ready')
      .expect(200);

    const readySchema =
      spec.paths['/api/v1/health/ready'].get.responses['200'].content[
        'application/json'
      ].schema;
    const validateReady = ajv.compile(readySchema);
    const validReady = validateReady(readyRes.body);
    expect(validReady).toBe(true);

    // 3. Validate GET /api/v1/probe/items response
    const itemsRes = await request(app.getHttpServer())
      .get('/api/v1/probe/items')
      .expect(200);

    const itemsSchema =
      spec.paths['/api/v1/probe/items'].get.responses['200'].content[
        'application/json'
      ].schema;
    const validateItems = ajv.compile(itemsSchema);
    const validItems = validateItems(itemsRes.body);
    expect(validItems).toBe(true);

    // 4. Validate Error response against ErrorResponseDto schema
    const errorRes = await request(app.getHttpServer())
      .get('/api/v1/nope')
      .expect(404);

    const errorSchema = spec.components.schemas.ErrorResponseDto;
    const validateError = ajv.compile(errorSchema);
    const validError = validateError(errorRes.body);
    expect(validError).toBe(true);
  });

  it('AC-B-94: error and paged schemas documented once and referenced; page/pageSize documented', () => {
    // Component schemas exist
    expect(spec.components.schemas.ErrorResponseDto).toBeDefined();
    expect(spec.components.schemas.PagedResponseDto).toBeDefined();
    expect(spec.components.schemas.ProbeItemDto).toBeDefined();

    // GET /api/v1/probe/items parameters
    const itemsGet = spec.paths['/api/v1/probe/items'].get;
    const parameters = itemsGet.parameters as Array<{
      name: string;
      in: string;
      required: boolean;
      schema: { type: string; enum?: number[]; example?: number };
    }>;

    const pageParam = parameters.find((p) => p.name === 'page');
    expect(pageParam).toBeDefined();
    expect(pageParam?.in).toBe('query');
    expect(pageParam?.required).toBe(false);

    const pageSizeParam = parameters.find((p) => p.name === 'pageSize');
    expect(pageSizeParam).toBeDefined();
    expect(pageSizeParam?.in).toBe('query');
    expect(pageSizeParam?.required).toBe(false);
    expect(pageSizeParam?.schema.enum).toEqual([10, 20, 50, 100]);
  });
});
