# PR-D Public Storefront Implementation and QA Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Expose the five public storefront reads (D-013) through the NestJS API with a fail-closed cutover gate and a shared public rate limit, and prove each AC-D criterion with reproducible evidence.

**Architecture:** Thin service over the existing `SECURITY DEFINER` functions, called through `DatabaseService.withPublic`; no new SQL, no migration. Transport, module layout and guard wiring are **BLOCKED on BLK-1** and are deliberately not designed here.

**Tech Stack:** NestJS 12, Drizzle/postgres-js, PGlite and Docker PostgreSQL for tests, Supabase (live gate). Nothing in this plan has been run.

## Global Constraints

- Planning only. Every status is NOT TESTED / NOT IMPLEMENTED until real execution evidence exists. Nothing here is VERIFIED.
- Source of truth for behaviour: the database functions (migrations 0009, 0011, 0014, 0016, read not executed) and the approved foundation requirements (`docs/superpowers/plans/2026-11-10-store-forge-api-foundation.md` §8, §9: D-013, D-019, D-015, D-011). The foundation plan is not edited by this document.
- Phase 5 (`docs/plans/PHASE-5-…`) is closed and untouched. Nothing here changes its decisions.
- **BLOCKED until BLK-1 (foundation reconciliation) is explicitly decided:** endpoint paths and HTTP methods; header conventions; request/response envelopes; pagination contracts; guards and authentication integration; module structure and transport-level code; final Eshwar/Santu ownership. Santu's branch `feature/nestjs-api-migration` is **unverified** (inventory read only; controllers, guards, services, tests not reviewed) and is neither adopted nor re-implemented here.
- Public rate limit (D-019, copied from the foundation plan): default 60 per minute per client IP, one shared bucket, 429 with `Retry-After`; `TRUST_PROXY` default disabled, takes a hop count, never trusts arbitrary `X-Forwarded-For`.
- DB role `storeforge_app` only; no service-role key, no `DIRECT_URL` (D-010). No migration is part of PR-D.

---

## 1. Scope and acceptance criteria (wording preserved)

PR-D = "public storefront (D-013), Eshwar" (foundation plan §8; final ownership BLOCKED). Five operations: `get_public_storefront`, `get_public_template_layout`, `get_public_product`, `get_public_collection`, `get_public_collections`. Out of scope: `getPublicBranding` (OPEN, see PD-5), engine composition and rendering (stay in Next.js, D-005/D-006 OPEN).

| AC | Decision | Criterion (verbatim from the foundation plan §8) |
|---|---|---|
| AC-D-01 | D-013 | all five operations implemented |
| AC-D-02 | D-013 | no user session required (request without `Authorization` succeeds) |
| AC-D-03 | D-013 | responses match the frontend contracts (`storefrontSchema`, `PageData` in `store-forge/services/storefront*.service.ts`) using fixtures copied from them |
| AC-D-04 | D-013 | gate fails closed: false, missing function and database error each return the disabled result |
| AC-D-05 | D-013 | unknown, inactive and suspended slugs are indistinguishable; no private tenant or admin field in any response |
| AC-D-06 | D-019 | the five routes share the public bucket; over the limit gives 429 |
| AC-D-07 | D-015 | Swagger lists the five routes as public |

Seven ACs. The plan has no ticket document beyond these rows; no AC is added or reinterpreted.

## 2. Repository evidence

| # | Finding | Source | Status |
|---|---|---|---|
| E1 | Latest `get_public_storefront(p_slug text)` is the 0011 `CREATE OR REPLACE` (0009 + a `template` key); `STABLE SECURITY DEFINER`, `search_path=''`, `EXECUTE` to `authenticated` only | `migrations-snapshot/0009…`, `0011…` | read |
| E2 | `get_public_template_layout(p_slug, p_kind, p_resource_slug default null)`, `get_public_product(p_slug, p_product_slug)`, `get_public_collection(p_slug, p_collection_slug)`, `get_public_collections(p_slug)` | `0014_public_template_reads.sql` | read |
| E3 | `template_engine_cutover_complete()` is true only for a well-formed `complete` row; the marker table is unreachable by the app role | `0016_template_engine_cutover.sql` | read |
| E4 | Frontend calls them in `withPublicContext` (no user identity); orchestration `loadStorefrontPage` / `loadStorefrontPageIfEnabled` in `services/storefront-template.service.ts`; schemas `storefrontSchema` (`services/storefront.service.ts`) and payload schemas in `storefront-template.service.ts` | `store-forge` `main`, read via `gh` | read |
| E5 | Frontend gate `services/engine-cutover.service.ts`: open only when the function returns exactly `true`; any error, missing function or non-boolean means closed | same | read |
| E6 | `DatabaseService.withPublic(fn)` exists on `feat/pr-a-database-foundation` (PR #2 open) | `src/infrastructure/database/database.service.ts:116` | read |
| E7 | `PageData` type and the `AC-SF-001..020` renderer contract live in `store-forge` `components/storefront/engine/types` and `loadStorefrontPage`; not read in full | `store-forge` | NOT VERIFIED |
| E8 | Santu's branch lists `GET /public/storefronts/:slug` (#3) and `GET /public/branding` (#2) as implemented; the other four operations are absent ("anything template-related" excluded) | `docs/API_ENDPOINT_INVENTORY.md` on that branch | unverified claim |
| E9 | No `PublicRateLimitGuard`, `@ApiPublic()`, or error `code` exists in this repo yet (PR-B scope) | `src/common`, `src/app.setup.ts` | verified |

## 3. Behaviour contracts (derived from the database; transport shape BLOCKED)

All five return `jsonb` or `NULL` and are called with no user identity. Common rules: a `NULL`/malformed slug (`is_valid_store_slug`), an unknown store, a store whose `status <> 'active'`, or a tenant whose `status <> 'active'` yields `NULL`. Active products/collections only. No `tenant_id`, `store_id`, `updated_at` is ever returned.

| Operation | Input | Success payload (keys) | Bounds and order | Other `NULL` cases |
|---|---|---|---|---|
| storefront | `slug` | `name, slug, description, logo_path, currency, products[], template` (`template` = `{key, accent_color, hero_heading, hero_subheading, hero_image_path}` or `null`) | products <=48, `created_at desc, slug`; product item `{name, slug, short_description, price_minor, compare_at_price_minor, created_at, image_path}` | none |
| layout | `slug, kind, resourceSlug?` | `{source: 'assigned'\|'default'\|null, template: {name, version_number, document}\|null, theme, groups: {header, footer, announcement}}` | chain: assigned (active, published) then default (active, published) else `null` (app falls back to registry defaults); unknown resource slug = no assignment | `kind` not in `index, product, collection` |
| product | `slug, productSlug` | `{store{name,slug,description,logo_path,currency}, product{name,slug,description,short_description,product_type,sku,price_minor,compare_at_price_minor,has_variants,category_name}, images[], options[], variants[] (active only), related[]}` | related <=8, same category or shared collection | product missing or not active |
| collection | `slug, collectionSlug` | `{store{…}, collection{id,name,slug,description,image_path}, products[]}` | products <=48, `position, created_at desc, slug` | collection missing or not active |
| collections | `slug` | `[{id, name, slug, description, image_path, product_count}]` | <=100, `name, slug` | `NULL` (not `[]`) when the store is invalid; `[]` when valid with none |

Gate: `template_engine_cutover_complete()` returns `boolean`; **closed** for `false`, missing function, any error, or a non-boolean (E5). Which operations are gated and what the "disabled result" is per operation: OPEN (PD-2, PD-O1).
Note (recorded, not decided): product and variant payloads include `sku` and UUIDs of images/variants/collections, as the frontend payload schemas expect; the 0009 header comment says the *storefront list* carries no SKUs. AC-D-05's "no private field" test must use an explicit forbidden-key list (section 9) rather than assume.

## 4. Decision register (PR-D only)

| ID | Decision | Status |
|---|---|---|
| PD-1 | Five operations via `DatabaseService.withPublic`, no session, no new SQL, no migration (D-013, D-011) | APPROVED (foundation plan); NOT IMPLEMENTED |
| PD-2 | Gate fail-closed: open only on exactly `true`; false, missing function, error, non-boolean all closed (AC-D-04, E5) | APPROVED semantics. Gated: layout, product, collection, collections. Disabled result = null (PD-O1 APPROVED) |
| PD-3 | Unknown, inactive, suspended and malformed slugs are indistinguishable (all `NULL` in SQL) (AC-D-05, PD-O3 APPROVED) | APPROVED at DB level; transport mapping BLOCKED |
| PD-4 | Public rate limit values per D-019 (see Global Constraints), one bucket for all five routes | APPROVED values; proxy topology OPEN (foundation plan); wiring BLOCKED (BLK-1, PR-B guards) |
| PD-5 | `getPublicBranding` (`get_public_platform_settings`) stays out of PR-D | OPEN (D-013 note); Santu's branch includes it, unverified |
| PD-6 | Engine/`PageData` composition stays in Next.js; the API returns function payloads matching payload Zod schemas (PD-O2 APPROVED) | APPROVED |
| PD-7 | Test the five functions at the database level now (no foundation dependency) | APPROVED |
| PD-O1 | Gate scope: gate the 4 template-engine-era operations (layout, product, collection, collections); legacy `get_public_storefront` remains open; disabled result = `null` (not found) | APPROVED |
| PD-O2 | AC-D-03 matches payload Zod schemas (keep `PageData` in frontend per PD-6) | APPROVED |
| PD-O3 | Malformed slug returns `null` (indistinguishable from unknown/inactive/suspended) | APPROVED |
| PD-O4 | Caching of public reads: none | APPROVED |

## 5. Business logic and database interactions (transport-independent)

- One service unit (location BLOCKED) with five methods: `getStorefront(slug)`, `getTemplateLayout(slug, kind, resourceSlug?)`, `getProduct(slug, productSlug)`, `getCollection(slug, collectionSlug)`, `getCollections(slug)`. Each runs `select public.<fn>(...) as r` inside `DatabaseService.withPublic` and returns the parsed payload or `null` (never `undefined`, never an empty object for not-found). Use the repo's `rowsOf` helper.
- Gate helper: `isEngineReadEnabled(): Promise<boolean>` = `try { function() === true } catch { false }`, in its own `withPublic` call, evaluated per request (no cache, no env flag), mirroring E5.
- Bound values are passed as parameters only; slugs are never concatenated into SQL.
- Errors: a database failure on a data function is not "not found": it surfaces as the shared unknown error without internals (D-021 contract, BLOCKED shape).
- No write path exists in PR-D; nothing is idempotency-sensitive.

## 6. Security, data integrity and failure scenarios

| Scenario | Expected | Env |
|---|---|---|
| Request with no `Authorization` | succeeds (AC-D-02) | E2E (BLOCKED transport) + INT: `withPublic` runs with no claims |
| Unknown / inactive-store / suspended-tenant / malformed slug | identical response, `null` payload (AC-D-05) | INT-PGLITE |
| Response key scan | no `tenant_id`, `store_id`, `user_id`, `owner`, `email`, `cost`, `quantity`/stock, draft product (explicit list; `sku` handled per section 3 note) | INT-PGLITE |
| Cutover pending / function dropped / DB error | closed, per PD-2 | INT-PGLITE + fault case |
| Over 60/min/IP across any mix of the five routes | 429 + `Retry-After` | E2E (BLOCKED) |
| `X-Forwarded-For` spoofing with `TRUST_PROXY` off | ignored | E2E (BLOCKED) |
| SQL injection in slug / resource slug | parameterised; `NULL` | INT-PGLITE |
| Database outage | shared error, no internals; gate closed | INT + fault |
| Pooler behaviour (`prepare:false`, `withPublic` role switch) | works | LIVE-SUPABASE (G-LIVE) |

Not claimable from PGlite: multi-instance rate limiting and hosted pooler behaviour.

## 7. Dependencies and sequencing

| Needs | For | Status |
|---|---|---|
| PR-A (`DatabaseService.withPublic`, test kit) | everything | PR #2 open |
| PR-B (`PublicRateLimitGuard`, trust-proxy, `@ApiPublic()`, error contract, Swagger setup) | AC-D-02 over HTTP, 06, 07 | no PR-B branch; competing branch unverified (BLK-1) |
| PR-C | none | n/a |
| `zod` as a dev dependency | AC-D-03 fixtures, if the frontend schemas are copied verbatim | OPEN (also pending in Phase 5 Task 1.1) |
| Live Supabase project and `.env.local` confirmation | pooler/live gate | BLOCKED (foundation plan G-LIVE) |

Sequence: T-D0 -> T-D1, T-D2 (run on PR-A alone) -> T-D3 -> [BLK-1] -> T-D4, T-D5 -> T-D6.

## 8. Tasks

- [x] **T-D0: Inspection & Decisions Alignment**
  - Read `PageData`, `loadStorefrontPage`, `isEngineReadEnabled` in `store-forge`.
  - Settle PD-O1 (gate 4 template-engine functions, legacy `get_public_storefront` open, disabled = `null`).
  - Settle PD-O2 (AC-D-03 matches payload Zod schemas; `PageData` remains in frontend).
  - Settle PD-O3 (malformed slug returns `null` to ensure indistinguishability with unknown/inactive/suspended).
  - Settle PD-O4 (no caching).
  - Record decision notes in `screenshots/store-forge-api/PR-D/evidence-index.md`.

- [ ] **T-D1: Database-Level Contract Suite for the Five Functions**
  - Create integration test suite using `createTestDatabase` harness with PGlite & real migrations 0000-0024.
  - Test all five functions under `withPublicContext` with zero identity claims:
    1. `get_public_storefront` (legacy storefront payload)
    2. `get_public_template_layout` (assigned, default, fallback)
    3. `get_public_product` (store, product, variants, images, options, related)
    4. `get_public_collection` (store, collection, products)
    5. `get_public_collections` (collection list with counts)
  - Assert bounds (products <= 48, related <= 8, collections <= 100) and ordering.
  - Assert indistinguishability (unknown, inactive store, suspended tenant, malformed slug all yield `NULL`).
  - Assert security: scan all payloads for forbidden keys (`tenant_id`, `store_id`, `user_id`, `owner`, `email`, `cost`, draft products).
  - Assert cutover gate SQL function `template_engine_cutover_complete()`.
  - Capture test output and SQL transcripts under `screenshots/store-forge-api/PR-D/`.

- [ ] **T-D2: Golden Payloads and Fixture Schema Assertions**
  - Define golden fixture payloads matching the frontend Zod schemas (`storefrontSchema`, `layoutPayloadSchema`, `publicProductPayloadSchema`, `publicCollectionPayloadSchema`, `publicCollectionsListSchema`).
  - Add schema validator test verifying golden fixtures and function outputs conform to contract.

- [ ] **T-D3: Service Unit with Cutover Gate Helper**
  - Implement `StorefrontService` (or transport-independent module service) calling `DatabaseService.withPublic`:
    - `getStorefront(slug)`: ungated, returns parsed payload or `null`.
    - `getTemplateLayout(slug, kind, resourceSlug?)`: gated, returns parsed payload or `null` if disabled/not found.
    - `getProduct(slug, productSlug)`: gated, returns parsed payload or `null` if disabled/not found.
    - `getCollection(slug, collectionSlug)`: gated, returns parsed payload or `null` if disabled/not found.
    - `getCollections(slug)`: gated, returns parsed list or `null` if store invalid/disabled.
    - `isEngineReadEnabled()`: cutover gate returning `false` on any error, missing function, or non-true result.
  - Unit tests for service and gate helper (fake DB error, missing function, non-boolean return).

- [ ] **T-D4: Transport Layer (Routes, DTOs, @ApiPublic)** *(BLOCKED on BLK-1, PR-B)*
  - Expose 5 HTTP endpoints with DTO validation and Swagger annotations.

- [ ] **T-D5: Shared Public Rate Limiting** *(BLOCKED on BLK-1, PR-B)*
  - Apply 60/min/IP shared throttler bucket with `Retry-After`.

- [ ] **T-D6: Evidence Index & Final QA Report**
  - Populate `screenshots/store-forge-api/PR-D/evidence-index.md` and complete QA report.

Test code is written test-first at execution against the merged foundation (as the foundation plan does); it is not invented here. Ownership: foundation plan says Eshwar; final split BLOCKED.

## 9. Test plan

- **Unit:** gate helper (exactly-`true`, false, thrown error, non-boolean); payload parsing returns `null` not `undefined`; slug passed as parameter. Mock only the DB call; never mock the SQL functions in contract tests.
- **Integration (INT-PGLITE, real migrations 0000-0024):** seed active store+tenant with products, variants, images, collections, assignments, published templates, theme/groups; assert each payload's keys, limits (48/100/8), ordering, `NULL` cases (unknown, inactive store, suspended tenant, malformed), layout chain (assigned, default, none, archived/unpublished fall-through), forbidden-key scan, gate cases (pending marker, function absent, forced error).
- **API/E2E (BLOCKED transport):** per route: 200 shape against fixtures, no-token success, identical not-found responses, rate limit across the five routes, route-policy test that all five are public.
- **Security:** section 6. **Regression:** `GET /health`, error filter, `withPublic` unaffected for other callers, existing PGlite suite and drift job; Phase 5 and other modules unaffected (route-inventory test).
- **LIVE-SUPABASE:** the five functions through the real pooler with no identity; gate against the real marker.
- Test titles start `AC-D-NN: ` so runner JSON can be grouped per AC.

## 10. AC-by-AC matrix (all NOT TESTED)

| AC | Existing evidence | Required changes | Planned verification | Evidence / screenshot | Blocked by |
|---|---|---|---|---|---|
| AC-D-01 | five SQL functions exist (E1, E2); no API | service + routes (T-D3, T-D4) | INT per operation; E2E route inventory lists five | `AC-D-01/` runner JSON, SQL transcript | transport (BLK-1) for the routes part |
| AC-D-02 | `withPublic` exists (E6) | routes without auth guard | INT: runs with no identity claims; E2E: no `Authorization` header succeeds | transcript | BLK-1 |
| AC-D-03 | frontend schemas (E4) | fixtures + assertions (T-D2) | golden payloads validate against copied schemas; PD-O2 settles target | fixture files + output | PD-O2, zod |
| AC-D-04 | frontend gate (E5); SQL function (E3) | gate helper (T-D3) | three cases: false, function missing, DB error each closed; PD-O1 settles result | runner output + SQL | PD-O1 |
| AC-D-05 | NULL semantics in SQL (E1, E2) | none beyond tests | INT: unknown/inactive/suspended/malformed identical; forbidden-key scan | transcript | PD-O3 |
| AC-D-06 | none | shared limiter on five routes (T-D5) | E2E: mixed requests exceed 60/min -> 429 + `Retry-After`; spoofed XFF ignored | transcript | BLK-1, PR-B |
| AC-D-07 | none | Swagger decorators | spec lists five routes as public; Swagger capture if a browser is available | `swagger/*.png` + `/api/docs-json` | BLK-1, PR-B, browser (foundation plan C-10) |

## 11. Evidence and final QA report

Directory (foundation plan §3 convention): `screenshots/store-forge-api/PR-D/{evidence-index.md, test-output/*.txt|*.json, transcripts/, swagger/*.png}` with `AC-D-NN/` subfolders for per-AC transcripts. Screenshots exist **only** for Swagger (AC-D-07); there is no merchant UI, so no other screenshot is claimed. Sanitise before commit (no `postgres://`, `eyJ`, `sb_`, `apikey`, project refs).
Index row: `| AC | scenario | test title | tier (UNIT, INT-PGLITE, INT-PG, LIVE-SUPABASE, E2E, MOCK) | actual result | evidence path | status |`. PASS needs: automated output + the independent SQL or HTTP transcript; mocks and PGlite never prove rate-limit-across-instances or hosted pooler behaviour.
Final report (written after execution from runner JSON only): ticket PD info and PR reference; seven AC rows with status PASS/FAIL/BLOCKED/NOT TESTED/PARTIAL, automated and manual evidence, screenshot path (Swagger only), defects, blockers, test totals by tier, verdict (PRODUCTION READY / READY WITH CONDITIONS / NOT READY / BLOCKED). Defect severity: Critical = private field exposed or distinguishable slug state; High = gate opens on error, AC behaviour wrong; Medium = contract mismatch; Low = docs. PR merge gate as foundation plan §3 (CODEOWNERS, CI green with drift PASS, index complete, BLOCKED ACs listed verbatim). No feature flag exists; rollback = revert (read-only routes, no data change).

## 12. Blockers and unresolved items

BLOCKED: BLK-1 (transport, guards, envelopes, headers, pagination, module layout, ownership); PR-A merge (PR #2); PR-B (rate-limit guard, `@ApiPublic()`, error contract); live Supabase access; browser for Swagger capture.
OPEN: PD-O1 to PD-O4; PD-5 (`getPublicBranding`); PD-6 (D-005/D-006); proxy topology for `TRUST_PROXY`; whether `zod` is added for fixtures; E7 (`PageData` not read in full).
These are decisions and dependencies, not missing planning work, apart from PD-O1 to PD-O4 which need the next Grill-Me round.
