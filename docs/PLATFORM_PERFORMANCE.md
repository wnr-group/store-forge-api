# Platform administration: performance notes

What was reviewed in the last phase, what was changed, and what to watch.

## Changed

* **Bulk product import checked the plan limit once per row** (a lock, an entitlement read and a count: three queries per row, 1,500 for a
  500-row file). It now checks once for the whole file, inside the same transaction, counting the rows about to be added. Same outcome (all or
  nothing, `PLAN_LIMIT_REACHED`), about 1,500 fewer queries.

## Already efficient

* **Lists** (tenants, invoices, payments, plans, errors, job runs, audit) filter, sort and page in SQL with an index on the sort column
  (`created_at desc` or equivalent); totals come from `count(*)` over the same filter. A page past the end clamps instead of returning empty.
* **Entitlement checks** are one read of one SQL function (plan, features, limits, exceptions, subscription) plus a single counted query for the
  resource being limited; the advisory lock is per tenant and resource, so tenants never wait for each other.
* **Dashboard and monitoring** use aggregate queries over indexed time columns; the outside sign-in check is cached for 15 seconds so polling
  cannot hammer it.
* **Error recording** is bounded (200 per minute, 14 days) and the write has a 1.5 second limit, so it cannot slow a failing request for long.

## Watch as it grows

| Area | Cost | When to act |
|---|---|---|
| `platform_limit_usage_page` | Counts products, staff and orders for every tenant (one indexed count each) before filtering | Thousands of tenants: precompute usage counters or run it from a job |
| Free-text search (`ILIKE '%x%'`) on tenants, invoices, errors | Sequential scan of the filtered set | Hundreds of thousands of rows: add `pg_trgm` indexes |
| Feature-gated routes | One extra transaction per request for the plan check | If it shows in latency: cache the effective entitlements per tenant for a few seconds (invalidate on plan change) |
| `billing_process_renewals` | One pass over subscriptions; invoices are created one at a time | Tens of thousands of renewals per day: batch the invoice creation |
| Storage usage (`tenant_storage_bytes`) | Sums object sizes from Supabase Storage on demand | Only measured when asked (tenant detail, upload check), never in lists |
