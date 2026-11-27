# Storefront customer accounts, orders and tracking

A shopper's own account in ONE store (migration `0071_customer_accounts`). Routes are listed in `API_ENDPOINT_INVENTORY.md` (rows 246-260). The frontend's side is `docs/customer-accounts.md` in the Next.js repo.

## Model

| Table | Holds | Notes |
|---|---|---|
| `customer_accounts` | the login: email, name, phone, scrypt password hash, failed attempts, lock | unique `(tenant_id, lower(email))`: the same email can have an account in each store. Points at the store's existing `customers` row (`customer_id`, unique) so there is still ONE customer entity. |
| `customer_sessions` | opaque sessions: SHA-256 of the token, expiry, revoked | 30 days. The token is shown once; only its hash is stored. |
| `customer_addresses` | saved delivery addresses | at most 10 per account; one default (partial unique index). Orders keep their own snapshot (`order_addresses`). |
| `orders.account_id` | the account an order was placed from | `ON DELETE SET NULL (account_id)`: deleting an account keeps the merchant's order. |

Products, inventory, payments (`payment_transactions`), shipments and status history are reused unchanged.

## Isolation

- **Database.** The three tables are reachable ONLY by `storeforge_checkout`, the tenant-pinned role, and every policy is `tenant_id = pinned_tenant_id()`. `anon` and `authenticated` (owners, staff, admins) have no grant at all, so a password hash can never be read from a dashboard session. Tested in `test/customer-accounts.e2e-spec.ts`.
- **API.** The tenant comes from the store slug in the URL (resolved on the server), the account from the session row, never from the body or a header. A token from store A is a 401 in store B. A shopper's order list is `where account_id = <session account>`, so another shopper's order, a guest order and an order of another store all answer 404.
- **Not an owner credential.** Routes under `/public/stores/:slug/account` are `@Public()` for the bearer guard and check the customer session themselves. A bearer token (owner, staff, admin) is not a customer session, and a customer session is a 401 on every other route.
- **Email is not verified.** Registering with the email of an earlier guest buyer creates an account on that email but does NOT show that buyer's orders (history is by `account_id`), and a profile update never rewrites the merchant's `customers` record.

## Placing an order

`POST /public/stores/:slug/orders` now needs `X-Customer-Session` (401 `CUSTOMER_LOGIN_REQUIRED` otherwise). Everything else is as before: prices, stock, discounts, shipping, GST and the total are decided in the one transaction; `Idempotency-Key` still prevents duplicates; the response still carries the one-time `accessToken` that the payment steps use. `CheckoutService.placeOrder(slug, dto, key, sessionToken?)` verifies the token against that store inside the transaction; without a token (tests, internal callers) no account is involved.

## Password handling

scrypt (N=16384, r=8, p=1, 16-byte salt) from Node's `crypto`, no new dependency. 8-128 characters with a letter and a number. 8 wrong passwords lock the account for 15 minutes; an unknown email costs the same time as a wrong password and gives the same answer. Changing the password signs out the other sessions. **There is no password recovery or reset.**

## Tracking

`GET /account/orders/:orderNumber` returns the order view of checkout plus `timeline`: every status the order moved into with its time (internal notes and actors are not included), and the parcels (courier, tracking number, link, carrier events). Owners update the order with `POST /orders/:id/status`, carrier bookings, or, for stores without a carrier integration, the manual parcel routes (`POST /orders/:orderId/shipments/manual`, `PATCH /shipments/:id/manual`): the order follows the parcel, and the shopper sees it on their next load.

## Limits

No email/SMS/push, no password reset, no email verification, no social sign-in, one currency per store (as before). Applying migration 0071 to the shared database is a separate, deliberate step (`npm run db:migrate`).
