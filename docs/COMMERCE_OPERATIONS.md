# Commerce operations: payments, shipping, tax, marketing and analytics

How to run the order, payment, shipping and GST features in production. The behaviour of each feature is in the code, in
`SHIPPING_INTEGRATIONS.md` and `GST.md`; this page is the checklist for deploying and operating it.

## Environment variables

### API (`store-forge-api`)

| Variable | Needed for | Notes |
|---|---|---|
| `DATABASE_URL`, `DIRECT_URL` | everything | Pooler URL for the app, direct URL for `npm run db:migrate`. |
| `SUPABASE_URL`, `SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY` | sign-in, team | |
| `AUTH_BFF_SECRET` | frontend to API | Same value in the frontend. |
| `CORS_ORIGINS` | browser calls | Include the storefront and dashboard origins. |
| `CREDENTIALS_ENCRYPTION_KEY_V1` and `CREDENTIALS_ENCRYPTION_KEY_CURRENT=1` | saving Razorpay and carrier credentials, and abandoned-cart recovery links | 32 random bytes, base64: `openssl rand -base64 32`. Without it saving credentials fails closed (503), saving a shopper's cart for recovery answers 503 `CART_RECOVERY_UNAVAILABLE` (the storefront ignores it) and the dashboard shows carts without a link; everything else keeps working. Keep old versions when rotating, but note that **changing the key invalidates every recovery link already issued** (the links are derived from it and never stored). |
| `CRON_SECRET` | scheduled jobs | The jobs below refuse every call while it is unset. |
| `CHECKOUT_RESERVATION_MINUTES` | stock holds | Default 30. How long an unpaid online order keeps its stock. |
| `RATE_LIMIT_SECRET` | login rate limiting | Optional. |
| `RAZORPAY_API_BASE_URL` | tests only | Leave unset in production. |

There is no platform-wide Razorpay or carrier credential: every store saves its own in the dashboard.

### Frontend (`store-forge`)

`NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_ANON_KEY`, `NEXT_PUBLIC_APP_URL`, `NEXT_PUBLIC_ROOT_DOMAIN`, `API_BASE_URL`
(the API, ending in `/api/v1`), `AUTH_BFF_SECRET`. The storefront loads Razorpay Checkout from `https://checkout.razorpay.com`;
if you add a Content-Security-Policy, allow that host for `script-src`, `frame-src` and `connect-src`.

## Database

```bash
npm run db:migrate        # applies every migration, including orders, payments, shipping, shipments and tax
npm run db:verify-schema  # checks the live schema against the code
```

## Scheduled jobs

All three are `GET` and need `Authorization: Bearer <CRON_SECRET>` (Vercel Cron sends it automatically).

| Route | What it does | Suggested schedule |
|---|---|---|
| `/internal/jobs/expire-reservations` | Closes unpaid orders whose stock hold ran out and closes the holds. Stock is already available to other shoppers the moment a hold expires; this job only tidies the order and the hold records. | every 5 minutes |
| `/internal/jobs/reconcile-payments` | Asks Razorpay about payments and refunds that have been waiting a while, so a missed webhook or a closed tab never leaves an order unpaid. | every 15 minutes |
| `/internal/jobs/sync-shipments` | Refreshes tracking for open shipments from each carrier. | every 15-30 minutes |
| `/internal/jobs/purge-abandoned-carts` | Deletes saved carts (and the shopper email, name and phone in them) past their retention: not touched for the store's recovery-link days plus 30 days, or recovered more than 180 days ago. Works in batches of 2,000 and reports `complete: false` if it stopped early (the next run continues). | once a day |

`vercel.json` does not define crons yet. Add, for example:

```json
"crons": [
  { "path": "/api/v1/internal/jobs/expire-reservations", "schedule": "*/5 * * * *" },
  { "path": "/api/v1/internal/jobs/reconcile-payments", "schedule": "*/15 * * * *" },
  { "path": "/api/v1/internal/jobs/sync-shipments", "schedule": "*/20 * * * *" },
  { "path": "/api/v1/internal/jobs/purge-abandoned-carts", "schedule": "17 3 * * *" }
]
```

Vercel's Hobby plan only runs a cron once a day. Overselling is still prevented (an expired hold stops counting at once), but
unpaid orders then stay open, payments missed by a webhook wait for the next run, and tracking goes stale, so use a plan that
allows the schedules above or call the routes from another scheduler.

## Webhooks

- **Razorpay**: each store owner adds `https://<api-host>/api/v1/webhooks/razorpay/<store public id>` in Razorpay Dashboard,
  Settings, Webhooks, chooses a secret, and saves the same secret on the Payments page. Events: `payment.authorized`,
  `payment.captured`, `payment.failed`, `order.paid`, `refund.created`, `refund.processed`, `refund.failed`. Bodies are checked
  with `X-Razorpay-Signature` against that store's own secret; redeliveries are stored once and ignored.
- **Carriers**: `https://<api-host>/api/v1/webhooks/carriers/<shiprocket|delhivery|bluedart>` for carriers that can push
  tracking. A webhook body is never believed: it only names waybills, and the API then asks the carrier directly.

## Going live checklist

1. Migrate, set the variables above, deploy the API, then the frontend.
2. Owner: Payments, save the Razorpay Key ID and Secret (test keys first), and the webhook secret.
3. Owner: Shipping, Carriers: connect each carrier with the store's own account, Test connection, Verify, turn on.
4. Shipping: save the pickup address, add zones, then delivery methods.
5. Taxes: save the GSTIN and rates. Set the HSN code and GST rate on products that differ from the default.
6. Place a test order for each payment method, pay with a Razorpay test card, book a shipment, refund it.
7. Add the cron schedule, including `purge-abandoned-carts` (without it saved carts, and the shopper details in them, are kept for ever).
8. Marketing: create a discount code, apply it at checkout on a test order, and confirm the discount shows on the order and in the report.
9. Integrations (Owner or store-settings access): save a Google Analytics 4 Measurement ID and/or a Meta Pixel ID, run Test, switch it on, then open the store in a clean browser, accept the cookie banner and check Realtime in Google Analytics / Test events in Meta Events Manager. Nothing loads before the shopper accepts.

## Marketing and analytics

What was added, and what to know when running it. Design and definitions: [MARKETING_ANALYTICS_PLAN.md](MARKETING_ANALYTICS_PLAN.md). Review and measurements: [MARKETING_ANALYTICS_REVIEW.md](MARKETING_ANALYTICS_REVIEW.md).

- **Discount codes** are decided only by the server (when the cart is priced and when the order is placed, under a row lock, so a usage limit holds even for simultaneous orders). One code per order. A cancelled or failed order frees its use.
- **Abandoned carts** are saved only after a shopper types an email at checkout, and only a hash of the browser's cart id and of the recovery token is stored. **Nothing is ever sent to a shopper**: there is no email or SMS provider, and the dashboard only shows whether the shopper agreed to be contacted. Retention is the nightly purge job above.
- **Reports** count orders in a revenue status (confirmed to delivered), by the store's own days. A refund belongs to the period of its order. Definitions are printed on the report page.
- **Integrations** keep only public identifiers (a GA4 Measurement ID, a Pixel ID). The storefront loads a provider only when the store switched it on, it validated, and the shopper accepted the banner. Changing an ID switches the integration off until it is enabled again. Every change is in the audit history, which never records a value.
- **Server-side tracking** (GA4 Measurement Protocol, Meta Conversions API) is not built. Purchases carry an event id (`purchase_<order number>`) so adding it later will not double-count.

## Known limits

- Carrier request and response shapes are checked only against fakes written from the carriers' documentation. Each carrier needs
  a run against its sandbox with real credentials before real parcels; Blue Dart is the least verified (see
  `SHIPPING_INTEGRATIONS.md`).
- The storefront has no customer accounts. A shopper reopens an order with the order token the browser saved at checkout, so an
  order is only listed on the device that placed it. The store's contact details are the fallback.
- Stock is not put back automatically when a shipment is returned; cancellation before shipping restores it.
- Product conversion (views to purchases) is not available: the store does not record product views. The product report shows "Not tracked".
- Cash-on-delivery returns are not refunds in the reports (refunds exist for online payments only).
- Per-customer discount limits count by email address, so a shopper using `name+1@example.com` can use a code again.
- A shopper can learn from the discount check whether a code exists and why it is not usable (expired, used up). Checks are limited to 30 a minute per client.
