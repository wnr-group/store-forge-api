# PR-D Evidence Index: Public Storefront Reads & Cutover Gate

## Summary
- **PR:** PR-D (Branch: `feat/pr-d-public-storefront`)
- **Owner:** Eshwar
- **Date:** 2026-11-10
- **Scope:** 5 public storefront read operations (`get_public_storefront`, `get_public_template_layout`, `get_public_product`, `get_public_collection`, `get_public_collections`), cutover gate helper (`template_engine_cutover_complete`), shared rate limit (BLOCKED transport).
- **Test Suite Status:** 24 Unit tests PASS (schemas + service), 13 Integration (PGlite) tests PASS, 0 Lint warnings, Formatting PASS, Typecheck PASS.
- **Decisions Approved in T-D0:**
  - PD-O1: Gate 4 template-engine-era operations (`layout`, `product`, `collection`, `collections`). Legacy `get_public_storefront` remains ungated. Disabled result = `null`.
  - PD-O2: Contract matches payload Zod schemas (`storefrontSchema`, `layoutPayloadSchema`, `publicProductPayloadSchema`, `publicCollectionPayloadSchema`, `publicCollectionsListSchema`). `PageData` and engine rendering stay in Next.js frontend (PD-6).
  - PD-O3: Malformed slug returns `null` (same indistinguishable response as unknown / inactive / suspended).
  - PD-O4: No caching of public reads.

## Evidence Matrix

| AC ID | Scenario | Test Name | Actual Result | Evidence Path | Evidence Type | Status |
|---|---|---|---|---|---|---|
| AC-D-01 | All 5 operations implemented and callable via public context | `storefront.int-spec.ts > AC-D-01: ...` (6 tests) & `storefront.service.spec.ts` | All 5 operations return valid payloads matching schemas; ordering & bounds enforced | `screenshots/store-forge-api/PR-D/AC-D-01/transcript.txt`, `screenshots/store-forge-api/PR-D/test-output/storefront-int.txt` | INT-PGLITE | PASS |
| AC-D-02 | No user session required (runs with no auth / zero claims) | `storefront.int-spec.ts > AC-D-02: withPublic has zero JWT claims and cannot read direct tenant tables, but public functions succeed` | Claims are empty; table scan blocked by RLS; public functions return data | `screenshots/store-forge-api/PR-D/AC-D-02/transcript.txt`, `screenshots/store-forge-api/PR-D/test-output/storefront-int.txt` | INT-PGLITE | PASS |
| AC-D-03 | Responses match frontend payload schemas & golden fixtures | `storefront-schemas.spec.ts > AC-D-03: ...` (6 tests) | All 5 fixture payloads and function outputs validate against copied Zod schemas | `screenshots/store-forge-api/PR-D/AC-D-03/transcript.txt`, `screenshots/store-forge-api/PR-D/test-output/storefront-schemas-spec.txt` | UNIT/INT | PASS |
| AC-D-04 | Gate fails closed: false, missing function, error return disabled | `storefront.int-spec.ts > AC-D-04` & `storefront.service.spec.ts > isEngineReadEnabled` (9 tests) | Pending/error/missing returns false; gated methods return null | `screenshots/store-forge-api/PR-D/AC-D-04/transcript.txt`, `screenshots/store-forge-api/PR-D/test-output/storefront-service-spec.txt` | INT-PGLITE / UNIT | PASS |
| AC-D-05 | Unknown, inactive, suspended, malformed indistinguishable; no private fields | `storefront.int-spec.ts > AC-D-05: unknown, inactive...` & `AC-D-05: security scan...` | All invalid slugs yield identical NULL; zero private/tenant/cost fields leaked | `screenshots/store-forge-api/PR-D/AC-D-05/transcript.txt`, `screenshots/store-forge-api/PR-D/test-output/storefront-int.txt` | INT-PGLITE | PASS |
| AC-D-06 | Five routes share public rate limit (60/min/IP) | HTTP route rate limiting suite | Blocked on BLK-1 (transport & PR-B guards) | Pending BLK-1 | E2E | BLOCKED |
| AC-D-07 | Swagger lists five routes as public | Route decorators & Swagger capture | Blocked on BLK-1 (transport & PR-B guards) | Pending BLK-1 | SWAGGER | BLOCKED |
