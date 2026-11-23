import { readFileSync, writeFileSync } from 'node:fs';
import { Test } from '@nestjs/testing';
import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import type { App } from 'supertest/types.js';
import { AppModule } from '../src/app.module.js';
import { configureApp } from '../src/app.setup.js';

type Operation = {
  summary?: string;
  description?: string;
  tags?: string[];
  security?: unknown[];
  parameters?: { in: string; name: string; required?: boolean }[];
  requestBody?: unknown;
  responses?: Record<string, { description?: string; content?: unknown }>;
};

const METHODS = ['get', 'post', 'patch', 'put', 'delete'] as const;

const PUBLIC_ROUTES = new Set([
  'GET /api/v1/health',
  'GET /api/v1/health/ready',
  'POST /api/v1/auth/login',
  'POST /api/v1/auth/logout',
  'POST /api/v1/auth/refresh',
  'GET /api/v1/public/branding',
  'GET /api/v1/public/hosts/{subdomain}',
  'GET /api/v1/public/storefronts/{slug}',
  'GET /api/v1/public/storefronts/{slug}/layout',
  'GET /api/v1/public/storefronts/{slug}/collections',
  'GET /api/v1/public/storefronts/{slug}/collections/{collectionSlug}',
  'GET /api/v1/public/storefronts/{slug}/products/{productSlug}',
  'GET /api/v1/public/storefronts/{slug}/pages',
  'GET /api/v1/public/storefronts/{slug}/pages/{pageSlug}',
  'GET /api/v1/public/storefronts/{slug}/products/{productSlug}/reviews',
  'GET /api/v1/public/storefronts/{slug}/recommendations',
  'GET /api/v1/public/storefronts/{slug}/landing-pages/{pageSlug}',
  'POST /api/v1/public/vitals',
]);

/**
 * The routes docs/API_ENDPOINT_INVENTORY.md lists, as `METHOD /api/v1/path/{param}`. A row's query-string suffix is not part of
 * the route, and `:param` is how the inventory (and Express) spell what OpenAPI spells `{param}`.
 */
const inventoryRoutes = (): string[] =>
  [
    ...readFileSync('docs/API_ENDPOINT_INVENTORY.md', 'utf8').matchAll(
      /(GET|POST|PATCH|PUT|DELETE) `(\/[^`?]*)/g,
    ),
  ].map(
    ([, method, path]) => `${method} /api/v1${path.replace(/:(\w+)/g, '{$1}')}`,
  );

/** "Never leave undocumented endpoints": every route of the real application must be fully described. */
describe('OpenAPI coverage (e2e)', () => {
  let app: INestApplication<App>;
  let doc: {
    paths: Record<string, Record<string, Operation>>;
    components: { schemas: Record<string, unknown> };
  };
  let operations: { key: string; op: Operation }[];

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();
    app = moduleRef.createNestApplication();
    configureApp(app);
    await app.init();
    const res = await request(app.getHttpServer())
      .get('/api/docs-json')
      .expect(200);
    doc = res.body;
    // Used by scripts/route-coverage.ts to compare declared routes with the routes the tests really called.
    const declaredFile = process.env.ROUTE_DECLARED_FILE;
    if (declaredFile)
      writeFileSync(
        declaredFile,
        Object.entries(doc.paths)
          .flatMap(([path, item]) =>
            METHODS.filter((m) => item[m]).map(
              (m) => `${m.toUpperCase()} ${path.replace(/\{(\w+)\}/g, ':$1')}`,
            ),
          )
          .join('\n'),
      );
    operations = Object.entries(doc.paths).flatMap(([path, item]) =>
      METHODS.filter((m) => item[m]).map((m) => ({
        key: `${m.toUpperCase()} ${path}`,
        op: item[m],
      })),
    );
  });

  afterAll(async () => {
    await app.close();
  });

  it('documents every endpoint listed in docs/API_ENDPOINT_INVENTORY.md, and lists every registered endpoint there', () => {
    const registered = operations.map((o) => o.key).sort();
    const listed = inventoryRoutes().sort();
    expect(new Set(listed).size).toBe(listed.length);
    expect(registered.filter((k) => !listed.includes(k))).toEqual([]);
    expect(listed.filter((k) => !registered.includes(k))).toEqual([]);
  });

  it('gives every operation a summary, a description, a tag, a success and an error response', () => {
    const problems: string[] = [];
    for (const { key, op } of operations) {
      if (!op.summary) problems.push(`${key}: no summary`);
      if (!op.description) problems.push(`${key}: no description`);
      if (!op.tags?.length) problems.push(`${key}: no tag`);
      const codes = Object.keys(op.responses ?? {});
      if (!codes.some((c) => c.startsWith('2')))
        problems.push(`${key}: no 2xx response`);
      if (!codes.includes('500')) problems.push(`${key}: no 500 response`);
      for (const [code, r] of Object.entries(op.responses ?? {})) {
        if (!r.description)
          problems.push(`${key}: response ${code} has no description`);
      }
    }
    expect(problems).toEqual([]);
  });

  it('declares bearer auth on every protected route and on no public route', () => {
    const problems: string[] = [];
    for (const { key, op } of operations) {
      const isPublic = PUBLIC_ROUTES.has(key);
      const hasBearer = (op.security ?? []).some((s) =>
        Object.keys(s as object).includes('bearer'),
      );
      if (isPublic && hasBearer)
        problems.push(`${key}: public route claims bearer auth`);
      if (!isPublic && !hasBearer)
        problems.push(`${key}: protected route has no bearer auth`);
      const codes = Object.keys(op.responses ?? {});
      if (!isPublic && !codes.includes('401'))
        problems.push(`${key}: no 401 documented`);
    }
    expect(problems).toEqual([]);
  });

  it('documents the request body of every POST / PATCH that takes one, and the path params of every route', () => {
    const noBody = new Set([
      'POST /api/v1/products/{id}/duplicate',
      'POST /api/v1/reviews/{id}/publish', // state change on the id alone
      'POST /api/v1/reviews/{id}/unpublish',
      'POST /api/v1/store/studio/review-requests', // acts on the store's current drafts
      'POST /api/v1/auth/logout', // the session is the cookie
      'POST /api/v1/auth/refresh',
    ]);
    const problems: string[] = [];
    for (const { key, op } of operations) {
      const path = key.split(' ')[1];
      for (const [, name] of path.matchAll(/\{(\w+)\}/g)) {
        if (!op.parameters?.some((x) => x.in === 'path' && x.name === name))
          problems.push(`${key}: path param ${name} undocumented`);
      }
      if (/^(POST|PATCH) /.test(key) && !noBody.has(key) && !op.requestBody)
        problems.push(`${key}: no request body`);
    }
    expect(problems).toEqual([]);
  });

  it('wraps every 2xx response in the standard envelope', () => {
    const problems: string[] = [];
    for (const { key, op } of operations) {
      for (const [code, r] of Object.entries(op.responses ?? {})) {
        if (!code.startsWith('2')) continue;
        const schema = JSON.stringify(r.content ?? {});
        if (!schema.includes('SuccessResponseDto'))
          problems.push(
            `${key}: ${code} is not wrapped in the success envelope`,
          );
      }
    }
    expect(problems).toEqual([]);
  });

  it('documents paginated collections with the meta object', () => {
    const lists = [
      '/api/v1/products',
      '/api/v1/customers',
      '/api/v1/inventory',
      '/api/v1/platform/organizations',
      '/api/v1/platform/audit-logs',
      '/api/v1/platform/usage',
    ];
    for (const path of lists) {
      const ok = doc.paths[path].get.responses?.['200'];
      expect(JSON.stringify(ok?.content), path).toContain('PaginationMetaDto');
      const params = doc.paths[path].get.parameters?.map((p) => p.name) ?? [];
      expect(params, path).toEqual(expect.arrayContaining(['page', 'limit']));
    }
    expect(
      JSON.stringify(
        doc.paths['/api/v1/categories'].get.responses?.['200']?.content,
      ),
    ).not.toContain('PaginationMetaDto');
  });

  it('documents the organization header on organization-scoped routes', () => {
    const op = doc.paths['/api/v1/products'].get;
    expect(
      op.parameters?.some(
        (p) => p.in === 'header' && p.name === 'X-Organization-Id',
      ),
    ).toBe(true);
  });

  it('exposes template routes only for the Theme Store (an exact allowlist)', () => {
    expect(
      Object.keys(doc.paths)
        .filter((p) => /template|theme/i.test(p))
        .sort(),
    ).toEqual([
      '/api/v1/reviews/import-template', // the review CSV header row, not a Theme Store template
      '/api/v1/store/templates',
      '/api/v1/store/templates/{id}',
      '/api/v1/store/templates/{id}/draft',
      '/api/v1/store/templates/{id}/preview',
      '/api/v1/store/templates/{id}/publish',
      '/api/v1/store/templates/{id}/rollback',
      '/api/v1/store/templates/{id}/versions',
      '/api/v1/store/theme',
      '/api/v1/store/theme/publish',
      '/api/v1/themes',
      '/api/v1/themes/{slug}',
    ]);
  });

  it('does not expose orders create / update / delete', () => {
    expect(
      Object.keys(doc.paths).filter((p) => /\/orders(\/|$)/.test(p)),
    ).toEqual([]);
  });
});
