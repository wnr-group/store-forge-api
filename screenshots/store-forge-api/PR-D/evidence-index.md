# PR-D Evidence Index: Public Storefront Reads & Cutover Gate

## Summary
- **PR:** PR-D (Branch: `feat/pr-d-public-storefront`)
- **Owner:** Eshwar
- **Date:** 2026-11-10
- **Scope:** 5 public storefront read operations (`get_public_storefront`, `get_public_template_layout`, `get_public_product`, `get_public_collection`, `get_public_collections`), cutover gate helper (`template_engine_cutover_complete`), shared rate limit (BLOCKED transport).
- **Decisions Approved in T-D0:**
  - PD-O1: Gate 4 template-engine-era operations (`layout`, `product`, `collection`, `collections`). Legacy `get_public_storefront` remains ungated. Disabled result = `null`.
  - PD-O2: Contract matches payload Zod schemas (`storefrontSchema`, `layoutPayloadSchema`, `publicProductPayloadSchema`, `publicCollectionPayloadSchema`, `publicCollectionsListSchema`). `PageData` and engine rendering stay in Next.js frontend (PD-6).
  - PD-O3: Malformed slug returns `null` (same indistinguishable response as unknown / inactive / suspended).
  - PD-O4: No caching of public reads.

## Evidence Matrix

| AC ID | Scenario | Test Name | Actual Result | Evidence Path | Evidence Type | Status |
|---|---|---|---|---|---|---|
| AC-D-01 | All 5 operations implemented and callable via public context | Database contract integration test & StorefrontService | Pending T-D1 & T-D3 | `screenshots/store-forge-api/PR-D/test-output/storefront.int.txt` | INT-PGLITE | NOT IMPLEMENTED |
| AC-D-02 | No user session required (runs with no auth / no claims) | `withPublicContext` test with zero claims | Pending T-D1 | `screenshots/store-forge-api/PR-D/test-output/storefront.int.txt` | INT-PGLITE | NOT IMPLEMENTED |
| AC-D-03 | Responses match frontend payload schemas | Fixture validation against copied schemas | Pending T-D2 | `screenshots/store-forge-api/PR-D/test-output/storefront-schemas.txt` | UNIT/INT | NOT IMPLEMENTED |
| AC-D-04 | Gate fails closed: false, missing function, error return disabled | Gate helper test cases | Pending T-D1 & T-D3 | `screenshots/store-forge-api/PR-D/test-output/storefront.int.txt` | INT-PGLITE | NOT IMPLEMENTED |
| AC-D-05 | Unknown, inactive, suspended, malformed indistinguishable; no private fields | Slug matrix and forbidden-key scan | Pending T-D1 | `screenshots/store-forge-api/PR-D/test-output/storefront.int.txt` | INT-PGLITE | NOT IMPLEMENTED |
| AC-D-06 | Five routes share public rate limit (60/min/IP) | E2E rate limit test | Blocked on BLK-1 & PR-B | `screenshots/store-forge-api/PR-D/test-output/rate-limit.txt` | E2E | BLOCKED |
| AC-D-07 | Swagger lists five routes as public | Route decorators & Swagger capture | Blocked on BLK-1 & PR-B | `screenshots/store-forge-api/PR-D/swagger/` | SWAGGER | BLOCKED |
