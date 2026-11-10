# Phase 5 – Template Lifecycle Backend: Final Grill-Me Report

Scope: AC-LIFE-001 to AC-LIFE-021, NestJS-native in `store-forge-api` (D1).
Nature of this document: requirements discovery only. Nothing here is implemented, migrated or run.
Status words follow the session rules: APPROVED, PROPOSED, OPEN, BLOCKED, VERIFIED. **Nothing is VERIFIED**, because no test, build or live check has been executed for any decision.

Sources: the repository at branch `feat/pr-a-database-foundation` (read-only), the engine source on `wnr-group/store-forge` (read-only via `gh`, branch `feat/template-engine-pr-readiness`; `main` also holds 77 files under `lib/templates/`, contents not diffed), and the AC wording supplied in the brief. **The AC-LIFE matrix and the master template-engine plan are not in this repository**, so AC details below are the brief's wording only.

---

## A. Executive verdict

**GRILL-ME COMPLETE. DESIGN DECISIONS RECORDED. READY FOR IMPLEMENTATION PLANNING, SUBJECT TO DOCUMENTED DEPENDENCIES.**

This is design completion, not implementation readiness or production readiness.

- Lifecycle implementation is gated by **PR-A (open, PR #2) then PR-B (no branch exists) then Phase 5** (D4, D47).
- The only work allowed before that is the engine synchronization commit (D3), and it needs the sync script that currently lives only on the PR-A branch (see G).
- Ownership of Phase 5 is not documented in the repo and needs confirmation.
- Several business rules are PROPOSED or OPEN and belong to people outside this session (G).

A correction to an earlier message in this session: the endpoint inventory has **27** endpoints, not 31.

---

## B. Decision register (D1–D51)

| ID | Decision | Status | ACs |
|---|---|---|---|
| D1 | Phase 5 is built NestJS-native in this repo; no hybrid | APPROVED | all |
| D2 | Template engine has one source (`store-forge`), delivered by extending the read-only sync; no hand copies, no shared package | APPROVED | 001,002,005–007,009,010,016,021 |
| D3 | Sync a subset into `src/infrastructure/templates-engine/` with directory structure, explicit allowlist, unclassified-file drift failure, `registry.ts` vs `registry/index.ts` resolved and tested; separate first commit | APPROVED. Engine availability is PROPOSED (not compiled, linted or parity-tested) | same |
| D4 | Phase 5 waits for PR-B; PR-B owner and merge date unknown; error codes go through the PR-B owner | APPROVED. PR-B dependency OPEN | all |
| D5 | Quota-affecting operations take the store row `FOR UPDATE` first, then template rows in ascending id; advisory lock is the fallback; no migration | APPROVED. Owner/Manager RLS compatibility and concurrency UNVERIFIED | 001,002,004,013 |
| D6 | The 100 active / 500 archived quotas count `index`, `product`, `collection` only; shared documents exempt, not archivable, not duplicable | PROPOSED (owner of D6/D27 unidentified; repo has no definition) | 001,002,004,013,021 |
| D7 | Archiving the default clears `is_default` atomically, no promotion, assignments kept; restore never reinstates the default | APPROVED. Resolver compatibility supported by reading 0014, not tested | 004,008,011 |
| D8 | Two-phase publish: read, validate and check images outside the transaction; then lock, compare revision twice, insert version, move pointer | APPROVED. Storage deletion race OPEN (confirmed gap, see D9) | 006,007,016,017,018 |
| D9 | Image existence via a batched SQL query on `storage.objects` as the authenticated user, outside the transaction; no service-role key; fallback is Storage HTTP with the caller's JWT | APPROVED. Real-Supabase access, RLS, deletion visibility and pooler behaviour OPEN. No reference lock exists: platform limitation | 006,007,016,019 |
| D10 | Rollback runs the full publish pipeline on the stored source version; restore-into-draft validates only; `migrateDocument` runs first and never mutates the source | APPROVED. `schemaVersion` behaviour read from `migrate.ts` (v1 is current, steps empty), not tested | 009,010 |
| D11 | Any active page-kind template in the store may become default, published or not; swap is clear-then-set; unpublishing the default is allowed | APPROVED | 011,008 |
| D12 | Delete rejects with `CONFLICT` reasons `published` / `assigned` (both if both); never auto-archives; checked under the template lock; 23503 and RLS zero-row mapped | APPROVED. Structured reasons OPEN pending PR-B | 020 |
| D13 | First edit of a shared document sends `expectedRevision: 0`; insert-if-absent, loser gets `CONFLICT` with current revision; no auto-publish | APPROVED. Whether a store lock is needed OPEN (test decides) | 021,005 |
| D14 | Bulk assignment is atomic; validate everything first and report all failures; no partial mode | APPROVED | 012 |
| D15 | Assigning replaces an existing assignment; same template is a no-op; duplicates in one batch rejected | APPROVED. Upsert/RLS compatibility UNVERIFIED | 012 |
| D16 | No new or replacement assignment to an archived template; unassign and replace-away are allowed; unpublished active templates are assignable | APPROVED | 012,004 |
| D17 | Image listing is exactly `{tenantId}/store/` direct children in bucket `products`, tenant from membership, `{ items, total, page, pageSize }`; no per-store claim | APPROVED. Real-Supabase isolation and pagination OPEN | 019 |
| D18 | Cross-tenant and nonexistent ids return the same `NOT_FOUND`; Staff gets 403 on every endpoint incl. reads; no privileged lookups | APPROVED. Matrix subject to PR-B guards | 015 |
| D19 | Concurrency evidence on throwaway Docker PostgreSQL (`INT-PG`); Storage and pooler evidence on the approved Supabase project only (`LIVE-SUPABASE`); CI must not silently downgrade to PGlite | APPROVED. Docker/CI/TCP/live-gate checks OPEN | 013,014,016–019 |
| D20 | No name uniqueness; trim; 1–80 Unicode code points; whitespace-only rejected; no NFC; `23514` maps to `VALIDATION`; duplicate name `Copy of <name>` truncated to 80 code points | APPROVED | 001–003 |
| D21 | Duplicate copies the current draft with fresh ids, starts active, non-default, unpublished, revision 1, no assignments; archived source allowed; shared kinds rejected; invalid source draft rejected; no image check | APPROVED. Fresh-id logic is new service code | 002,013 |
| D22 | Read set is minimal: list templates, get template, list versions, get version, get shared document, list images | APPROVED | 005,006,009,010,019,021 |
| D23 | All routes nested under `/api/v1/stores/:storeId/…`; images at `/api/v1/template-images`; POST sub-resource actions; store-in-tenant, template-in-store, version-in-template checks | APPROVED | 015 |
| D24 | `expectedRevision` only on save draft, publish, restore-version, shared save; identical save is `unchanged`; rollback needs no revision | APPROVED | 005,006,007,010,017,021 |
| D25 | Publish is a no-op only when already published and unchanged; republish after unpublish creates a new version | APPROVED | 006,014 |
| D26 | Archived page templates are frozen except read, restore, duplicate, delete (if eligible), unassign, rename; the rest return `CONFLICT` reason `archived` | APPROVED | 004–011 |
| D27 | Shared documents addressed by kind with eight routes; no rename/archive/restore/duplicate/delete/default/assign; fixed server-side names | APPROVED. Name constants OPEN | 021 |
| D28 | Rollback is a no-op when the migrated source equals the live document | APPROVED | 009,014 |
| D29 | Create and duplicate are not idempotent; documented retry limitation; no idempotency infrastructure | APPROVED | 001,002,013 |
| D30 | Create body `{ kind, presetKey?, name }` strict; `presetKey` required for `index` only; new template never default; returns full template (`201`) | APPROVED | 001 |
| D31 | Assignment service handles product/collection rows only; kind compatibility is a validation; `index` uses the default operation | PROPOSED. AC-012 wording OPEN (ticket owner) | 012 |
| D32 | One array-based assign endpoint (`PUT`) and one unassign endpoint (`POST …/unassign`), per-item outcomes | APPROVED. `absent` outcome PROPOSED | 012 |
| D33 | Provisional batch cap of 100 items, one named constant | PROPOSED (ticket owner to confirm) | 012 |
| D34 | Extend the shared error contract with `QUOTA_EXCEEDED` (409), `MISSING_ASSET` (422) and optional `details`; preferably in PR-B | APPROVED as a request. Statuses and detail schemas PROPOSED | 005,007,012–014,016,020 |
| D35 | Unpublish on an unpublished template is a no-op; archived rejects; default stays default | APPROVED | 008 |
| D36 | List computes the four-state publication status in one SQL query; versions list is metadata-only; performance measured, no invented threshold | APPROVED. Measurement pending | 006,008 |
| D37 | Publish and rollback always return `200` with `outcome` (`published`/`rolled_back`/`unchanged`) | APPROVED | 006,009 |
| D38 | Status/body table for the other operations (summary, `saved`/`unchanged`, `restored`/`unchanged`, `204` delete) | APPROVED | 001–005,008,010,011,020 |
| D39 | Repeated archive/restore are `200` no-ops under the locks; real transitions enforce quotas | APPROVED | 004,013 |
| D40 | Assignment existence checks are direct batched SELECTs on generated `products`/`collections`; no catalog-module dependency | APPROVED. Inactive-resource eligibility OPEN (ticket owner) | 012 |
| D41 | Image references = every image-shaped value (object with string `path`) in the validated document, collected iteratively in `template-media`; engine `isImageShaped` is not exported, so it is reimplemented with parity tests | APPROVED. Parity tests pending | 006,016 |
| D42 | Atomicity proven by database-level fault injection (temporary triggers) in `INT-PG`; no application fault hooks | APPROVED | 007,017,018 |
| D43 | Generic template routes resolve page kinds only; a shared row id returns the same `NOT_FOUND` as a random UUID | APPROVED | 021,015 |
| D44 | Shared routes with no row: versions list is empty, the other five return `NOT_FOUND`, publish never creates a row | APPROVED | 021 |
| D45 | Route-scoped larger JSON body limit (document limit + documented envelope) for the three document-writing route groups only; global 100 KB stays | APPROVED. `413` mapping OPEN; shared-file change needs PR-B | 005,010,021 |
| D46 | Inclusive 500-version cap counted under the template lock after no-op checks, all sources, page and shared | APPROVED | 014 |
| D47 | One `TemplatesModule` with four controllers, five services, `support/`, `dto/` | APPROVED. CODEOWNERS entry OPEN | all |
| D48 | Publish `{ expectedRevision }`, rollback `{ versionId }`, no label input | APPROVED | 006,009 |
| D49 | Fixed sort orders: templates `created_at DESC, id DESC`; versions `version_number DESC`; images `created_at DESC, name ASC` | APPROVED | 019 |
| D50 | Lock matrix (section D.4); assignment uses explicit `FOR SHARE` on targets | APPROVED. Guarantees UNVERIFIED until INT-PG | 004,011–013,017 |
| D51 | `READ COMMITTED`, bounded `LOCK_TIMEOUT`, `55P03`/`40P01` map to `CONFLICT` reason `busy`, no automatic retries | APPROVED. Timeout value and `busy` contract OPEN | 017,018 |

Verified count: **0**.

---

## C. API inventory and contracts

### C.1 Existing versus missing

Existing routes in the repo today: **one**, `GET /api/v1/health` ([health.controller.ts](../../src/modules/health/health.controller.ts)). `AppModule` imports `DatabaseModule` and `HealthModule` only. All 27 Phase 5 endpoints below are **missing**.

Existing building blocks: `DatabaseService.withUser` / `withPublic`, the generated schema, the migration snapshot, the PGlite test kit, the CI workflow, the global `ValidationPipe` (whitelist, forbid unknown) and a single-shape error filter with no `code` field.

Missing foundation (PR-B, not started): JWKS auth and `@CurrentUser()`, `TenantGuard` (`X-Tenant-Id`), `PermissionGuard`/`@RequirePermission`, `AppException` with codes, pagination DTOs, auth test kit.

### C.2 Inventory (27 endpoints)

Base for routes 1–26: `/api/v1/stores/:storeId`. Every endpoint requires `store:manage` (Owner, Manager). Staff, Platform Admin without membership and anonymous callers are denied (D18).

| # | Method and path | Purpose (AC) | Request body | Success |
|---|---|---|---|---|
| 1 | `GET /templates` | list page templates (D22) | query `page`, `pageSize` | `200 { items, total, page, pageSize }`, each item a summary with `publicationState` |
| 2 | `POST /templates` | create from preset (001) | `{ kind, presetKey?, name }` | `201` full template |
| 3 | `GET /templates/:templateId` | get with draft and revision (D22) | none | `200` full template |
| 4 | `PATCH /templates/:templateId` | rename (003) | `{ name }` (derived from D20; PROPOSED) | `200` summary |
| 5 | `DELETE /templates/:templateId` | safe delete (020) | none | `204` |
| 6 | `POST /templates/:templateId/duplicate` | duplicate (002) | none | `201` full template |
| 7 | `POST /templates/:templateId/archive` | archive (004) | none | `200` summary |
| 8 | `POST /templates/:templateId/restore` | restore (004) | none | `200` summary |
| 9 | `PUT /templates/:templateId/draft` | save draft (005) | `{ expectedRevision, document }` | `200 { outcome: saved\|unchanged, template }` |
| 10 | `POST /templates/:templateId/publish` | publish (006,007) | `{ expectedRevision }` | `200 { outcome: published\|unchanged, version, template }` |
| 11 | `POST /templates/:templateId/unpublish` | unpublish (008) | none | `200` summary |
| 12 | `GET /templates/:templateId/versions` | version metadata (D22) | query `page`, `pageSize` | `200` page of `{ id, number, source, rolledBackFrom, label, publishedAt, publishedBy }` |
| 13 | `GET /templates/:templateId/versions/:versionId` | one version with document (D22) | none | `200` |
| 14 | `POST /templates/:templateId/rollback` | rollback (009) | `{ versionId }` | `200 { outcome: rolled_back\|unchanged, version, template }` |
| 15 | `POST /templates/:templateId/restore-version` | restore into draft (010) | `{ versionId, expectedRevision }` (derived from D10/D24; PROPOSED) | `200 { outcome: restored\|unchanged, template }` |
| 16 | `POST /templates/:templateId/default` | set default (011) | none | `200` summary |
| 17 | `PUT /template-assignments` | assign / replace, single or bulk (012) | `{ assignments: [{ resourceType, resourceId, templateId }] }`, max 100 (D33, PROPOSED) | `200 { results: [{ …, outcome: created\|replaced\|unchanged }] }` |
| 18 | `POST /template-assignments/unassign` | unassign (012) | `{ resources: [{ resourceType, resourceId }] }` | `200 { results: [{ …, outcome: removed\|absent }] }` (`absent` PROPOSED) |
| 19 | `GET /shared-documents/:kind` | effective shared document | none | `200`, registry default with `revision: 0` when no row |
| 20 | `PUT /shared-documents/:kind` | save, first save uses `expectedRevision: 0` (021) | `{ expectedRevision, document }` | as route 9 |
| 21 | `POST /shared-documents/:kind/publish` | publish | `{ expectedRevision }` | as route 10 |
| 22 | `POST /shared-documents/:kind/unpublish` | unpublish | none | as route 11 |
| 23 | `GET /shared-documents/:kind/versions` | versions | paging | as route 12; empty page when no row |
| 24 | `GET /shared-documents/:kind/versions/:versionId` | one version | none | as route 13 |
| 25 | `POST /shared-documents/:kind/rollback` | rollback | `{ versionId }` | as route 14 |
| 26 | `POST /shared-documents/:kind/restore-version` | restore into draft | `{ versionId, expectedRevision }` | as route 15 |
| 27 | `GET /api/v1/template-images` | list images (019) | query `page`, `pageSize` | `200` page of `{ path, name, size, mimeType, createdAt }` |

Notes:
- `kind` in routes 19–26 is `theme_settings`, `group_header`, `group_footer` or `group_announcement`.
- Create accepts `index`, `product`, `collection`; `presetKey` (`classic`/`spotlight`) is required for `index` and rejected for the other two.
- `pageSize` is one of 10, 20, 50, 100 (planned D-022; default 20). Invalid values return `VALIDATION`, never clamped. These conventions come from the foundation plan and are not yet implemented.
- "Template summary" = `{ id, kind, name, status, isDefault, revision, publicationState, publishedVersionId }`, never a document body. "Full template" = summary plus `draft`.
- `publicationState` is one of `archived`, `draft`, `published`, `published_with_changes`.
- The tenant comes only from `X-Tenant-Id` after membership verification (D-020, planned), never from body, query or path.
- Not exposed: rename/archive/restore/duplicate/delete/default/assign for shared documents; any search, filter, quota-usage, assignment-list or preview endpoint (D22, D27).
- Archived page templates reject save, publish, unpublish, rollback, restore-version, set-default and new assignment (D26).

### C.3 Error behaviour (all subject to the PR-B contract)

| Situation | Response |
|---|---|
| Invalid token | `UNAUTHENTICATED` 401 |
| Missing or malformed `X-Tenant-Id` | 400 (D-020) |
| No active membership, Platform Admin, Staff | `FORBIDDEN` 403 |
| Cross-tenant, nonexistent, mismatched store/template/version, shared row on generic route | identical `NOT_FOUND` 404 |
| Invalid input, invalid or unsupported document, name rule, `23514` | `VALIDATION` 400, validator issues in `details.issues` |
| Stale or future `expectedRevision`, archived, published/assigned delete, `23503`, `23505` race, busy | `CONFLICT` 409 with `details` (`currentRevision`, `reasons`, `items`, `reason: busy`) |
| Quota full (100 active, 500 archived, 500 versions) | `QUOTA_EXCEEDED` 409 (PROPOSED), `details { quota, limit }` |
| Referenced image missing | `MISSING_ASSET` 422 (PROPOSED), `details.missingPaths` |
| Oversized document body | `413` (shared code OPEN) |
| Unexpected database error | shared unknown/500, no internals |

---

## D. Architecture

### D.1 Module structure (D47)

```
src/modules/templates/
  templates.module.ts
  controllers/  templates · shared-documents · template-assignments · template-images  (.controller.ts)
  services/     template · template-publish · template-assignment · template-query · template-media  (.service.ts)
  support/      lock-order.ts · template-errors.ts · limits.ts
  dto/          request and response DTOs
```

Generated, read-only: `src/infrastructure/templates-engine/` (D3). Existing generated `template-deps/` stays unchanged.
Rules: thin controllers, shared lifecycle services parameterized by kind, `DatabaseService.withUser`, kebab-case files, ESM `.js` imports, files under 500 lines, no import of any catalog module.

### D.2 Engine synchronization (D2, D3)

Source of truth is `wnr-group/store-forge` `lib/templates/` (77 files). Facts read from the source:
- External imports are only `zod` (`^4.6.7` in the frontend; the backend has no `zod` dependency yet) plus two `@/lib/...` imports in `resolve.ts`, which is renderer-side and excluded.
- The current `scripts/sync-schema.mjs` copies only `document.ts` and `limits.ts` (hard-coded loop) and flattens `lib/templates/*` into `template-deps/`. It must be extended to preserve directories, take an allowlist, and fail on unclassified files under the source directories.
- `registry.ts` and `registry/index.ts` coexist; the script resolves `.ts` before `index.ts`, so `./registry` would pick `registry.ts`. This is an import-resolution test case.
- Engine files import `../document` and `../limits`. Whether those are mirrored into `templates-engine/` or rewritten to the existing `template-deps/` copies is **OPEN** (sync design detail; both keep a single source).

Starting classification (from reading; the dependency closure must be computed in the sync commit):

| Class | Files |
|---|---|
| Include (validator, registry, presets, defaults) | `engine/{bindings,compile,descriptor-check,descriptors,image-scan,migrate,root-schema,schema,size,tree-ids,tree-walk,tree,validate}.ts`, `registry/**` (index, blocks, sections, presets, `theme-settings`), `registry.ts`, `presets.ts`, `document.ts`, `limits.ts` |
| Classify during sync work | `engine/{fonts,measure,richtext,tenant-cache}.ts` (`measure` imports `size`; `richtext` imports `bindings`), `types.ts`, `legacy-resync.ts` |
| Exclude (renderer-only, D3) | `resolve.ts`, `form-state.ts`, `variant-selection.ts`, `breakpoints.ts`, `engine/theme-css.ts` |

Gates before the engine counts as available (none run yet): successful sync; no unexpected omissions; `tsc` and lint pass; import-resolution tests; validator parity tests on shared fixtures (including a page document with no `layout` and an unsupported `schemaVersion`); the image-collector parity test (D41).

### D.3 Database, RLS, tenant isolation (from migrations 0012–0015, 0006)

- Everything runs through `DatabaseService.withUser` as `storeforge_app` with `SET LOCAL ROLE authenticated`; RLS is the second layer, application checks the first. No service-role access anywhere in this module.
- Grants: `templates` insert `(tenant_id, store_id, kind, name, is_default, draft)`, update `(name, status, is_default, draft, published_version_id)`, delete; `template_versions` insert and select only; `template_assignments` insert, update `(template_id)`, delete. `id`, `revision` and timestamps are not client-writable.
- Triggers: `revision` bumps only when `draft` changes; `version_number` is `max+1` under a template-row lock; `template_assignments_before_write` copies the kind and raises 23503 for a foreign-store template (0015).
- Constraints relied on: name check, one default per store/kind, default must be active, one shared document per kind per store, assignment kind/resource checks, document size and `schemaVersion` checks (the engine measures size as jsonb text length to match).
- Delete: RLS allows it only with no version rows (a `migration` version counts); the foreign key blocks it with assignments. The service checks eligibility under the lock because RLS zero-row deletes are silent.
- Not enforced by the database (so enforced in the app): quotas (100/500/500), name uniqueness (none by decision), image existence.
- Storage: bucket `products` is public-read; policies key on the first path segment (tenant), Staff can delete catalog images, and **no reference lock exists** (existing platform limitation, no new mechanism). Template images must live under `{tenantId}/store/`; that folder is shared by all stores of a tenant.
- Storefront fallback (0014, read not tested): assigned (active, published) then default (active, published) then registry defaults. An archived or unpublished template, or a store with no default, falls through without error.
- No new migration is proposed. No database gap was found that the approved design cannot cover; the gaps that need a migration (name uniqueness, durable idempotency, a quota trigger, per-store image prefixes, a Storage reference lock) are deliberately out of scope.

### D.4 Transactions, locks, concurrency (D5, D8, D24, D25, D28, D50, D51)

Isolation: `READ COMMITTED`; checks run after taking the lock. `SET LOCAL lock_timeout` from one named constant (value OPEN). No automatic retries.

| Operation | Locks, in order |
|---|---|
| Create | store `FOR UPDATE` |
| Duplicate | store `FOR UPDATE`; source read unlocked |
| Archive, restore | store, then template `FOR UPDATE` |
| Set default | store, then old and new default `FOR UPDATE` by ascending id |
| Assign, bulk assign | target templates `FOR SHARE` by ascending id (the foreign key's key-share lock does not conflict with an archive's no-key-update, so this is explicit) |
| Unassign | none beyond row writes |
| Publish, unpublish, rollback | template `FOR UPDATE` |
| Save draft, restore-version, rename | template `FOR UPDATE`, revision checked |
| Delete | template `FOR UPDATE` |
| Shared first save | unique-index conflict handling, no extra lock |

Rules: store lock always before template locks; a template-only transaction never later takes the store lock; no store-wide lock for every mutation.

Publish pipeline (D8): phase 1 reads draft and revision, validates with the synced engine (tenant id from membership), collects images (D41), checks existence via one SQL query (D9); phase 2 locks the template, compares the locked revision to both the phase-1 revision and `expectedRevision`, applies the no-op check (D25), checks the 500-version cap (D46), inserts the version, moves the pointer. Rollback follows the same shape with the source version read from the database and `migrateDocument` before validation (D10, D28).

Residual risk that stays open: an image can be deleted by another authorized actor between the check and the commit; the platform has no reference lock.

### D.5 Storage

Existence and listing use SQL on `storage.objects` under the user's role and the existing `products_objects_select` policy; no Storage HTTP calls on the primary path. PGlite skips `storage.objects`, so nothing about Storage can be proven there. Fallback (D9) is Storage HTTP with the caller's JWT using plain `fetch`.

### D.6 Shared-file changes that need PR-B coordination

| File or contract | Change | Why | Decision |
|---|---|---|---|
| `src/common/` error contract and filter | codes `QUOTA_EXCEEDED`, `MISSING_ASSET`; optional `details`; `busy` reason; `413` mapping | structured conflicts, quotas, assets | D34, D45, D51 |
| `src/app.setup.ts` / `src/main.ts` | route-scoped JSON limit for the three document-writing groups, registered ahead of the default parser; default parser behaviour confirmed first with a real request | valid documents up to the engine limit exceed the 100 KB default (not yet reproduced) | D45 |
| `src/app.module.ts` | one-line `TemplatesModule` import | module registration | D47 |
| `.github/CODEOWNERS` | optional entry for `/src/modules/templates/` | ownership | D47 (OPEN) |
| Guards and decorators | consume PR-B's actual `TenantGuard`, permission guard and test kit; nothing is wired against a plan | authorization | D4, D18 |
| `lock_timeout` value | confirm against pooler and connection limits | bounded waits | D51 |

No Santu-owned file is modified, and no catalog module is imported (D40).

---

## E. Test strategy

Evidence labels (D19): `INT-PGLITE` single-session PGlite; `INT-PG` real PostgreSQL, independent TCP connections, throwaway Docker database with migrations 0000–0024 and the auth/role stubs; `LIVE-SUPABASE` the approved Supabase project, Storage and pooler checks only; `MOCK` mocks, never counted as database or Storage proof. Unit tests (pure logic) are labelled `UNIT`. HTTP-level tests run through the real Nest pipeline and are labelled `E2E` plus the database tier they use. There is no UI in scope, so no screenshots are produced; Swagger screenshots only if a browser is available (foundation plan C-10).

| Area | Tier | Scenarios |
|---|---|---|
| Pure logic | UNIT | name trim and code-point length; document id regeneration and ordering preserved; image collector parity with `scanImageValues`; revision comparison and no-op detection; batch cap constant; publication-state mapping |
| Engine sync | UNIT/script | sync output, allowlist, unclassified-file failure, `registry` resolution, compile, lint, validator parity fixtures |
| State and responses | INT-PGLITE | every operation's success status and body; no-op cases (identical save/restore, set-default, unpublish, archive/restore repeats, publish/rollback no-ops); archived allow-list and rejections; shared-document no-row table; generic-route `NOT_FOUND` for shared rows; delete eligibility reasons and `23503`/zero-row mapping; assignment validations, replace, duplicate-in-batch, archived target; resolver output (assigned, default, registry default); RLS role matrix at the database level |
| Concurrency and atomicity | INT-PG | concurrent saves, autosave vs publish, concurrent publishes (one version), publish vs unpublish, concurrent rollbacks, 499/500 version cap races, create/duplicate/restore at quota limits, concurrent default swaps, assignment vs archive and vs delete, overlapping bulk assignments (no deadlock), lock timeout and forced deadlock mapping, autosaves of different templates not serialized, shared first-save race, fault injection by temporary triggers (version insert, pointer update, late step) for publish and rollback, plus default swap and bulk assignment, no application fault hooks |
| Performance | INT-PG | list of 100 templates with large documents in all four states: query count, execution time, no N+1; record numbers, no invented threshold |
| Storage and pooler | LIVE-SUPABASE | `storage.objects` SELECT as authenticated, tenant-scoped RLS, cross-tenant isolation, missing-object detection, Storage-API deletion visible to the SQL check, listing prefix/pagination/page-size rejection, `SET LOCAL ROLE` through the real pooler and `DatabaseService`; no destructive suites on the shared project |
| HTTP and security | E2E (PGlite or PG) | auth matrix per route (Owner, Manager allowed; Staff incl. reads, Platform Admin, anonymous, other-tenant, no-membership denied); forged store/template/version/product/collection ids give identical `NOT_FOUND`; body limit behaviour (default parser checked first, largest valid document saves, oversized document `VALIDATION`, oversized body `413`, other routes keep 100 KB); strict DTO rejection of unknown fields (including `label`); no internals in error bodies; OpenAPI lists every route, orders and limits |
| Regression | UNIT/E2E | existing health route and the existing e2e path assertion are updated intentionally by PR-B, not by Phase 5 |

Rules: a PGlite single-connection run never counts as concurrency proof; a mock never counts as Storage proof; a skipped test is never a pass.

---

## F. Acceptance-criteria traceability

AC text is the brief's wording; the source matrix is unavailable, so no further detail is invented. Every row is **designed, not implemented, not verified**.

| AC | Requirement (brief) | Decisions | Endpoints | Verification tiers |
|---|---|---|---|---|
| 001 | Create from approved preset | D30, D5, D6, D29, D3 | 2 | UNIT, INT-PGLITE, INT-PG (quota) |
| 002 | Duplicate | D21, D20, D29, D5, D6 | 6 | UNIT, INT-PGLITE, INT-PG |
| 003 | Rename, 1–80 | D20 | 4 | UNIT, INT-PGLITE |
| 004 | Archive/restore, assignments kept | D7, D26, D39, D5 | 7, 8 | INT-PGLITE, INT-PG |
| 005 | Save draft with `expectedRevision` | D24, D45, D13 | 9, 20 | INT-PGLITE, INT-PG, E2E |
| 006 | Publish pipeline | D8, D25, D37, D41, D46, D9 | 10, 21 | INT-PGLITE, INT-PG, LIVE-SUPABASE |
| 007 | Rejected publish leaves state unchanged | D8, D24, D34, D41 | 10, 21 | INT-PGLITE, INT-PG |
| 008 | Unpublish, fallback chain | D35, D11, D26 | 11, 22 | INT-PGLITE (resolver) |
| 009 | Rollback creates new version | D10, D28, D37, D46, D18 | 14, 25 | INT-PGLITE, INT-PG |
| 010 | Restore version into draft | D10, D24, D26 | 15, 26 | INT-PGLITE, INT-PG |
| 011 | Default swap atomic | D7, D11, D38, D50 | 16 | INT-PGLITE, INT-PG |
| 012 | One assignment service | D14–D16, D31–D33, D40, D50 | 17, 18 | INT-PGLITE, INT-PG |
| 013 | Quotas 100 / 500 | D5, D6, D26, D29, D39, D50 | 2, 6, 7, 8 | INT-PG |
| 014 | 500 versions per template | D46, D25, D28 | 10, 14, 21, 25 | INT-PG |
| 015 | `store:manage` enforcement | D18, D23, D34, PR-B guards | all | E2E, INT-PGLITE (RLS), INT-PG |
| 016 | Image existence on publish | D9, D41 | 10, 14, 21, 25 | UNIT, LIVE-SUPABASE |
| 017 | Real-PostgreSQL concurrency | D19, D50, D51 | all mutating | INT-PG |
| 018 | Publish atomicity | D42 | 10, 14, 21, 25 | INT-PG |
| 019 | Tenant-restricted image listing | D17, D49, D9 | 27 | LIVE-SUPABASE |
| 020 | Safe deletion | D12 | 5 | INT-PGLITE, INT-PG (race) |
| 021 | Lazy shared documents | D13, D27, D43, D44, D6 | 19–26 | INT-PGLITE, INT-PG |

Evidence per AC (per the foundation plan's convention, proposed here): an index under `screenshots/store-forge-api/Phase-5/` with AC id, scenario, test name, actual result, evidence path, tier label and status; raw test output from the real run; SQL results or transaction traces for concurrency; the permission matrix output for AC-015. Final statuses use DONE / PARTIALLY VERIFIED / FAILED / BLOCKED / NOT VERIFIED / NOT IMPLEMENTED, and DONE only with real evidence.

---

## G. Dependencies, blockers and unresolved items

### G.1 External dependencies and team confirmations

| Item | Owner | Status |
|---|---|---|
| PR-A merge (PR #2 open) | foundation owner | OPEN, no date |
| PR-B (auth, guards, errors, pagination, test kit, parser, wiring): no branch exists | PR-B owner | OPEN, owner and date unknown |
| Phase 5 ownership; CODEOWNERS entry | Sibi / foundation owner | OPEN. The onboarding doc and the plan assign Phase 5 to no one; the brief says Eshwar |
| Error contract: `details`, two codes, `busy`, `413`, status mappings, SQLSTATE mapping | PR-B owner | OPEN (PROPOSED) |
| Quota semantics (D6) and the original D6/D27 | owner unidentified | OPEN |
| AC-012 "template-kind assignments"; batch size; inactive-resource eligibility | ticket owner | OPEN |
| Shared-document row-name constants | product owner | OPEN |
| `LOCK_TIMEOUT` value vs pooler limits | shared connection owner | OPEN |

### G.2 Repository verification still to do

- Engine dependency closure and sync-script extension; whether `document.ts`/`limits.ts` are mirrored or rewritten (D3).
- The sync script and spec exist only on the PR-A branch, so the sync commit either waits for PR-A to merge or stacks on that branch (OPEN).
- Which `store-forge` branch is the sync source: the engine is present on both `main` and `feat/template-engine-pr-readiness` (77 files each), contents not compared (foundation plan D-007 is OPEN).
- Default body-parser behaviour reproduced with a real request (D45).
- Store-row `FOR UPDATE` works for Owner and Manager under 0002/0006 grants and RLS (D5).
- `INSERT … ON CONFLICT` upsert passes both insert and update policies (D15).
- Whether shared-document first save needs a store lock (D13).
- The Next.js renderer's handling of a NULL default and NULL shared groups (0014 returns NULL and defers to registry defaults; the renderer is outside this repo).

### G.3 Credentials, configuration, infrastructure

- Docker PostgreSQL test setup over real TCP with the migration snapshot and auth/role stubs; CI Docker or a PostgreSQL service container (D19). If CI cannot run it, record the limitation; do not fall back to PGlite.
- Approved Supabase project live gates (G-LIVE), `.env.local` project confirmation; the `storage.objects` and pooler checks are BLOCKED until then (foundation plan marks them BLOCKED).

### G.4 Risks, by priority

1. **Security:** cross-tenant id probing (D18); Staff reads denied while RLS permits them (app check is the first layer); Storage has no reference lock, so published images can be deleted by other actors; pre-auth body parsing size (D45).
2. **Data integrity:** quotas have no database backstop (D5, D46); no name or idempotency guarantees by decision (D20, D29); version-cap-reached templates can only be continued by duplication (D46).
3. **Concurrency:** the lock matrix is untested (D50); the `FOR SHARE` vs archive interaction is the least certain point; PGlite cannot prove any of it (D19).
4. **Regression:** PR-B will intentionally change the health e2e assertion and error shape; Phase 5 depends on those merged shapes.
5. **Performance:** four-state publication status compares large jsonb documents per row (D36); no approved performance target exists.
6. **Integration:** engine sync fit unproven; Storage SQL path unproven on the real pooler; validator size measured as jsonb text length must match the database check exactly.

---

## H. Implementation sequence and PR boundaries

Gate: PR-A merged, then PR-B merged, then Phase 5. Plans must use this register and not reopen approved decisions without new evidence.

| Step | Content | Gate |
|---|---|---|
| 0 | Send the coordination requests in G.1 (error contract, parser, `AppModule`, ownership, quota semantics, batch size, lock timeout, AC wording) | none; this is a message, not code |
| 1 | **Engine sync commit** (separate and first): extend `scripts/sync-schema.mjs` and its spec, generate `src/infrastructure/templates-engine/`, add `zod`, compile, lint, import-resolution and validator-parity tests; `template-deps/` unchanged | PR-A's sync script must exist on the base; no PR-B dependency |
| 2 | PR-B (foundation owner): guards, `AppException` plus the D34 extension, pagination DTOs, test kit, body-parser change (D45), module registration support | external |
| 3 | Phase 5 commits on merged PR-B, each with its tests: (a) `support/` and DTOs; (b) `template-query.service` plus read routes 1, 3, 12, 13, 19, 23, 24; (c) `template.service` lifecycle (create, duplicate, rename, archive, restore, delete, default, draft save, restore-version); (d) `template-publish.service` (publish, unpublish, rollback) for page templates; (e) `template-assignment.service` plus routes 17, 18; (f) `template-media.service` plus route 27, collector, existence check; (g) shared-document controller reusing the services; (h) `TemplatesModule` registration |
| 4 | Evidence phase: `INT-PG` concurrency and fault-injection suite, performance measurement, `LIVE-SUPABASE` gate, AC evidence index, OpenAPI check |
| 5 | Final QA report from real runs |

Rollback strategy: Phase 5 adds routes and one module without schema changes, so reverting the PRs removes the feature; there is no data migration to unwind. Created templates, versions and assignments stay as ordinary rows.

---

## I. Production-readiness evidence checklist

Phase 5 is not production-ready until every item below has real evidence (all currently unmet):

- [ ] PR-A and PR-B merged; Phase 5 built on their merged interfaces.
- [ ] Engine sync executed; compile, lint, import-resolution and validator-parity tests passing; drift check fails on an unclassified source file.
- [ ] Store-row lock verified for Owner and Manager under real RLS (`INT-PGLITE` plus `INT-PG`).
- [ ] The whole `INT-PG` suite passes on independent connections: D50 matrix, D24/D25/D28/D46 races, quota limits, lock timeout, deadlock mapping, no unexpected deadlocks.
- [ ] Fault-injection atomicity proven for publish and rollback, with the version table, pointer, draft and revision inspected after each failure.
- [ ] `LIVE-SUPABASE` checks passed: `storage.objects` SELECT, tenant RLS, cross-tenant rejection, missing-object detection, Storage-API deletion visibility, listing and pagination, pooler and `SET LOCAL ROLE`.
- [ ] Authorization matrix passed for every route and every actor; identical `NOT_FOUND` for forged ids; Staff denied on reads.
- [ ] Error contract merged in PR-B and the Phase 5 responses match it; the OPEN codes and the `413` mapping resolved.
- [ ] Body-limit behaviour tested through real HTTP.
- [ ] List performance measured and reported with real numbers; no N+1.
- [ ] Every AC row has a test scenario with a recorded actual result and evidence path; no AC marked DONE without evidence; mocks and PGlite not presented as real-infrastructure proof.
- [ ] Ownership, quota semantics, assignment wording, batch size, inactive-resource rule and name constants confirmed by their owners.
- [ ] Known limitations documented: non-idempotent create/duplicate, no Storage reference lock, shared `store/` image folder per tenant, offset-pagination page shifts, version-cap dead end resolved only by duplication.
- [ ] No migration, service-role usage, edit to a generated file or edit to a Santu-owned file anywhere in the diff.

---

## J. Next step

Hand off to a separate implementation-plan prompt for Phase 5 (AC-LIFE-001–021) that:
- uses this register as fixed input and does not reopen APPROVED decisions without new evidence;
- starts with the engine sync commit and the coordination requests, and stays blocked on PR-A then PR-B for everything else;
- details file-by-file changes, incremental commits with tests, the `INT-PG` and `LIVE-SUPABASE` suites, the security matrix, regression testing, AC evidence capture, production-readiness checks, rollback and a final evidence-based QA report.

No implementation has been started.
