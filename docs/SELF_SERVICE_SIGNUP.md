# Self-service sign-up

A visitor can create their own account, buy a plan and create their own store without a Platform Admin. A Platform Admin can still create an organization by hand (`POST /platform/organizations`). Both ways write the records through ONE SQL routine, `provision_tenant_internal` (migration 0070): `platform_provision_tenant` (admin) and `signup_provision` (a customer who has paid) are thin wrappers that only differ in who is allowed to call them.

## The journey

| Step | Call | What happens |
|---|---|---|
| 1 | `POST /auth/register` | Creates a confirmed Supabase user (no e-mail verification), keeps the time the Terms were accepted in the user metadata, and signs the person in with the same HttpOnly cookies as `POST /auth/login`. Creates **no** organization, membership or role. |
| 2 | `POST /signup/checkout` | `signup_prepare`: a published plan (active, not unrestricted) and a billing period. The price and tax are worked out in the database from the plan and `billing_settings`; the browser sends neither. One purchase in progress per person: the same request again returns the same Razorpay order, a different plan replaces the unpaid one. A free plan becomes `paid` straight away. A paid plan with no price for the chosen period is refused (`INTERVAL_UNAVAILABLE`), never given away. |
| 3 | Razorpay Checkout | In the browser. The API only hands over the order id and the public key id. |
| 4 | `POST /signup/verify-payment` **or** the signed webhook | The order must be the caller's own. Checkout signature, then a lookup at Razorpay (captured, same order, same amount), then `signup_apply_payment`. The webhook (`POST /webhooks/billing/razorpay`) reaches the same function, so a browser that never comes back is still settled. Idempotent. |
| 5 | `POST /signup/store` | `signup_provision`, only for a `paid` purchase of the caller: tenant + Owner membership + store (the store address is made from the name, with a short suffix when taken or reserved), the paid plan becomes the **active** subscription (no trial), and a **paid invoice** and the payment are recorded so billing history is complete. Sending it again returns the same store. |

`GET /signup/status` says which step is next (`none`, `payment_required`, `store_required`, `provisioned`).

## Safety rules

- **Never trust the browser for money.** An order becomes `paid` only inside `signup_apply_payment`, called after the signature and Razorpay's own answer (or the signed webhook). The webhook only marks the order paid; it never creates a tenant, so a replayed event cannot create a second one.
- **Retry.** A failed payment only records why (`last_failure_description`); the order stays open and is paid again on the same Razorpay order.
- **Late or stray money.** A payment that arrives for an order that was replaced, or a second payment for an order that is already paid, is kept and flagged `refund_required`.
- **Tenant isolation.** `signup_orders` has row level security (a person reads only their own rows; billing staff read all). Every `signup_*` function checks `auth.uid()` and refuses the PostgREST role. The created tenant is an ordinary one: all existing tenant RLS and role checks apply.
- **Staff are never customers.** A Platform Admin cannot buy a store (`platform_admin_cannot_be_member`), because a person is platform staff or an organization member, never both.
- **Platform Admin routes** are unchanged and still guarded on the server (`PlatformAdminGuard` and the SQL role checks); `test/signup.e2e-spec.ts` checks that a signed-in customer gets 403 on them.

## Known limits of this version

- No e-mail verification, OTP or password recovery: anyone can register with any address.
- Registering with an address that is already in use answers `EMAIL_TAKEN`, which tells a visitor that the address is registered. Limits: the sign-in rate limit and a throttle apply.
- A plan's trial days are not used for a purchase: the customer pays up front and the plan is active at once.
- Refunds of `refund_required` payments are done by billing staff from the existing billing screens (or the Razorpay dashboard); nothing refunds automatically.
- Tests use a stand-in for Razorpay and Supabase Auth; nothing has been run against the real Razorpay sandbox or the shared Supabase database. Migration `0070` must be applied (`scripts/db-migrate.ts`) before the new routes work.
