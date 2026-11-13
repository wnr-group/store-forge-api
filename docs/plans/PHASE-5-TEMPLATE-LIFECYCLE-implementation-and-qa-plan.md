# Phase 5 Template Lifecycle Implementation and QA Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the 27-endpoint template lifecycle backend (AC-LIFE-001 to 021) as one `TemplatesModule` in `store-forge-api`, with evidence that makes an AC impossible to call done without reproducible proof.

**Architecture:** NestJS module under `src/modules/templates/` on `DatabaseService.withUser` and RLS, using a read-only synced copy of the `store-forge` template engine. Locks, quotas, revisions and publish pipeline follow Grill-Me decisions D1-D51.

**Tech Stack:** NestJS 12 (ESM, `module: nodenext`), TypeScript 6, Drizzle 0.45 + postgres-js, Zod 4 (engine), Vitest 4, supertest, PGlite, Docker PostgreSQL (new), Supabase Storage/pooler (live gates only).

## Global Constraints

- Plan only: nothing here has been implemented, run, migrated or screenshotted. Every status is NOT TESTED / NOT VERIFIED until real execution evidence exists.
- Decision baseline: `docs/architecture/phase-5-template-lifecycle-grill-me-report.md` (D1-D51). PROPOSED/OPEN items stay PROPOSED/OPEN (section 17). Of the audit findings F1-F9 against that report, the three that change what is built or tested are carried as OQ-1 (F1), OQ-2 (F2) and OQ-8 (F5); the rest are wording fixes to the report itself (OQ-14) and do not alter this plan.
- No migration, no service-role key, no edit to generated files (`src/infrastructure/database/{schema,template-deps,migrations-snapshot}`, `src/infrastructure/templates-engine/`), no Santu-owned or catalog file, no catalog-module import (D2, D40).
- Relative imports end in `.js`; files under 500 lines; no `process.env` outside `src/config`; no `Co-Authored-By` trailer unless `.claude/settings.json` sets `attribution.commit` (project CLAUDE.md).
- Evidence labels (D19): `UNIT`, `INT-PGLITE`, `INT-PG`, `LIVE-SUPABASE`, `MOCK`, `E2E` (real Nest pipeline over HTTP). PGlite and mocks never prove concurrency or Storage behaviour.
- **Deviation from the writing-plans skill (stated, not hidden):** full code is given only for foundation-independent units (Tasks 2.1a-c). Controllers, guards, envelopes and error classes depend on a foundation that is not decided (BLK-1), so their test code is written test-first at execution against the merged foundation, as the foundation plan (section 10) already does. Inventing it now would be guessing.

---

## 1. Ticket scope and acceptance criteria

**Placeholders:** `{{target_ticket}}` and `{{tech_stack_context}}` were not filled. Assumed: ticket = Phase 5 "Backend Services and Template Lifecycle", ticket ID `PHASE-5` (no tracker ID exists in the repo), stack as above. **Confirm (OQ-12).**

**Source of ACs:** the wording supplied in the Grill-Me brief. The AC matrix and master engine plan are not in this repo (NOT VERIFIED against a ticket system). The 21 ACs are copied verbatim into section 15; none are added or reinterpreted.

**In scope:** 27 endpoints (report C.2), `TemplatesModule`, the engine sync commit, tests, evidence. **Out of scope:** visual editor, merchant UI, storefront routes, catalog/auth/team/platform modules, migrations, audit logging (no AC), label input (D48), idempotency keys (D29).

## 2. Repository findings and source references

| # | Finding | Evidence | Status |
|---|---|---|---|
| R1 | Only route is `GET /api/v1/health` | `src/modules/health/health.controller.ts`; `src/app.module.ts` imports `DatabaseModule`, `HealthModule` | verified |
| R2 | `DatabaseService.withUser/withPublic/ping`, `rowsOf`, `RlsGuardError` exist on branch `feat/pr-a-database-foundation` (PR #2 OPEN) | `src/infrastructure/database/{database.service,user-context}.ts` | verified |
| R3 | Error filter emits `{statusCode,error,message,path,timestamp}`, no `code` | `src/common/filters/all-exceptions.filter.ts` | verified |
| R4 | Global `ValidationPipe` whitelist + forbidNonWhitelisted + transform; no body-parser limit configured | `src/app.setup.ts` (grep for json/limit/bodyParser: none) | verified; 100 KB default behaviour NOT VERIFIED |
| R5 | Test tiers: `*.spec.ts` unit, `*.int-spec.ts` PGlite (`npm run test:int`), `*.e2e-spec.ts`; kit `test/support/database/{create-test-database,fixtures,supabase-stub}.ts` | `vitest.config*.ts`, `package.json` | verified |
| R6 | CI runs typecheck, lint, format, unit, e2e, PGlite int, build; schema-drift job | `.github/workflows/ci.yml` | verified |
| R7 | `sync-schema.mjs` hard-codes `document.ts`,`limits.ts`; flattens `lib/templates/*` to `template-deps/`; `.ts` resolved before `index.ts` | `scripts/sync-schema.mjs` lines ~55-170 | verified |
| R8 | No `zod` dependency, no Playwright, no feature-flag mechanism in `package.json`/config | `package.json` | verified (flags: absence only for files read) |
| R9 | Engine source: 77 files under `lib/templates/` on `store-forge` `main` and `feat/template-engine-pr-readiness`; contents not diffed; only external imports `zod` + 2 `@/lib` in `resolve.ts` | gh read-only | partly verified |
| R10 | Schema, RLS, triggers, 0014 fallback chain, Storage policies as in report D.3 | migrations 0006, 0012-0015 | read, not executed |
| **R11** | **`feature/nestjs-api-migration` (Santu, 8 commits ahead of `main`, 0 behind, no PR, 218 files) is a different, complete foundation:** header `x-organization-id`; `AppException(kind,message,{code,details})` with `ERROR_STATUS` and free-form `code`; error body `{success:false,message,error:{code,details},timestamp,path}`; `ResponseInterceptor` wraps success as `{success,message,data,meta?}`; pagination `page/limit/total/totalPages` plus `search`,`sortOrder`; guards `jwt-auth`, `organization-context`, `permissions`, `platform-admin`; ~20 modules; no templates module in the compare list | gh read of 6 files; file list only for the rest | **guards/permissions NOT VERIFIED (API rate limit)** |

**Consequence of R11:** the report's "PR-B: no branch exists" is stale. It conflicts with report D-020/021/022 assumptions and with decisions D22, D34, D37, D38, D49 (bare bodies, `{items,total,page,pageSize}`, no client sort/search, flat `details`). Not resolved here: it is BLK-1.

## 3. Architectural impact

**Backend (new):** `src/modules/templates/{templates.module.ts, controllers/{templates,shared-documents,template-assignments,template-images}.controller.ts, services/{template,template-publish,template-assignment,template-query,template-media}.service.ts, support/{lock-order,template-errors,limits,names,fresh-ids,image-paths}.ts, dto/*}` (D47; `names/fresh-ids/image-paths` are extra pure helpers, justified by file-size and test isolation).
**Backend (modified, coordinated only):** `src/app.module.ts` (register), error contract (D34), `src/app.setup.ts`/`main.ts` (D45 route-scoped body limit), `package.json` (`zod`), `scripts/sync-schema.mjs`+spec (D3), new `vitest.config.pg.ts` (PROPOSED).
**Frontend:** none. This repo has no frontend and D1/scope exclude UI. Permission-based rendering, loading/empty/error states, responsive and a11y concerns belong to the Next.js app and are not planned here.
**Database:** no schema change (D5, D46). Quota, name-uniqueness and idempotency gaps are accepted limitations, not migrations.
**Tenant/RLS:** every query inside `DatabaseService.withUser`; app check first, RLS second; cross-tenant ids give identical `NOT_FOUND` (D18).
**Locks:** matrix in report D.4 (D50): create/duplicate=store; archive/restore=store→template; default=store→templates by id; assign=`FOR SHARE` targets by id; others=template only. `READ COMMITTED`; `SET LOCAL lock_timeout` from one constant (value OPEN) (D51).
**Non-functional:** list status computed in one SQL query (D36) measured in INT-PG; large documents (<=262,144 jsonb bytes); body limit scoped (D45); no automatic retries; errors never leak SQL.

## 4. Dependencies and blockers

| ID | Blocker | Owner | Gates |
|---|---|---|---|
| BLK-1 | **Foundation reconciliation:** plan's PR-B (X-Tenant-Id, bare bodies) vs Santu's branch (x-organization-id, envelopes). Decide which lands; re-confirm D22/D34/D37/D38/D49 shapes | Sibi + both authors | all Phase 5 code except 1.1/2.1 |
| BLK-2 | PR #2 (PR-A) unmerged; sync script exists only there | foundation owner | Task 1.1 base |
| BLK-3 | Phase 5 ownership and CODEOWNERS entry undocumented | Sibi | commits, review |
| BLK-4 | Error-contract changes (codes, `details`, `busy`, 413) | foundation owner | Tasks 2.3+ |
| BLK-5 | Business rules: D6/D27 quota meaning, AC-012 wording, batch size, inactive resources, shared-doc names | ticket/product owner | Tasks 2.3, 2.6, 2.8 |
| BLK-6 | Docker Postgres + CI service container; live Supabase project/credentials | infra | Phase 4, LIVE |
| BLK-7 | `LOCK_TIMEOUT` value vs pooler limits | connection owner | Task 2.3 |

---

## 5. Step-by-step implementation

Phases: 0 foundation/dependencies, 1 engine sync, 2 backend, 3 frontend (N/A), 4 integration harness, 5 functional tests, 6 security/regression, 7 E2E, 8 production readiness. Each task is a reviewable commit group; a task ends only with its listed evidence. "Frontend changes" and "Database changes" are `none` for every task unless stated.

### Phase 0: Foundation and dependencies

| Step | Objective | Dependencies | Completion evidence |
|---|---|---|---|
| 0.1 | Get a written decision on BLK-1 (which foundation; envelope/header/pagination/error shapes) and record it as an addendum to the Grill-Me report | owners | signed-off decision text; D22/D34/D37/D38/D49 re-confirmed or amended |
| 0.2 | Send coordination requests: BLK-3 to BLK-7, OQ-1 to OQ-12 | none | message links stored in `evidence-index.md` |
| 0.3 | Reproduce the default body-parser limit with a real request (D45) | running app (execution phase) | request/response transcript |

### Phase 1: Engine synchronization (separate first commit; no foundation dependency)

### Task 1.1: Extend the read-only sync to `templates-engine/`

**Files:** Modify `scripts/sync-schema.mjs`, `scripts/sync-schema.spec.ts`, `package.json` (`zod ^4.6.7`); generated `src/infrastructure/templates-engine/**` (never hand-edited); `template-deps/` unchanged.
**Interfaces:** Produces `src/infrastructure/templates-engine/{document,limits,presets,registry}.ts`, `engine/{validate,migrate,tree-ids,image-scan,size,...}.ts`, `registry/**` (exact set fixed by the dependency closure, D3).
**Dependencies:** BLK-2. **ACs:** all (engine availability).

- [ ] Step 1: Write failing specs in `sync-schema.spec.ts`: allowlist copies the closure with directory structure; a new unclassified file under the source dirs makes `check` exit 1; `./registry` resolves to `registry.ts` and `./registry/index` to `registry/index.ts`; renderer-only files (`resolve.ts`, `form-state.ts`, `variant-selection.ts`, `breakpoints.ts`, `engine/theme-css.ts`) are absent; generated files carry the DO-NOT-EDIT banner.
- [ ] Step 2: Run `npx vitest run scripts/sync-schema.spec.ts`. Expected: new specs FAIL.
- [ ] Step 3: Implement: allowlist map; preserve directories; classify `engine/{fonts,measure,richtext,tenant-cache}.ts`, `types.ts`, `legacy-resync.ts` by computing the import closure from `validate.ts`, `registry/index.ts`, `presets.ts`; decide mirror-vs-rewrite for `../document`,`../limits` (OQ-9).
- [ ] Step 4: Run sync against a checkout of `store-forge` (branch per OQ-10), then `npm run typecheck`, `npm run lint`, `npx vitest run scripts/sync-schema.spec.ts`. Expected: PASS.
- [ ] Step 5: Add parity spec `test/engine-parity.spec.ts`: shared fixtures (valid page doc, doc without `layout`, unsupported `schemaVersion`, oversize doc by jsonb length, foreign-tenant image path) give identical `validateDocument`/`migrateDocument` results to the frontend copy's recorded outputs.
- [ ] Step 6: Commit `chore(engine): sync template engine subset read-only`. **Evidence:** spec output, typecheck/lint output, drift-check output, parity output.

### Phase 2: Backend

### Task 2.1: Foundation-independent pure helpers (confirm OQ-11 that these may precede PR-B)

**Files:** Create `src/modules/templates/support/{names,fresh-ids,image-paths}.ts` and `*.spec.ts` beside each.
**Interfaces:** Produces `normalizeName(raw): string|null`, `copyName(src): string`, `cloneWithFreshIds(doc, generate): TemplateDocument`, `collectImagePaths(root): string[]`.

**2.1a Names (D20).** Test, then code:

```ts
// names.spec.ts
import { describe, expect, it } from 'vitest';
import { copyName, normalizeName } from './names.js';
const cp = (n: number) => '😀'.repeat(n);
describe('names (D20)', () => {
  it('counts code points, not UTF-16 units', () => {
    expect(normalizeName(cp(80))).toBe(cp(80));
    expect(normalizeName(cp(81))).toBeNull();
  });
  it('trims; rejects empty and whitespace-only', () => {
    expect(normalizeName('  a  ')).toBe('a');
    expect(normalizeName(' \t\n ')).toBeNull();
    expect(normalizeName('')).toBeNull();
  });
  it('copy name is "Copy of <name>" cut to 80 code points', () => {
    expect(copyName('Home')).toBe('Copy of Home');
    expect([...copyName(cp(80))]).toHaveLength(80);
  });
});
```

```ts
// names.ts
import { LIMITS } from '../../../infrastructure/database/template-deps/limits.js';

export const codePointLength = (s: string): number => [...s].length;

/** Trimmed name when 1..80 code points, else null (caller throws VALIDATION). */
export function normalizeName(raw: string): string | null {
  const t = raw.trim();
  const n = codePointLength(t);
  return n >= 1 && n <= LIMITS.maxNameLength ? t : null;
}

export const copyName = (source: string): string =>
  [...`Copy of ${source}`].slice(0, LIMITS.maxNameLength).join('');
```
Run `npx vitest run src/modules/templates/support/names.spec.ts` (FAIL then PASS). Commit `feat(templates): name rules`.

**2.1b Fresh ids (D21).** Test asserts: every section/block id differs from the source; `order`/`block_order` map to the same positions; settings deep-equal and not aliased; source unmutated; unique ids across the whole document.

```ts
// fresh-ids.ts
import type { ComponentNode, TemplateDocument } from '../../../infrastructure/database/template-deps/document.js';

const MAX_ATTEMPTS = 50;

export function cloneWithFreshIds(doc: TemplateDocument, generate: (prefix: string) => string): TemplateDocument {
  const used = new Set<string>(['__proto__']);
  const fresh = (prefix: string): string => {
    for (let i = 0; i < MAX_ATTEMPTS; i++) {
      const id = generate(prefix);
      if (!used.has(id)) { used.add(id); return id; }
    }
    throw new Error('Cannot generate a unique node id');
  };
  const copyNode = (node: ComponentNode): ComponentNode => {
    const { blocks, block_order, settings, ...rest } = node;
    const map = new Map<string, string>();
    const newBlocks: Record<string, ComponentNode> = {};
    for (const [oldId, child] of Object.entries(blocks)) {
      const id = fresh('blk');
      map.set(oldId, id);
      newBlocks[id] = copyNode(child);
    }
    const order = block_order.map((oldId) => {
      const id = map.get(oldId);
      if (!id) throw new Error(`block_order references unknown block ${oldId}`);
      return id;
    });
    return { ...structuredClone(rest), settings: structuredClone(settings), blocks: newBlocks, block_order: order };
  };
  const { sections, order, ...top } = doc;
  const map = new Map<string, string>();
  const newSections: Record<string, ComponentNode> = {};
  for (const [oldId, section] of Object.entries(sections)) {
    const id = fresh('sec');
    map.set(oldId, id);
    newSections[id] = copyNode(section);
  }
  const newOrder = order.map((oldId) => {
    const id = map.get(oldId);
    if (!id) throw new Error(`order references unknown section ${oldId}`);
    return id;
  });
  return { ...structuredClone(top), sections: newSections, order: newOrder };
}
```
Recursion depth is bounded by the validator's `maxBlockDepth` 3 (the source is validated first, D21). **Verify at execution (NOT VERIFIED):** whether any setting value references another node id (scan `engine/descriptors.ts`/`bindings.ts`); if so, remapping must be added before this task is accepted.

**2.1c Image paths (D41).** Parity test runs `scanImageValues` and `collectImagePaths` over the same fixtures (nested, array-held, theme settings, undeclared keys, 5,000-deep nesting) and asserts the collector returns exactly the image-shaped `path` strings.

```ts
// image-paths.ts
/** Every string `path` held by an object (arrays excluded) anywhere in `root`; iterative, de-duplicated. */
export function collectImagePaths(root: unknown): string[] {
  const found = new Set<string>();
  const stack: unknown[] = [root];
  while (stack.length > 0) {
    const value = stack.pop();
    if (typeof value !== 'object' || value === null) continue;
    if (Array.isArray(value)) { for (const item of value) stack.push(item); continue; }
    const record = value as Record<string, unknown>;
    if (typeof record.path === 'string') found.add(record.path);
    for (const key of Object.keys(record)) stack.push(record[key]);
  }
  return [...found];
}
```
Commit `feat(templates): fresh-id clone and image-path collector`. **Evidence:** spec output.

### Task 2.2: Module skeleton, DTOs, read routes (after BLK-1, BLK-4)

**Files:** Create `templates.module.ts`, `controllers/templates.controller.ts` (routes 1,3,12,13), `controllers/shared-documents.controller.ts` (19,23,24), `controllers/template-images.controller.ts` (27, later), `services/template-query.service.ts`, `dto/*`, `support/{limits,template-errors,lock-order}.ts`; Modify `src/app.module.ts` (one import, coordinated).
**Details:** list SQL (one statement, D36): `SELECT t.id,t.kind,t.name,t.status,t.is_default,t.revision,t.published_version_id, CASE WHEN t.status='archived' THEN 'archived' WHEN t.published_version_id IS NULL THEN 'draft' WHEN t.draft = v.document THEN 'published' ELSE 'published_with_changes' END AS publication_state FROM templates t LEFT JOIN template_versions v ON v.id=t.published_version_id AND v.template_id=t.id WHERE t.store_id=$1 AND t.tenant_id=$2 AND t.kind IN ('index','product','collection') ORDER BY t.created_at DESC, t.id DESC LIMIT $3 OFFSET $4` plus `count(*)` for `total`. Page-kind restriction lives in one `findTemplate()` helper used by every generic route (D43). Shared reads resolve by `(storeId, kind)`; no row returns the registry default with `revision: 0` (`getPresetDocument(kind)`).
**Tests:** INT-PGLITE for each read (revision accuracy, missing records, version metadata, shared fallback, order, tie-breaking); E2E for guard/validation wiring. **Commit:** `feat(templates): module skeleton and read endpoints`.
**Confirm first:** envelope, header, pagination field names (BLK-1); how the tenant reaches handlers; route-level permission decorator (NOT VERIFIED).

### Task 2.3: Create, duplicate, rename, archive, restore, delete, set default (routes 2,4-8,16)

**Files:** `services/template.service.ts`, DTOs, `controllers/templates.controller.ts`, `support/lock-order.ts`.
**Details:**
- `lock-order.ts`: `lockStore(tx, tenantId, storeId)` = `SELECT id FROM stores WHERE id=$1 AND tenant_id=$2 FOR UPDATE`; `lockTemplates(tx, ids[])` sorts ids ascending, then `SELECT id FROM templates WHERE id = ANY($1) ORDER BY id FOR UPDATE`; `lockSharedTemplates(tx, ids[])` same with `FOR SHARE`; a runtime guard throws if a template lock is taken before a store lock in the same tx (D50 rules 5-7). Applies `SET LOCAL lock_timeout` (BLK-7).
- Create: strict DTO (D30), preset via `getPresetDocument`, `migrateDocument`+`validateDocument` (server defect -> unknown/500, never stored), quota under store lock counting page kinds only (D6, PROPOSED), `INSERT ... RETURNING`.
- Duplicate: read source unlocked, validate (reject `VALIDATION`), `cloneWithFreshIds`, `copyName`, quota under store lock; shared kinds -> identical `NOT_FOUND` via `findTemplate`.
- Archive/restore: store lock then template lock; no-op when state matches without quota check (D39); archive sets `is_default=false`; restore never sets default.
- Delete: template lock; eligibility `NOT EXISTS versions` and no assignments; reasons `published`/`assigned`; map `23503`; handle zero-row delete explicitly (D12).
- Set default: store lock, then old and new default by ascending id; clear then set; no-op if already default; page kinds only, active only.
- SQLSTATE map: `23514`->`VALIDATION`, `23505`/`23503`->`CONFLICT`, `55P03`/`40P01`->`CONFLICT` reason `busy` (PROPOSED), else unknown.
**Tests:** UNIT (decision helpers), INT-PGLITE (state, quotas at 99/100, archived allow-list D26, no-ops, `updated_at` unchanged on no-op), INT-PG (Task 5.3). **Commit:** `feat(templates): template lifecycle service`.

### Task 2.4: Draft save and restore-version (routes 9, 15; shared 20, 26)

**Details:** locked `SELECT ... FOR UPDATE` then compare revision; `expectedRevision` mismatch (stale or future) -> `CONFLICT` with `currentRevision`; identical document -> `outcome: unchanged`, no write; archived -> `CONFLICT` reason `archived`; validate with tenant id from membership. Restore-version: read source by `(template_id, version_id)` via the page-kind lookup, `migrateDocument`, validate, no image check. Shared first save: `INSERT ... ON CONFLICT (store_id, kind) WHERE kind IN (...) DO NOTHING`, loser re-reads and returns `CONFLICT` with revision; fixed names constants are OPEN (OQ-7). Body-limit parser per D45 (BLK-4, OQ-1).
**Tests:** INT-PGLITE for all outcomes; INT-PG for concurrent saves, autosave vs restore, concurrent first saves. **Commit:** `feat(templates): draft save and version restore`.

### Task 2.5: Publish, unpublish, rollback (routes 10,11,14; shared 21,22,25)

**Details:** two-phase (D8). Phase 1 (no lock): read draft+revision, `migrateDocument`/`validateDocument`, `collectImagePaths`, one batched existence query `SELECT name FROM storage.objects WHERE bucket_id='products' AND name = ANY($1)` (skipped when no images). Phase 2 (one tx): lock the row with `SELECT t.*, (t.draft = v.document) AS draft_matches_published FROM templates t LEFT JOIN template_versions v ON v.id=t.published_version_id AND v.template_id=t.id WHERE t.id=$1 AND t.store_id=$2 AND t.tenant_id=$3 AND t.kind IN (...) FOR UPDATE OF t` (`OF t` is required: PostgreSQL rejects `FOR UPDATE` on the nullable side of an outer join); check `archived`; compare locked revision to phase-1 and `expectedRevision`; D25 no-op; `count(*)` of versions vs 500 (D46); `INSERT INTO template_versions (tenant_id, store_id, template_id, document, source)`; `UPDATE templates SET published_version_id`. Rollback: source version by `(template_id, versionId)`, migrate, validate, images, D28 no-op comparison against the live version's migrated document, `source='rollback'`, `rolled_back_from`. Unpublish: lock, archived check, no-op if pointer NULL.
**Not decided (OQ-2):** whether the no-op is recognised before phase 1's image check; until answered, implement no behaviour for "no-op on an already-published draft with a since-deleted image".
**Tests:** INT-PGLITE with image-free documents; INT-PG for races and fault injection (Task 5.3); LIVE for image paths (Task 5.5). **Commit:** `feat(templates): publish service`.

### Task 2.6: Assignments (routes 17, 18)

**Details:** strict array DTOs, `ArrayMaxSize(ASSIGNMENT_BATCH_MAX)` from `support/limits.ts` (100, PROPOSED), reject duplicate resources in a batch; batched `SELECT id FROM products|collections WHERE id = ANY($1)` (tenant by RLS); `lockSharedTemplates` for all distinct targets; validate active, same-store, kind match; collect all failures into `details.items`; upsert `INSERT ... ON CONFLICT (store_id, product_id|collection_id) DO UPDATE SET template_id = EXCLUDED.template_id` (RLS dual-policy compatibility UNVERIFIED); outcomes `created|replaced|unchanged`; unassign `removed|absent` (PROPOSED).
**Tests:** INT-PGLITE validations; INT-PG assignment vs archive/delete, overlapping bulk batches. **Commit:** `feat(templates): assignment service`.

### Task 2.7: Images (route 27)

**Details:** `template-media.service.ts`: `SELECT name, metadata->>'size', metadata->>'mimetype', created_at FROM storage.objects WHERE bucket_id='products' AND starts_with(name, $1) AND position('/' in substr(name, length($1)+1)) = 0 ORDER BY created_at DESC, name ASC LIMIT/OFFSET` where `$1 = tenantId || '/store/'`. Column names of `storage.objects` are NOT VERIFIED; confirm on the live project first.
**Tests:** LIVE-SUPABASE only (PGlite/Docker have no `storage` schema). **Commit:** `feat(templates): image listing`.

### Task 2.8: Shared documents wiring and OpenAPI

Reuse services parameterized by kind; generic routes never see shared rows; add Swagger decorators documenting orders, limits, outcomes, batch cap. **Commit:** `feat(templates): shared documents and OpenAPI`.

### Phase 3: Frontend: **not applicable.** No UI in this repo or ticket. Recorded so QA does not expect merchant-UI screenshots.

### Phase 4: Integration harness

### Task 4.1: `INT-PG` tier (BLK-6)

**Files:** Create `vitest.config.pg.ts` (`include: ['**/*.pg-spec.ts']`, longer timeouts), `test/support/pg/{docker-database.ts,connections.ts}` (starts a throwaway Postgres container, applies migrations 0000-0024 from the snapshot plus the existing auth/role stub, exposes N independent postgres-js connections), `package.json` script `test:pg`, CI job with a PostgreSQL service container. Do not use PGlite sockets. **Evidence:** a smoke spec proves two connections block each other on `SELECT ... FOR UPDATE` (a genuine two-session check). Whether the PR-A stubs work over real TCP is NOT VERIFIED.

### Task 4.2: `LIVE-SUPABASE` gate

`*.live-spec.ts` excluded from CI by default, enabled by an env flag (read in `src/config` or the spec, never committed), read-only, no destructive suites on the shared project (D19). Requires BLK-6.

### Phase 5: Functional tests (execute and record)

| Task | Content | Tier |
|---|---|---|
| 5.1 | Full per-route success/body/no-op suite | INT-PGLITE + E2E |
| 5.2 | Authorization matrix (section 12) | E2E + INT-PGLITE |
| 5.3 | Concurrency, quota races, lock timeout/deadlock, fault injection (temporary triggers installed and dropped by the fixture, also on failure) | INT-PG |
| 5.4 | List performance: 100 rows, all four states, large documents; record query count and time, no invented threshold | INT-PG |
| 5.5 | Storage/pooler: SELECT on `storage.objects`, tenant RLS, cross-tenant, missing object, API-delete visibility, listing pagination, `SET LOCAL ROLE` via real pooler | LIVE-SUPABASE |

### Phase 6: Security and regression: Tasks 6.1 (security matrix execution), 6.2 (regression matrix, section 11).
### Phase 7: E2E: Task 7.1 real HTTP flows (section 8D) and Swagger UI evidence (section 10).
### Phase 8: Production readiness: Task 8.1 evidence index, closeout report (section 16), Go/No-Go (section 14).

## 6. Frontend implementation

None. Merchant UI consumption is a separate Next.js ticket.

## 7. Database and API changes

**Database:** none. No migration. Quotas, name uniqueness, idempotency, per-store image prefix and Storage reference lock stay application-level or accepted limitations (D5, D20, D29, D46).
**API:** 27 endpoints exactly as report C.2 (bodies, statuses, outcomes) **subject to BLK-1** for the envelope/field names; error codes per D34 (PROPOSED). Existing `GET /health` unchanged.

## 8. Test strategy

**A. Unit (`*.spec.ts`).** Names, fresh ids, image collector, SQLSTATE mapper, outcome/no-op decision helpers, DTO validators (batch cap, preset rules, unknown-property rejection incl. `label`), lock-order guard. Mock: nothing database-related; mock only the clock/id generator. Must not mock: `validateDocument`, `migrateDocument`, the DTO pipe.
**B. Backend integration.** `INT-PGLITE` for state, constraints, RLS role matrix, response bodies, no-ops. `INT-PG` for everything about parallelism, lock order, timeouts, quota races, fault injection, performance. `LIVE-SUPABASE` for Storage and pooler. A mocked repository never counts.
**C. Frontend integration.** Not applicable.
**D. E2E (real HTTP).** Boot the real `AppModule` through `configureApp` (as `test/app.e2e-spec.ts` does) against the real database tier; authenticate with the foundation's real test-token kit (BLK-1; NOT VERIFIED which); for each journey: create, authorise, perform the action over HTTP, assert status/body, independently query the database, repeat the request/read after a fresh request and assert state unchanged, then capture the Swagger UI evidence (section 10). Not allowed: intercepted/mocked responses, hardcoded data, static screenshots.
**E. Security.** Section 12.
**F. Regression.** Section 11.

## 9. Manual QA scenarios

Tester uses Swagger UI at `/api/docs` (enabled by `SWAGGER_ENABLED`) against a running API and a database seeded with two tenants (Owner, Manager, Staff each) and one Platform Admin; verify state with SQL independently.

| MQ | Scenario | Expected |
|---|---|---|
| MQ-1 | Create `index`+`classic`, `index`+`spotlight`, `product`, `collection`; try a missing preset, an 81-code-point name | 201 with draft, `revision 1`, not default; the invalid cases give validation errors |
| MQ-2 | Duplicate with unpublished edits; check new ids and `Copy of …` | new template, no assignments, source untouched |
| MQ-3 | Rename to a duplicate name; whitespace-only name | success; validation error |
| MQ-4 | Archive default, then restore | default cleared, assignments intact; restore not default |
| MQ-5 | Save with current, stale, future revision; identical document | saved / conflict + current revision / conflict / unchanged |
| MQ-6 | Publish; publish again; edit and publish; unpublish; republish | one version; unchanged; new version; pointer null; new version |
| MQ-7 | Rollback to v1, repeat, rollback to live doc | new rollback version; unchanged; unchanged |
| MQ-8 | Restore a version into the draft | draft replaced, revision +1, versions unchanged |
| MQ-9 | Set default on an unpublished template; archived one | success; `archived` conflict |
| MQ-10 | Assign product/collection, replace, batch of 100/101, archived target, wrong kind | created/replaced; 101 rejected; conflicts with item details |
| MQ-11 | Fill 100 active / 500 archived / 500 versions fixtures | quota errors; no-ops still succeed |
| MQ-12 | Each role/tenant on every route | per section 12 matrix |
| MQ-13 | Shared document: GET default, first save `expectedRevision 0`, publish, unpublish, no-row routes | per D13/D27/D44 |
| MQ-14 | Delete never-published, published, assigned | 204; conflict `published`; conflict `assigned` |
| MQ-15 | List images (own tenant, other tenant's prefix, page size 30) | own `store/` only; validation error |

## 10. Screenshot and evidence plan

**No merchant UI exists, so no UI screenshots are required or allowed for AC proof.** Where a browser is available (Playwright is not installed and installing it needs approval: OQ-6), capture the real Swagger UI (`/api/docs`) of the running API showing "Try it out" request, response status and body for the relevant operation; these demonstrate the API contract only, not persistence, isolation, atomicity or concurrency. Without a browser the ACs stay evidenced by API transcripts and SQL results and are not marked failed for that reason.

```text
screenshots/PHASE-5/            (foundation-plan convention is screenshots/store-forge-api/<PR>/; confirm OQ-5)
  AC-LIFE-001/ ... AC-LIFE-021/ 01-request.png 02-response.png 03-db-check.txt
  regression/  failures/
  test-output/*.txt|json        raw runner output, never edited
  transcripts/*.http|json       sanitised request/response pairs
  evidence-index.md
```
Index row: `| AC | scenario | test name | tier label | environment | role | actual result | path | status |`. Sanitise before commit: grep for `postgres://`, `eyJ`, `sb_`, `apikey`, project refs. Evidence is stored under the agreed location only after the file exists. Not created during planning.

## 11. Regression matrix

| Existing feature | Risk | Scenario | Evidence |
|---|---|---|---|
| `GET /api/v1/health` | module registration or body-parser change | existing e2e still passes (updated intentionally only by foundation owner) | `test/app.e2e-spec.ts` output |
| Global `ValidationPipe`/error filter | shared contract edit | existing filter specs plus unknown-property rejection | spec output |
| `DatabaseService`/RLS role switch | new transaction patterns | `database.int-spec.ts` unchanged and green; `SET LOCAL lock_timeout` does not leak across pooled connections | INT-PG output |
| Schema/engine sync + drift job | script rewrite | `sync-schema.spec.ts` AC-A-09 to 18 still pass; `template-deps/` byte-identical | spec output |
| CI | new jobs/config | workflow still runs; INT-PG job separate | CI log |
| Body limit on other routes | scoped parser | other JSON routes still reject bodies over 100 KB | E2E |
| Catalog/auth/team (any merged foundation modules) | none intended | their suites unchanged | suite output |

## 12. Security and concurrency verification

**Security:** (all tier E2E over real DB unless noted)

| # | Scenario | Expected |
|---|---|---|
| S1 | No/invalid token on every route | 401 |
| S2 | Staff on every route including reads and image list | 403 |
| S3 | Platform Admin without membership; user not in tenant header | 403 |
| S4 | Owner and Manager allowed on all routes | 2xx per contract |
| S5 | Cross-tenant store/template/version/product/collection/resource ids | identical 404 to a random UUID; no body or timing difference asserted beyond status/body |
| S6 | Version id from another template; template from another store | 404 |
| S7 | Shared row id on generic routes and page id on shared routes | 404 |
| S8 | Mass assignment: unknown fields, `tenantId`, `status`, `isDefault`, `label` in bodies | 400, no write |
| S9 | Foreign-tenant or traversal image paths in documents | validation error before any query |
| S10 | Storage listing with crafted tenant/prefix inputs | cannot widen results (LIVE) |
| S11 | Error bodies for DB faults | no SQL, no constraint names |
| S12 | Oversized body unauthenticated | rejected at limit |
| S13 | RLS direct: `authenticated` role without `store:manage` role cannot write the three tables (INT-PGLITE) | denied |

**Concurrency/failure matrix** (every row needs its test before any "race solved" claim):

| Scenario | Expected behaviour / HTTP | DB state | Rollback | Env |
|---|---|---|---|---|
| Two saves same revision | one 200, one 409 with `currentRevision` | one revision bump | n/a | INT-PG |
| Autosave vs publish | publish sees stale -> 409 or publishes validated draft; never an unvalidated draft | version doc equals phase-1 doc | yes | INT-PG |
| Concurrent publishes | one version, other `unchanged` | one new row | n/a | INT-PG |
| Publish vs unpublish | serialized, consistent pointer | pointer matches last winner | n/a | INT-PG |
| 499 versions, two publishes | one 200, one `QUOTA_EXCEEDED` | exactly 500 rows | yes | INT-PG |
| Concurrent creates/duplicates/restores at 99 active | total never exceeds 100 | <=100 active | yes | INT-PG |
| Assign vs archive same template | no assignment lands after archive wins | none invalid | yes | INT-PG |
| Assign vs delete | FK/lock prevent orphan | consistent | yes | INT-PG |
| Overlapping bulk assigns | no deadlock | both consistent or one waits | yes | INT-PG |
| Concurrent default swaps | exactly one default, no unique violation | one `is_default` | yes | INT-PG |
| Concurrent first shared saves | one 200, one 409 | one row, revision 1 | n/a | INT-PG |
| Held lock past timeout | 409 `busy` | unchanged | yes | INT-PG |
| Forced deadlock | 409 `busy` | unchanged | yes | INT-PG |
| Injected failure at version insert / pointer update / late step | 5xx or mapped error, no internals | no new version, same pointer, same draft/revision | yes | INT-PG |
| Double click / refresh / timeout retry | publish/rollback/unpublish/archive/restore/set-default: idempotent; create/duplicate: second resource (D29) | per decision | n/a | INT-PGLITE + E2E |
| Missing image at publish | 422 `MISSING_ASSET` (PROPOSED) + paths | unchanged | yes | LIVE |
| Storage SQL denied/unavailable | safe failure, no publish | unchanged | yes | LIVE |
| Archived / invalid resource | 409 `archived` / validation | unchanged | n/a | INT-PGLITE |
| Max size (262,144 jsonb bytes) / over | saves / validation error; body limit 413 above route cap | per case | n/a | E2E |
| Null / malformed JSON values | validation error | unchanged | n/a | UNIT + E2E |

Not claimed solved: image deleted after the existence check (platform has no reference lock; accepted limitation, D8/D9).

## 13. Deployment and rollback plan

1. **Config:** no new secrets planned; `LOCK_TIMEOUT` constant (value BLK-7); optional `SWAGGER_ENABLED` already exists. Feature flags: none found in the repo (R8); none invented. Control exposure by deploying the module only when ready and by the existing environment-driven configuration.
2. **Migration order:** none. Do not run any migration.
3. **Order:** merge foundation (BLK-1) -> engine sync commit -> Phase 5 PRs -> deploy to a development environment -> run LIVE gate and the manual QA -> staging with the real project -> production.
4. **Monitoring:** 5xx rate, 409 `busy`, lock-wait and deadlock counts (Postgres logs), p95 latency of list/publish, pool saturation. The repo has no metrics stack (NOT VERIFIED); log lines via the existing JSON logger.
5. **Rollback triggers:** any cross-tenant exposure, duplicate versions/defaults, pool exhaustion, sustained `busy` errors, wrong quota counts.
6. **Application rollback:** revert the deploy; the module only adds routes. **Data:** no schema change to undo; created templates, versions and assignments are ordinary rows; versions are immutable and never deleted; repair duplicates/extras by archive or (for never-published templates) delete through the API. Forward-fix only for data; nothing is irreversible beyond normal row creation.
7. **Integrity checks after deploy:** one default per kind per store; version numbers contiguous per template; no assignment pointing at an archived template created after release; counts within quotas.

## 14. Go / No-Go criteria

GO only if every item is true with recorded evidence; otherwise NO-GO/BLOCKED:
- All 21 ACs individually PASS (section 15) with automated output, manual QA record and evidence-index entry.
- `INT-PG` suite green on independent connections; fault-injection and quota/lock tests green; list performance numbers recorded.
- `LIVE-SUPABASE` gate green (Storage, tenant RLS, pooler).
- Security matrix S1-S13 green; regression matrix green; existing CI jobs green.
- BLK-1 to BLK-7 resolved and OQ-1 to OQ-12 answered or explicitly accepted as limitations.
- No open critical/high defect; rollback procedure reviewed; no migration, service-role use or generated-file edit in the diff.

## 15. AC-by-AC traceability

Status for every row: **NOT TESTED**. "Existing" = what the repo evidences today. Screenshot means Swagger UI capture (section 10) plus the non-screenshot evidence named.

| AC | Original wording | Existing | Required changes | Planned verification | Screenshot / alt. evidence |
|---|---|---|---|---|---|
| AC-LIFE-001 | Create a template from an approved preset. | table, grants, `getPresetDocument` in source engine; no route | Task 1.1, 2.3 | INT-PGLITE create all kinds/presets, invalid cases; INT-PG concurrent creates at quota | `AC-LIFE-001/01-request.png,02-response.png` + SQL row |
| AC-LIFE-002 | Duplicate an existing template. | none; no whole-document clone in engine | 2.1b, 2.3 | UNIT fresh ids; INT-PGLITE copy rules; INT-PG quota race | AC-LIFE-002 shots + SQL ids differ |
| AC-LIFE-003 | Rename templates with 1–80 character validation at both application and database boundaries. | DB check `templates_name_check` | 2.1a, 2.3 | UNIT code points; INT-PGLITE `23514` mapping, duplicates allowed | AC-LIFE-003 shots |
| AC-LIFE-004 | Archive and restore templates while retaining assignments. | status column, default check, FK | 2.3 | INT-PGLITE no-ops/assignments retained; INT-PG restore quota race | AC-LIFE-004 shots + SQL assignments |
| AC-LIFE-005 | Require `expectedRevision`. | `revision` trigger | 2.4, body limit | INT-PGLITE outcomes; INT-PG concurrent saves; E2E body limit | AC-LIFE-005 shots + SQL revision |
| AC-LIFE-006 | Publishing must: 1. Validate the document. 2. Verify image existence. 3. Lock the template. 4. Compare the expected revision. 5. Insert the next immutable version. 6. Move the published pointer. All database mutations must happen in one transaction. | version trigger, pointer FK | 2.5 | INT-PGLITE (image-free), INT-PG order/atomicity, LIVE images | AC-LIFE-006 shots + version/pointer SQL |
| AC-LIFE-007 | Reject publishing when: validation fails; images are missing; revision is stale. The existing draft and published version must remain unchanged. | none | 2.5 | INT-PGLITE validation/stale; LIVE missing image; SQL before/after equality | AC-LIFE-007 shots + SQL diff |
| AC-LIFE-008 | Unpublish by nulling the published pointer. Preserve historical versions and verify the approved fallback chain. | 0014 resolver (read only) | 2.5 | INT-PGLITE resolver output assigned/default/registry; INT-PG publish vs unpublish | AC-LIFE-008 shots + resolver JSON |
| AC-LIFE-009 | Rollback must create a new immutable version. Verify `source = 'rollback'`; `rolled_back_from`; strictly increasing version numbers; original draft remains unchanged; version ownership and tenant isolation. | CHECK `rollback_source_check`, FK | 2.5 | INT-PGLITE fields, cross-template/tenant ids; INT-PG numbering | AC-LIFE-009 shots + SQL |
| AC-LIFE-010 | Restore an older version into the mutable draft. | none | 2.4 | INT-PGLITE outcomes; INT-PG vs autosave | AC-LIFE-010 shots + SQL |
| AC-LIFE-011 | Swap defaults atomically. | unique index, active check | 2.3 | INT-PGLITE; INT-PG concurrent swaps | AC-LIFE-011 shots + SQL one default |
| AC-LIFE-012 | One shared assignment service must handle: template-kind assignments; product assignments; collection assignments; single assignment; bulk assignment; unassignment; same-store restrictions; same-tenant restrictions; resource existence; template-kind compatibility. | table, FKs, trigger 0015 | 2.6 (wording of "template-kind" OPEN, OQ-4) | INT-PGLITE validations; INT-PG races/atomicity | AC-LIFE-012 shots + SQL |
| AC-LIFE-013 | Enforce: 100 active templates. 500 archived templates. Verify actual approved quota definitions and counting semantics before implementation. Use the existing store-row locking approach where supported. | `LIMITS` constants only; no store lock in migrations | 2.3 (semantics D6 PROPOSED, OQ-3) | INT-PGLITE limits; INT-PG races; RLS check of store `FOR UPDATE` | AC-LIFE-013 shots + SQL counts |
| AC-LIFE-014 | Enforce 500 versions per template. Migration and rollback versions count. Historical versions must never be deleted to free capacity. | trigger numbering, no cap | 2.5 | INT-PG 499/500 races, mixed sources, no deletes | AC-LIFE-014 shots + SQL counts |
| AC-LIFE-015 | Every action must enforce `store:manage`. (Owner, Manager allowed; Staff, Platform Admin, Anonymous, Different tenant denied.) Verify both application checks and database RLS. | RLS policies; `can()` source in `store-forge`; no guards on this branch | foundation guards (BLK-1), per-route decorator | E2E matrix S1-S7; INT-PGLITE RLS S13 | AC-LIFE-015 role/route table output |
| AC-LIFE-016 | Check referenced images during publishing. Referenced files must never be deleted by lifecycle operations. | none; no reference lock | 2.1c, 2.5 | UNIT collector parity; LIVE existence; code review/grep that no delete path exists | AC-LIFE-016 shots + grep output |
| AC-LIFE-017 | Verify concurrent autosaves and publishes against real PostgreSQL. PGlite alone is insufficient evidence for real parallel transaction behavior. | single-session PGlite only | 4.1, 5.3 | INT-PG suite section 12 | test output + lock traces (no screenshot meaningful) |
| AC-LIFE-018 | Inject failures inside publishing transactions. Prove that no partial version or pointer update remains. | none | 5.3 | INT-PG temporary-trigger faults at 3 points, publish and rollback | test output + SQL before/after |
| AC-LIFE-019 | Image listing must only expose the caller's approved tenant/store storage prefix. Existing Storage policies must remain intact. | policies 0006 (not executed) | 2.7, 5.5 | LIVE isolation/pagination/size rejection | AC-LIFE-019 shots + LIVE output; policies diff empty |
| AC-LIFE-020 | Deletion is permitted only when: the template has never been published; it has no assignments. Otherwise, archive it. | RLS delete policy + FK | 2.3 | INT-PGLITE reasons, migration-version, zero-row; INT-PG races | AC-LIFE-020 shots + SQL |
| AC-LIFE-021 | Shared documents must be created lazily on first edit. Until then, registry defaults remain the source of the effective document. | unique index, 0014 NULL fallback | 2.4, 2.8 | INT-PGLITE all four kinds; INT-PG first-save race | AC-LIFE-021 shots + SQL |

Counts: 21 ACs identified; 21 with a planned verification scenario; 0 verified.

## 16. Future closeout report format

Produce after execution, from real runs only:

```text
## Ticket Summary  — Ticket ID: PHASE-5 | Title | Implementation branch | PR | Environment tested | Build/version | QA execution date
## Acceptance Criteria Results
| AC ID | Acceptance criterion | Result (PASS|FAIL|BLOCKED|NOT TESTED|PARTIAL) | Automated test evidence | Manual QA result | Screenshot evidence | Defect/reference |
## Screenshot Evidence Summary
| AC ID | Screenshot path | What it proves | Actual application verified? |
## Test Execution Summary
| Test layer | Total | Passed | Failed | Skipped | Evidence |   (UNIT, INT-PGLITE, INT-PG, LIVE-SUPABASE, E2E, MOCK)
## Defects and Remaining Risks  (severity per item)
## Final QA Verdict  — PRODUCTION READY | READY WITH CONDITIONS | NOT READY | BLOCKED, with supporting evidence
```
Totals come from runner JSON output, never estimated. PASS is forbidden on assumption, code reading or a developer statement; a skipped test is not a pass.

## 17. Open questions and owner decisions

| ID | Question | Owner |
|---|---|---|
| OQ-1 | Larger body limit applies to restore-version routes although their bodies carry no document (F1): drop them or justify? | foundation owner |
| OQ-2 | Is the D25/D28 no-op recognised before phase 1's validation/image check, so a retry after a committed publish still succeeds if an image is gone (F2)? | Sibi / decision author |
| OQ-3 | D6 quota meaning and D27 definition (PROPOSED); owner unidentified | product owner |
| OQ-4 | AC-012 "template-kind assignments" wording; batch cap 100; inactive resources; `absent` outcome (D31-D33, D40, D32) | ticket owner |
| OQ-5 | Evidence directory: `screenshots/PHASE-5/` (requested) vs `screenshots/store-forge-api/<PR>/` (foundation plan) | Sibi |
| OQ-6 | Playwright/browser for Swagger screenshots: allowed to add? Foundation plan C-10 says unavailable by default | foundation owner |
| OQ-7 | Fixed names for the four shared-document rows | product owner |
| OQ-8 | Is the missing-asset test strategy acceptable: INT-PG uses image-free documents, asset paths only LIVE or a labelled stub (F5)? | QA lead |
| OQ-9 | Mirror `document.ts`/`limits.ts` into `templates-engine/` or rewrite imports to `template-deps/` | foundation owner |
| OQ-10 | Which `store-forge` branch is the sync source (`main` vs `feat/template-engine-pr-readiness`; contents not diffed; D-007) | foundation owner |
| OQ-11 | May the pure helpers (Task 2.1) land before the foundation (D4 allows pure-domain work)? | Sibi |
| OQ-12 | Confirm ticket = Phase 5, ID `PHASE-5`, stack as stated (placeholders unfilled) | requester |
| OQ-13 | Confirm contents of `feature/nestjs-api-migration` guards/permissions (`store:manage`, tenant header, public routes) after the API rate limit resets | Eshwar |
| OQ-14 | Amend the Grill-Me report for stale facts (PR-B branch claim, Staff/`store/` deletion wording, line count) after BLK-1 | Eshwar |

---

# Additions (review pass; sections 1-17 above are unchanged)

## 18. Gap review

| Gap | Missing in sections 1-17 | AC | Addition | Blocker |
|---|---|---|---|---|
| G1 | No rule that ties a test to an AC, so runner totals cannot be grouped per AC | all | section 19 title convention | none |
| G2 | Traceability lists planned verification but not the evidence set that is *sufficient* for PASS | all | section 19 table | none |
| G3 | Section 8D describes E2E generically; no per-AC journey, no revisit/negative/boundary protocol | all except 017, 018 | section 20 | BLK-1 (test tokens) |
| G4 | "Every action must enforce `store:manage`" has a role matrix but no test that no route escaped the guard | 015 | route-policy test in section 19 | BLK-1 |
| G5 | "Referenced files must never be deleted by lifecycle operations" and "versions never deleted" rest on a grep and on grants | 016, 014 | two negative tests in section 19 | none |
| G6 | Name rule must hold "at both application and database boundaries"; plan tests the app and the `23514` mapping only | 003 | direct-SQL boundary test in section 19 | none |
| G7 | Manual QA has scenarios but no AC mapping, pass criteria or record template | all | section 21 | none |
| G8 | Only release Go/No-Go exists; no objective per-PR review and merge gate; "critical/high defect" is undefined | all | sections 22, 23 | CODEOWNERS handles (BLK-3) |
| G9 | Closeout format lacks PR references, blocker table and how totals are produced | all | section 23 | none |
| G10 | Public resolver (0014) has no Phase 5 route, so AC-008 and AC-021 "fallback" evidence path is unstated | 008, 021 | note in section 19 | none |

Not added (no AC or regression risk supports it): extra UI tests, load testing beyond D36's list measurement, new monitoring infrastructure, a feature-flag mechanism (none exists, section 13).

## 19. AC evidence index and PASS conditions

**Test-title convention (adopted from the repo: `it('AC-A-09: ...')` in `scripts/sync-schema.spec.ts`):** every test supporting an AC starts `AC-LIFE-NNN: ` (a test covering several ACs repeats the prefix per AC it proves). Runner JSON totals are grouped by that prefix. Planned files: UNIT `src/modules/templates/**/*.spec.ts`; INT-PGLITE `src/modules/templates/**/*.int-spec.ts`; INT-PG `test/pg/*.pg-spec.ts`; LIVE `test/live/*.live-spec.ts`; E2E `test/templates.e2e-spec.ts` (all NEW; globs verified against `vitest.config*.ts`, the `pg`/`live` configs are Task 4.1/4.2).

**Evidence index (pre-filled; Result stays `NOT TESTED` until a real run).** Directory for every row: `screenshots/PHASE-5/AC-LIFE-NNN/` holding `transcripts/`, `sql/` (before/after query text and output), optional Swagger captures. "PASS requires" means **all** items present.

| AC | PASS requires (evidence set) | Result |
|---|---|---|
| AC-LIFE-001 | E2E create for `index`/`classic`, `index`/`spotlight`, `product`, `collection` + invalid cases; SQL row (status, `is_default=false`, `revision=1`, pointer NULL, draft equals preset); INT-PG parallel creates at 99 active stay <=100 | NOT TESTED |
| AC-LIFE-002 | UNIT fresh-id test; E2E duplicate; SQL: new ids disjoint from source, 0 assignments, source row unchanged; INT-PG parallel duplicates at 99 | NOT TESTED |
| AC-LIFE-003 | UNIT code points; E2E 400 for 81 code points/whitespace; **INT-PGLITE direct SQL insert/update as `authenticated` with an 81-code-point name fails `23514` with the application bypassed**; duplicate names accepted | NOT TESTED |
| AC-LIFE-004 | E2E archive/restore + repeats; SQL assignments identical before/after, `updated_at` unchanged on no-op; INT-PG concurrent restores near 100 | NOT TESTED |
| AC-LIFE-005 | E2E: missing/non-integer `expectedRevision` -> 400, stale/future/0 on a page template -> 409 with current revision, identical -> `unchanged`; SQL revision +1 exactly once; INT-PG two connections, same revision, one winner | NOT TESTED |
| AC-LIFE-006 | INT-PG statement trace shows lock, revision compare, version insert, pointer update inside one `BEGIN..COMMIT`; SQL published document equals the phase-1 validated document; LIVE image check | NOT TESTED |
| AC-LIFE-007 | E2E validation, stale, missing-image (LIVE) rejections, each with SQL before/after equality of draft, revision, pointer and version count | NOT TESTED |
| AC-LIFE-008 | E2E unpublish; SQL pointer NULL, version count unchanged; direct SQL call of `get_public_template_layout` for assigned, default and neither (G10: no HTTP route is in scope) | NOT TESTED |
| AC-LIFE-009 | SQL `source='rollback'`, `rolled_back_from`, numbers strictly increasing, draft and revision equal before/after; cross-template and cross-tenant version ids -> 404; INT-PG concurrent rollbacks | NOT TESTED |
| AC-LIFE-010 | E2E restore; SQL draft equals migrated historical document, revision +1, version rows unchanged; stale -> 409 | NOT TESTED |
| AC-LIFE-011 | E2E; SQL exactly one default per kind; INT-PG concurrent swaps with no surfaced unique violation | NOT TESTED |
| AC-LIFE-012 | E2E matrix: single, bulk, unassign, both kinds, cross-store, cross-tenant, nonexistent, archived, duplicate-in-batch, 100/101; SQL all-or-nothing; INT-PG overlapping bulks | NOT TESTED |
| AC-LIFE-013 | INT-PGLITE at 99/100 and 499/500; INT-PG parallel creates/duplicates/archives/restores; test that store `FOR UPDATE` succeeds for Owner and Manager and fails for Staff under real RLS; OQ-3 answered | NOT TESTED |
| AC-LIFE-014 | INT-PG at 499/500, all three sources counted; SQL no version row ever deleted; **INT-PGLITE: `DELETE` on `template_versions` as `authenticated` is denied** | NOT TESTED |
| AC-LIFE-015 | **Route-policy test: enumerate every route from the booted app/OpenAPI document and assert each Phase 5 route carries the `store:manage` guard (G4)**; E2E role x route matrix (Owner, Manager, Staff, Platform Admin, anonymous, other tenant x 27 routes) with recorded statuses; INT-PGLITE RLS denial with the application guard bypassed | NOT TESTED |
| AC-LIFE-016 | UNIT collector parity; LIVE existing and missing objects; **static test: no Storage write or delete statement or client call exists under `src/modules/templates`** | NOT TESTED |
| AC-LIFE-017 | INT-PG outputs per section 12 rows; each scenario records connection count >=2, winner, loser and final state | NOT TESTED |
| AC-LIFE-018 | INT-PG fault matrix, 3 injection points x publish and rollback; fixture proves its triggers are dropped afterwards; SQL equality of versions, pointer, draft, revision | NOT TESTED |
| AC-LIFE-019 | LIVE: own prefix only, other tenant absent, malformed prefix, pagination, page-size rejection; **`pg_policies` for `storage.objects` captured before and after the run and identical**; E2E page-size validation | NOT TESTED |
| AC-LIFE-020 | E2E matrix: never published, published, assigned, both, migration version; SQL unchanged on rejection; INT-PG delete vs assign and vs publish | NOT TESTED |
| AC-LIFE-021 | E2E all four kinds before and after first save; SQL row (`revision=1`, not published); INT-PG concurrent first saves; resolver SQL before/after publish | NOT TESTED |

Evidence sufficiency: a screenshot, an API transcript alone, or a mock never satisfies a persistence, isolation, atomicity or concurrency row. Rows marked LIVE stay BLOCKED (never PASS) until BLK-6 is resolved.

## 20. E2E journey protocol (backend-only; real HTTP)

No AC is user-visible in a merchant UI, so Playwright screenshots of a merchant screen do not exist. If OQ-6 allows a browser, Playwright captures only the real Swagger UI (`/api/docs`) driving the real running API; those captures are supporting evidence, never the proof (section 10). Journeys (each uses a real token from the foundation test kit, a dedicated seeded database tier, and no intercepted or mocked responses):

| Journey | Covers | Steps |
|---|---|---|
| J1 create, get, list | 001, 003, 021 reads | create each kind/preset; GET; list page 1 and 2 |
| J2 duplicate | 002 | duplicate an edited-unpublished template; compare ids and content in SQL |
| J3 edit lifecycle | 005, 006, 007, 008, 009, 010, 014 | save, publish, publish again, unpublish, republish, rollback, rollback again, restore into draft; each rejection variant |
| J4 state changes | 004, 011, 013, 020 | archive, restore, set default, delete eligible and ineligible, quota fixtures |
| J5 assignments | 012 | single, bulk, replace, unassign, rejection variants |
| J6 shared documents | 021, 005..010 for shared | the four kinds from no-row to published |
| J7 images | 016, 019 | LIVE gate only |
| J8 authorization sweep | 015 | role x route matrix and the route-policy test |

Per step: (1) capture pre-state with SQL; (2) send the HTTP request and record status and body; (3) capture post-state with SQL on an **independent connection**; (4) **revisit**: a fresh HTTP connection `GET` of the same resource, and a new database session read, both must equal step 3; (5) run the negative and boundary variants for that operation (stale revision, maximum-size document, 81-code-point name, quota edge, forged id); (6) save the transcript and SQL under the AC directory. Concurrency and fault ACs (017, 018) are INT-PG tests, not E2E journeys, and carry no screenshots.

## 21. Manual QA additions

Mapping to section 9: MQ-1 -> 001, 003; MQ-2 -> 002; MQ-3 -> 003; MQ-4 -> 004; MQ-5 -> 005; MQ-6 -> 006, 007, 008; MQ-7 -> 009, 014; MQ-8 -> 010; MQ-9 -> 011; MQ-10 -> 012; MQ-11 -> 013, 014; MQ-12 -> 015; MQ-13 -> 021; MQ-14 -> 020; MQ-15 -> 016, 019. **AC-LIFE-017 and 018 have no manual scenario** (they are not reproducible by hand); their evidence is automated only, and this is stated in the closeout.
A manual tester records, per MQ: environment, role and tenant used, request sent, response status and body, the SQL query run and its result, pass/fail against the expected column, and initials and date, stored as `screenshots/PHASE-5/manual-qa/MQ-NN.md`. A manual result of PASS requires the independent SQL check; Swagger output alone is not enough.

## 22. PR review and merge-readiness gates

Proposed PR grouping (follows the existing commit boundaries; sequencing per BLK-1/BLK-2): **P5-0** Task 1.1; **P5-1** Tasks 2.1, 2.2 and 4.1; **P5-2** Tasks 2.3, 2.4; **P5-3** Task 2.5; **P5-4** Tasks 2.6, 2.7, 2.8; **P5-5** evidence and QA report. A PR may merge only when **all** hold:

1. CI green: typecheck, lint, format:check, unit, e2e, PGlite int, build, schema-drift (a SKIPPED drift job is not mergeable); the INT-PG job green once Task 4.1 exists.
2. Diff gates (checked by `git diff main...HEAD --stat` and grep): no file under `migrations-snapshot/`, `schema/`, `template-deps/` or `templates-engine/` changed except by the sync script; no new migration; no service-role usage; no import of any catalog module; every file under 500 lines.
3. Every AC the PR touches has filled evidence-index rows from real runs, with no `PASS` lacking evidence; the PR description lists every BLOCKED and NOT TESTED AC verbatim and every D-number it relies on, with PROPOSED ones marked as such.
4. Review by the CODEOWNERS owners for shared paths (`/src/infrastructure/`, `/src/common/`, `/src/config/`, `/.github/`); Santu's handle is still pending in `CODEOWNERS` (BLK-3). No direct push to `main`.
5. The security rows (section 12) relevant to the PR pass, and no open Critical or High defect (section 23).
6. A downstream PR starts only after its prerequisite is merged and builds on merged code, never on interfaces that exist only in a plan.

## 23. Final QA report additions

Extends section 16 (which stays the base format):
- **Ticket information:** ticket ID, title, **one row per PR** (P5-0..P5-5) with number, branch, merge commit, CI run link.
- **AC rows:** one per original AC (21), never combined; status only PASS/FAIL/BLOCKED/NOT TESTED/PARTIAL; each PASS row cites the evidence-index entry and the runner file.
- **Test totals** come only from the runner JSON files under `screenshots/PHASE-5/test-output/`, grouped by tier and by `AC-LIFE-NNN:` title prefix; the exact reporter flags are confirmed when first run (NOT VERIFIED here); skipped tests are counted as skipped, never as passed.
- **Defect severity:** Critical = cross-tenant exposure, authorization bypass, data corruption, partial write after a failure, quota exceeded; High = AC behaviour wrong or a concurrency invariant broken without data harm, internals leaked in an error; Medium = status or body differs from the approved contract; Low = documentation or cosmetic. Go/No-Go (section 14) blocks on any open Critical or High.
- **Blockers table:** `| ID | blocker | affected ACs | owner | status | evidence of resolution |`, carried from section 4 and 17.
- **Verdict** is one of the four allowed values and cites the evidence index; with any LIVE row BLOCKED the verdict can be at best READY WITH CONDITIONS and only if policy allows, otherwise BLOCKED.
- Stored at `screenshots/PHASE-5/QA-REPORT.md`, linked from `evidence-index.md`.

## Final Plan Additions and Readiness

1. **Gaps identified:** G1-G10 (section 18).
2. **Additions made:** AC-prefixed test titles, a pre-filled 21-row evidence index with PASS conditions, new negative tests (DB-boundary name check, version-delete denied, route-policy guard coverage, no Storage mutation in the module, `pg_policies` before/after), an E2E journey protocol with revisit and negative steps, MQ-to-AC mapping and a manual QA record, PR grouping and merge gates, defect severity definitions, and extra closeout fields.
3. **AC traceability coverage:** 21 of 21 ACs have a verification scenario (section 15) and a PASS evidence set (section 19). 0 are verified.
4. **E2E and screenshot requirements:** real HTTP journeys J1-J8, independent SQL and revisit checks, backend-only evidence by transcripts and SQL, optional Swagger UI captures only if OQ-6 allows a browser; no merchant-UI screenshot is claimed anywhere.
5. **Final QA reporting:** section 16 plus section 23, totals from runner JSON only.
6. **Remaining genuine blockers:** BLK-1 to BLK-7 and OQ-1 to OQ-14 (sections 4, 17); in particular the foundation reconciliation (BLK-1), PR #2 merge, owner answers on quota/AC wording, and Docker/CI/live Supabase access.
7. **Readiness:** the plan is complete as a document, but **implementation is blocked by dependencies**, except Task 1.1 (after PR #2 merges) and Task 2.1 (if OQ-11 allows). File length now exceeds the repository's 500-line guideline; split only if reviewers require it.
