# Commerce operations: payments, shipping and tax

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
| `CREDENTIALS_ENCRYPTION_KEY_V1` and `CREDENTIALS_ENCRYPTION_KEY_CURRENT=1` | saving Razorpay and carrier credentials | 32 random bytes, base64: `openssl rand -base64 32`. Without it saving credentials fails closed (503); everything else keeps working. Keep old versions when rotating. |
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

`vercel.json` does not define crons yet. Add, for example:

```json
"crons": [
  { "path": "/api/v1/internal/jobs/expire-reservations", "schedule": "*/5 * * * *" },
  { "path": "/api/v1/internal/jobs/reconcile-payments", "schedule": "*/15 * * * *" },
  { "path": "/api/v1/internal/jobs/sync-shipments", "schedule": "*/20 * * * *" }
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
7. Add the cron schedule.

## Known limits

- Carrier request and response shapes are checked only against fakes written from the carriers' documentation. Each carrier needs
  a run against its sandbox with real credentials before real parcels; Blue Dart is the least verified (see
  `SHIPPING_INTEGRATIONS.md`).
- The storefront has no customer accounts. A shopper reopens an order with the order token the browser saved at checkout, so an
  order is only listed on the device that placed it. The store's contact details are the fallback.
- Stock is not put back automatically when a shipment is returned; cancellation before shipping restores it.
