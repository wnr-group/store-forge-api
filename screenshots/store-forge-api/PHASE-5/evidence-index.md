# Phase 5 Evidence Index: Template Lifecycle

## Summary
- **Ticket:** Phase 5 — Template Lifecycle (Store Forge API)
- **Branch:** `feat/phase-5-template-lifecycle`
- **Base:** `42fdd51` (`feat/pr-a-database-foundation` / PR #2)
- **Target Branch:** `main`
- **Owner:** Senior Principal Software Engineer, Database Architect & Senior QA Automation Architect
- **Date:** 2026-11-10
- **Test Suite Status:** 
  - Unit Tests: 114 passed (17 test files)
  - Integration Tests (PGlite + Real PostgreSQL): 30 passed (4 test files)
  - E2E Tests: 33 passed (2 test files)
  - Typecheck: 0 errors (`tsc --noEmit`)
  - Lint: 0 errors, 0 warnings across 103 files (`oxlint --type-aware`)
  - Format: Prettier clean (`prettier --check`)
  - Build: Clean compilation (`nest build`)

## Evidence Matrix (AC-LIFE-001 through AC-LIFE-021)

| AC ID | Requirement & Scenario | Test Location | Actual Result | Evidence Artifact | Tier | Status |
|---|---|---|---|---|---|---|
| AC-LIFE-001 | Create template from approved preset with valid schemaVersion and layout | `test/templates.e2e-spec.ts > AC-LIFE-001`<br>`scripts/sync-schema.spec.ts` | 201 Created with standard response envelope; preset loaded, validated, and persisted | `screenshots/store-forge-api/PHASE-5/test-output/e2e-tests.txt`<br>`unit-tests.txt` | E2E / UNIT | PASS |
| AC-LIFE-002 | Duplicate template with fresh section/block IDs and quota check | `test/templates.e2e-spec.ts > AC-LIFE-002`<br>`src/modules/templates/support/fresh-ids.spec.ts` | 201 Created; all UUID keys in cloned draft are newly generated and distinct | `screenshots/store-forge-api/PHASE-5/test-output/e2e-tests.txt`<br>`unit-tests.txt` | E2E / UNIT | PASS |
| AC-LIFE-003 | Rename with 1–80 character validation; duplicate names permitted | `test/templates.e2e-spec.ts > AC-LIFE-003`<br>`src/modules/templates/templates-lifecycle.int-spec.ts` | 200 OK on valid rename; 400 Bad Request on empty or >80 characters | `screenshots/store-forge-api/PHASE-5/test-output/e2e-tests.txt`<br>`integration-tests.txt` | E2E / INT | PASS |
| AC-LIFE-004 | Archive and restore templates while retaining assignments and clearing isDefault | `test/templates.e2e-spec.ts > AC-LIFE-004`<br>`src/modules/templates/templates-lifecycle.int-spec.ts` | Status transitions `active` -> `archived` -> `active`; `is_default` cleared on archive; assignments retained | `screenshots/store-forge-api/PHASE-5/test-output/e2e-tests.txt`<br>`integration-tests.txt` | E2E / INT | PASS |
| AC-LIFE-005 | Optimistic draft revision checks (`expectedRevision`); conflict on mismatch; no-op on identical draft | `test/templates.e2e-spec.ts > AC-LIFE-005`<br>`src/modules/templates/templates-publish.int-spec.ts` | Stale revision returns 409 Conflict with code `stale_revision`; identical draft returns outcome `unchanged` | `screenshots/store-forge-api/PHASE-5/test-output/e2e-tests.txt`<br>`integration-tests.txt` | E2E / INT | PASS |
| AC-LIFE-006 | Atomic publishing pipeline: validation, storage verification, snapshot insert, pointer move | `test/templates.e2e-spec.ts > AC-LIFE-006`<br>`src/modules/templates/templates-publish.int-spec.ts` | 200 OK; immutable `template_versions` record created; `published_version_id` points to new version; draft intact | `screenshots/store-forge-api/PHASE-5/test-output/e2e-tests.txt`<br>`integration-tests.txt` | E2E / INT | PASS |
| AC-LIFE-007 | Rejected publishing leaves existing published state unchanged | `test/templates.e2e-spec.ts > AC-LIFE-007`<br>`src/modules/templates/templates-publish.int-spec.ts` | Invalid draft or missing image rejects publish (400/409); previous published version retained untouched | `screenshots/store-forge-api/PHASE-5/test-output/e2e-tests.txt`<br>`integration-tests.txt` | E2E / INT | PASS |
| AC-LIFE-008 | Unpublish clears `published_version_id` while preserving immutable version history | `test/templates.e2e-spec.ts > AC-LIFE-008`<br>`src/modules/templates/templates-publish.int-spec.ts` | 200 OK; `published_version_id` set to null; historical versions queryable | `screenshots/store-forge-api/PHASE-5/test-output/e2e-tests.txt`<br>`integration-tests.txt` | E2E / INT | PASS |
| AC-LIFE-009 | Rollback creates a new immutable version without mutating working draft | `test/templates.e2e-spec.ts > AC-LIFE-009`<br>`src/modules/templates/templates-publish.int-spec.ts` | Version pointer updated; draft and current revision unmolested; new version has `source = 'rollback'` | `screenshots/store-forge-api/PHASE-5/test-output/e2e-tests.txt`<br>`integration-tests.txt` | E2E / INT | PASS |
| AC-LIFE-010 | Restore historical version into mutable draft bumping revision | `test/templates.e2e-spec.ts > AC-LIFE-010`<br>`src/modules/templates/templates-publish.int-spec.ts` | Historical document loaded into draft; revision incremented; optimistic concurrency enforced | `screenshots/store-forge-api/PHASE-5/test-output/e2e-tests.txt`<br>`integration-tests.txt` | E2E / INT | PASS |
| AC-LIFE-011 | Atomic default-template switching within page kind | `test/templates.e2e-spec.ts > AC-LIFE-011`<br>`src/modules/templates/templates-lifecycle.int-spec.ts` | Previous default template demoted to `is_default = false`; target promoted to `is_default = true` in single transaction | `screenshots/store-forge-api/PHASE-5/test-output/e2e-tests.txt`<br>`integration-tests.txt` | E2E / INT | PASS |
| AC-LIFE-012 | Assignment, replacement, bulk assignment, and unassignment | `test/templates.e2e-spec.ts > AC-LIFE-012`<br>`src/modules/templates/templates-publish.int-spec.ts` | Single and bulk assignments succeed; cross-store assignment rejected; batch limit (50) enforced | `screenshots/store-forge-api/PHASE-5/test-output/e2e-tests.txt`<br>`integration-tests.txt` | E2E / INT | PASS |
| AC-LIFE-013 | Concurrency-safe active and archived quotas | `test/templates-real-concurrency.int-spec.ts`<br>`src/modules/templates/templates-lifecycle.int-spec.ts` | Store-level advisory / table locks prevent race conditions exceeding quota under concurrent transactions | `screenshots/store-forge-api/PHASE-5/test-output/real-pg-concurrency.txt`<br>`integration-tests.txt` | REAL PG / INT | PASS |
| AC-LIFE-014 | 500-version limit enforced per template | `test/templates-real-concurrency.int-spec.ts > AC-LIFE-014`<br>`src/modules/templates/templates-publish.int-spec.ts` | 500th version allowed; 501st publish attempt throws `quota_exceeded` conflict | `screenshots/store-forge-api/PHASE-5/test-output/real-pg-concurrency.txt`<br>`integration-tests.txt` | REAL PG / INT | PASS |
| AC-LIFE-015 | Authorization matrix: Owner, Manager, Staff, Platform Admin, anonymous, cross-tenant | `test/templates.e2e-spec.ts > Authorization Matrix`<br>`src/common/guards/*` | Owner/Manager have `store:manage`; Staff without permission gets 403; Anonymous gets 401; Cross-tenant gets 403; Platform admin without tenant membership gets 404 | `screenshots/store-forge-api/PHASE-5/test-output/e2e-tests.txt`<br>`unit-tests.txt` | E2E / UNIT | PASS |
| AC-LIFE-016 | Image existence verification in `products` bucket and referenced-file retention | `test/templates.e2e-spec.ts > AC-LIFE-016`<br>`src/modules/templates/support/image-paths.spec.ts` | Non-existent image paths fail publish pipeline; valid tenant-scoped storage objects verified | `screenshots/store-forge-api/PHASE-5/test-output/e2e-tests.txt`<br>`unit-tests.txt` | E2E / UNIT | PASS |
| AC-LIFE-017 | Concurrent autosaves: winner advances revision, loser receives 409 stale_revision; lock timeout 55P03 busy | `test/templates-real-concurrency.int-spec.ts > AC-LIFE-017` | Verified on real PostgreSQL (container port 17032): concurrent race resolved atomically without lost updates | `screenshots/store-forge-api/PHASE-5/test-output/real-pg-concurrency.txt` | REAL PG | PASS |
| AC-LIFE-018 | Publishing transaction failure leaves zero partial state | `test/templates-real-concurrency.int-spec.ts > AC-LIFE-018` | Injected transaction fault rolls back snapshot creation and pointer updates completely; zero orphaned versions | `screenshots/store-forge-api/PHASE-5/test-output/real-pg-concurrency.txt` | REAL PG | PASS |
| AC-LIFE-019 | Tenant-restricted image listing | `test/templates.e2e-spec.ts > AC-LIFE-019`<br>`src/modules/templates/controllers/template-images.controller.ts` | `GET /stores/:storeId/images` enforces prefix `{tenant_id}/` in `products` bucket; cross-tenant objects inaccessible | `screenshots/store-forge-api/PHASE-5/test-output/e2e-tests.txt` | E2E | PASS |
| AC-LIFE-020 | Delete permitted only when template is never published and unassigned | `test/templates.e2e-spec.ts > AC-LIFE-020`<br>`src/modules/templates/templates-lifecycle.int-spec.ts` | 200 OK on never-published, unassigned template; 409 Conflict if published or assigned | `screenshots/store-forge-api/PHASE-5/test-output/e2e-tests.txt`<br>`integration-tests.txt` | E2E / INT | PASS |
| AC-LIFE-021 | Lazy shared-document initialization with registry defaults | `test/templates.e2e-spec.ts > AC-LIFE-021`<br>`src/modules/templates/controllers/shared-documents.controller.ts` | Uninitialized shared document returns registry preset defaults (200 OK); saving persists mutable draft | `screenshots/store-forge-api/PHASE-5/test-output/e2e-tests.txt` | E2E | PASS |

## Test Execution Summary

| Quality Gate | Target Command | Result | Duration | Artifact Reference |
|---|---|---|---|---|
| Unit Test Suite | `npm test` | 17 / 17 passed (114 tests) | 23.46s | `screenshots/store-forge-api/PHASE-5/test-output/unit-tests.txt` |
| Integration Suite (PGlite + PG) | `npm run test:int` | 4 / 4 passed (30 tests) | 15.29s | `screenshots/store-forge-api/PHASE-5/test-output/integration-tests.txt` |
| E2E HTTP Suite | `npm run test:e2e` | 2 / 2 passed (33 tests) | 10.50s | `screenshots/store-forge-api/PHASE-5/test-output/e2e-tests.txt` |
| Real Postgres Concurrency | `npx vitest run test/templates-real-concurrency.int-spec.ts` | 1 / 1 passed (4 tests) | 3.40s | `screenshots/store-forge-api/PHASE-5/test-output/real-pg-concurrency.txt` |
| TypeScript Compiler Check | `npm run typecheck` | 0 errors | 3.2s | `screenshots/store-forge-api/PHASE-5/test-output/typecheck.txt` |
| Static Analysis (Linter) | `npm run lint` | 0 errors, 0 warnings (103 files) | 1.6s | `screenshots/store-forge-api/PHASE-5/test-output/lint.txt` |
| Code Formatting Check | `npm run format:check` | All files match Prettier style | 2.5s | `screenshots/store-forge-api/PHASE-5/test-output/format.txt` |
| NestJS Application Build | `npm run build` | Clean compilation (`dist/`) | 4.8s | `screenshots/store-forge-api/PHASE-5/test-output/build.txt` |

