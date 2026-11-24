# Marketing and analytics: security and performance review

Scope: everything added in phases 1 to 6 (migrations `0053` to `0057`, the `marketing`, `reports` and `integrations` modules, the checkout hooks, and the storefront and dashboard code in `store-forge`), reviewed in phase 7 together with the changes it made (`0058`, `0059`). Plan and definitions: [MARKETING_ANALYTICS_PLAN.md](MARKETING_ANALYTICS_PLAN.md). Running it: [COMMERCE_OPERATIONS.md](COMMERCE_OPERATIONS.md).

## How it was reviewed

- Every new route, DTO and database function was read for who can call it, what it can read or change, and what it returns.
- Mechanical checks over the migrations: all 16 new functions are accounted for; every `SECURITY DEFINER` one pins `search_path` and is schema-qualified; execute rights are granted only to the intended role (`authenticated` for dashboard reads and changes, `storeforge_checkout` for storefront and scheduler paths, nobody else); all 9 new tables have row level security. (The one function without a revoke is a trigger function, which cannot be called directly.)
- Searched for raw SQL: `sql.raw` is used only for fixed column lists; every value is a bound parameter; the one value that picks SQL (`day`, `week`, `month`) is validated against a fixed list first.
- Searched logs, audit entries, error messages and every response for secrets and identifiers.
- Measured the reports and lists against a large synthetic store (below).

## Findings

| # | Severity | Finding | Resolution |
|---|---|---|---|
| 1 | Medium | A cart recovery link carries its token in the page address, and both Google's tag and Meta's script report the full page address by default. The storefront removed the token only after the page's scripts could already have run, so the first page view could have sent the token (which identifies the shopper and shows their bag) to Google and Meta. | The storefront layout now removes the token from the address first, in a layout effect (which runs before every normal effect, including those that load and call the scripts), and keeps it for the cart page in that tab only. Tested (`url-scrub.test.ts`), including blocked storage. |
| 2 | Medium | Saved carts hold a shopper's email, name and phone, and were kept for ever. | Migration `0058` and the job `/internal/jobs/purge-abandoned-carts`: carts untouched for the store's link lifetime plus 30 days, and carts recovered over 180 days ago, are deleted in batches. Tested, including that it works across stores, follows each store's own setting, and cannot be run by a signed-in user or a shopper. Documented as a going-live step. |
| 3 | Medium | (Introduced in phase 4, found here.) The customer reports read orders through row level security. A member allowed to see customers but not orders would have got a report full of zeros with no error; a member allowed to see orders but not the catalogue would have got an empty product report. | Migration `0059`: read-only report functions check the caller's access once and raise `permission denied` (a 403) when it is missing; the product list needs only orders access, since product names are on every order line. Tested with purpose-made members and direct calls by non-members. |
| 4 | Medium | (Found and fixed in phase 4.) Refunds can be read only by the Owner, so any other member's net sales would have been overstated. | Migration `0056`: a function returns the processed refund total per order to members with orders access, nothing more. |

No finding allowed one store to read, change or use another store's data. Cross-store tests exist for discounts, campaigns, carts, recovery links, reports, integrations and the public tracking endpoint.

## Controls that were checked and held

- **Tenant isolation.** The tenant always comes from the verified membership (the `X-Organization-Id` header is only a hint that is checked), never from a body. Dashboard writes go through row level security; storefront paths run as the tenant-pinned role, which refuses any other tenant. Pointing the header at a store you do not belong to is a 403 on every new route (tested).
- **Authorization.** `marketing:*` follows orders access, `integrations:*` follows store-settings access, customer reports follow customers access, and the cart settings need settings write. Every route declares its permission, and the permission-pinning tests fail if a route is added without one.
- **Money is never taken from the browser.** A discount is a code only: the amount, eligibility, limits and expiry are decided by the server when the cart is priced and again, under a row lock, when the order is placed. A simultaneous-orders test proves a one-use code is used once.
- **Secrets.** Integrations store only public identifiers; the encrypted-secret columns exist for later and no route can read them (checked in tests: no response contains a ciphertext, IV, tag or key version). Recovery tokens are derived from the server key and never stored (only a hash is), so a leaked database cannot produce a working link. The browser's cart id is stored only as a hash. Audit entries and logs never contain an identifier value, an email or a token.
- **Input.** Every body and query is validated and whitelisted (unknown fields are a 400, tested). IDs are format-checked before they are put in a script address (`G-` plus 10 characters; 15 or 16 digits), on the server and again in the browser.
- **Abuse limits.** Every public write and check is rate limited per client (cart save 30 a minute, recovery link 30, discount check 30, place order 10); dashboard writes 30 to 60 a minute; the integration test, which calls an outside service, 10.
- **Consent.** Google Analytics and Meta Pixel load only if the store switched them on, the configuration validated, and the shopper accepted the banner. Ads storage and personalisation stay denied, Meta's automatic event detection is off, withdrawing consent opts out and clears the cookies, and events before consent are dropped, not queued. A saved cart is never contacted without the shopper's tick, and nothing is sent at all: there is no mail or SMS provider.
- **Failure isolation.** A failing tracking script, a failing cart save, a missing server key or a conversion-recording error never fails checkout or a page (each has a test or an explicit non-blocking path).
- **Purchases are counted once.** Once per order in the browser, by the order number as Google's transaction id, and with a fixed Meta event id (`purchase_<order number>`) that a future server-side call can reuse.

## Accepted risks (decided, documented, not hidden)

1. **Discount code guessing.** The public check answers "expired" or "used up" for a code that exists, so codes can be probed. Limited to 30 a minute per client; the checkout message needs to be helpful, and a code is only worth what its limits allow.
2. **Per-customer limits are by email.** A shopper using `name+1@example.com` gets another use. A stricter rule would need accounts, which the storefront does not have. The check with an email also tells someone who knows a valid code and another person's email whether that person used it.
3. **Anyone can save a cart under any email.** It stores a row and sends nothing; limited per client, expired by the purge job, and erasable by the Owner.
4. **Third-party scripts.** After consent, Google and Meta receive page and event data. This is the point of the integration; the banner says so.
5. **No Content-Security-Policy.** The repository has none today. If one is added, allow `www.googletagmanager.com`, `www.google-analytics.com`, `connect.facebook.net` and `www.facebook.com`.

## Performance

Measured on a synthetic store: 60,000 orders, about 90,000 order lines, 20,000 customers, 6,000 refunds, 20,000 discount redemptions, 30,000 saved carts, one year of history. The engine is PGlite (single-threaded WebAssembly), so absolute times are several times slower than a real Postgres; the comparison between before and after is what matters. For scale, the existing dashboard `GET /analytics` takes about 5.6 s on the same data.

The main cause was not the queries. Row level security checks access once **per row**, and the report queries touch tens of thousands of rows (the same count-and-sum took about 780 ms through row level security and 17 ms without it, about 45 times). The fix (migration `0059`) checks access once per call and then aggregates, and the paged lists compute their total in the same pass instead of running the query twice.

| Endpoint | Before | After |
|---|---|---|
| Sales, 365 days by day | 1.4 s | 0.15 s |
| Revenue, weekly / 3 years monthly | 1.2 s / 1.2 s | 0.14 s / 0.16 s |
| Products, best sellers (30 days) | 0.5 s | 0.05 s |
| Products, worst sellers (365 days) | 6.2 s | 0.17 s |
| Customer summary (365 days) | 2.2 s | 0.09 s |
| Top customers (365 days) | 3.5 s | 0.15 s |
| Abandoned carts list (30,000 carts) | 0.93 s | 0.52 s |
| Discounts list (300 codes) | 0.08 s | 0.08 s |
| Discounts list, filtered by status | 1.06 s | 0.92 s |

What remains slow, and why it was left: the abandoned-carts list and summary (about 0.5 s with 30,000 saved carts, far more than a store keeps once the purge job runs) and the discounts list filtered by status (needs every code's use worked out). Both are still row level security per row; the same function approach would fix them if a store ever needs it. One finding in passing: a window total made the *unfiltered* discounts list 13 times slower (it forced every code's figures to be computed), so it is used only where a status filter needs the full evaluation anyway.

Indexes were checked against the plans of the heavy queries: orders by tenant, status and date; order lines by order; redemptions by code; carts by tenant, status and activity. No new index was needed.

## Known gaps

- Product conversion is not available (no product-view data). Server-side GA4 and the Meta Conversions API are not built.
- There are no automated browser tests of the new screens, because the frontend has no DOM test setup. The pure logic (form conversion, tracking events, loaders, consent, recovery) is unit tested; the screens were type-checked, linted and built, not clicked through against a live API. Before relying on a release, walk through: create a code, apply it at checkout, abandon and recover a cart, switch on each integration in a clean browser.
- `test/payments-static.spec.ts` (the static scan for a banned dependency) occasionally fails in a full parallel run and passes alone. It runs `git diff` over a large diff under load; it is a timing flake, not a finding, but it is worth a longer timeout.
