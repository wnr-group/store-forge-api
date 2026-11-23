-- Custom migration: a dormant per-tenant switch for future shopper authentication.
--
-- The column only EXISTS. Nothing reads or writes it: no endpoint, DTO, accessor, permission or screen. Every existing tenant
-- gets false. The `authenticated` role keeps its existing tenants grants (table-level SELECT and DELETE, UPDATE on name and slug
-- only), so a tenant Owner or Admin cannot change it, and no response includes it because no DTO maps it.
-- Independent of 0042: it does not reference the payments table.

ALTER TABLE "tenants" ADD COLUMN "customer_auth_enabled" boolean DEFAULT false NOT NULL;
