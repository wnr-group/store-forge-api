# Platform billing (StoreForge billing its tenants)

How an organization pays StoreForge for its plan. This is separate from the payments in `docs/COMMERCE_OPERATIONS.md`, where shoppers
pay a **tenant** through the tenant's own Razorpay account.

## What exists, what does not

| Capability | Status |
|---|---|
| Per-period invoices with gapless numbers, tax, seller details and a PDF | Built (migration 0064) |
| Online payment of an invoice through **StoreForge's own** Razorpay account | Built, needs the three `RAZORPAY_PLATFORM_*` variables |
| Server-side verification (checkout signature, then a lookup at Razorpay), idempotent settlement | Built |
| Webhooks with signature check and de-duplication by event id | Built |
| Refunds (full or partial), idempotent, with recovery after a lost response | Built |
| Offline payments (bank transfer, cheque) recorded by a Billing Admin | Built |
| Renewal invoices, overdue tracking, past due and expiry | Built (scheduler and manual run) |
| **Automatic recurring charges (Razorpay Subscriptions)** | **Not built, not operational** |

### Recurring charges are not configured

One-time Razorpay payments work. Razorpay **Subscriptions** (a mandate the customer authorises once, then Razorpay charges every
period) were not found anywhere in the codebase, and the Razorpay client has no subscription calls. Nothing here pretends otherwise: each
period the tenant Owner is **invoiced** and pays that invoice.

To add automatic recurring billing later you would need, in this order:

1. A Razorpay Plan per StoreForge plan and interval (created through the API or dashboard), and the plan id stored on `plans`.
2. `createSubscription` / `cancelSubscription` calls in the Razorpay client, and an authorisation step in the dashboard (Checkout in
   subscription mode).
3. `subscription.authenticated`, `.charged`, `.halted`, `.cancelled` webhook handling. `subscription.charged` would call the same
   settlement function as a captured payment (`billing_settle_invoice`), so invoices, numbers, refunds and the subscription extension
   stay as they are.
4. A column for the Razorpay subscription id on `tenant_subscriptions` (reserved in the design, not created yet).

## Money flow

```
renewal job / admin ──> invoice (open) ──> Owner: POST /billing/invoices/:id/pay ──> Razorpay order
                                                                                       │
        Razorpay Checkout in the browser <─────────────── order id + PUBLIC key id ────┘
                  │ result (order, payment, signature)
                  v
   POST /billing/payments/verify ── 1. signature  2. ask Razorpay for the payment  3. billing_apply_payment()
   Razorpay webhook (payment.captured) ───────────────────────────────────────────> billing_apply_payment()
                                                                                       │
                       invoice paid ◄── billing_settle_invoice() ──► subscription active, period extended
```

Both paths end in the same idempotent SQL function. A payment is applied **once**: the order id and the payment id are unique, a repeat
is answered `duplicate`, and an amount or currency that differs from the invoice is refused (`PAYMENT_AMOUNT_MISMATCH`).

* A payment that arrives for an invoice that is already paid or void is **kept** and flagged `refundRequired`; it appears under
  `GET /platform/billing/payments?refundRequired=true` for a Billing Admin to refund.
* A failed attempt is recorded; a later successful attempt on the same Razorpay order replaces it.

## Where the rules live

SQL functions (`SECURITY DEFINER`, pinned `search_path`), because the webhook and the scheduler have no signed-in user:

| Function | Who may call it |
|---|---|
| `billing_apply_payment`, `billing_apply_refund_event`, `billing_log_webhook`, `billing_finish_webhook`, `billing_run_scheduled` | The application only. Refused over PostgREST (`session_user = 'authenticator'`). The payment function also lets a signed-in **Owner of that tenant** call it; the webhook functions refuse any signed-in user. |
| `billing_prepare_payment`, `billing_attach_order` | The Owner of the invoice's tenant. |
| `platform_issue_invoice`, `platform_void_invoice`, `platform_record_manual_payment`, `platform_refund_begin`, `platform_refund_finish`, `platform_run_billing` | Platform Admins (the API further limits them by role: `billing:manage`). |
| `billing_settle_invoice`, `billing_issue_invoice_internal`, `billing_process_renewals`, `billing_next_invoice_number`, `billing_refund_processed` | Nobody (internal). |

Invoices cannot be edited or deleted, even by the database owner (trigger): only `status`, `paid_at`, `voided_at` and `void_reason` change,
and `paid` / `void` are final. They carry no foreign key to the tenant and copy the tenant name, so they survive tenant deletion.

## Security

* The Razorpay Key Secret and webhook secret exist only in the server environment. No route returns them; the browser receives the public Key
  Id and an order id.
* A checkout result is never trusted: the signature is verified, then the payment is fetched from Razorpay and must be captured, for this
  order, in this amount.
* Webhook signatures are checked against the exact bytes received before the body is parsed.
* No card data is stored or received. Payment rows hold Razorpay ids, the payment method name and failure codes only.
* A tenant Owner reads only its own invoices, payments and refunds (row level security) and nothing else; team members cannot.
* Refunds are keyed by a `requestId`; after an unclear failure the refund is looked up at Razorpay by its receipt before anything is sent again.

## Renewals

`GET /api/v1/internal/jobs/billing` (header `Authorization: Bearer <CRON_SECRET>`) or `POST /platform/billing/run` does, in order:

1. Issues the invoice for every active or trialing subscription on a paid plan whose period ends within `renewal_notice_days` (once per
   period; a period is never invoiced twice).
2. Moves active subscriptions with an open invoice past its due date to `past_due` (access continues).
3. Expires past due (or trialing) subscriptions whose invoice is unpaid for more than `grace_days`. An expired subscription grants no
   features and refuses new products, staff and uploads (the entitlement service treats `expired` as not entitled).

Schedule the job daily. The first period of a newly assigned paid plan is **not** invoiced automatically: use
`POST /platform/organizations/:id/billing/invoices` with `period: "current"`.

## Not covered

* Credit notes, proration on mid-period plan changes, and sending invoices by email (no email provider is configured).
* Tax beyond a single configurable rate added to the plan price (set `tax_rate_bps`; GST place-of-supply rules are not modelled).
