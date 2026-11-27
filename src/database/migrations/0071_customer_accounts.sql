-- Custom migration: storefront customer accounts (a shopper's own login, separate from owners, staff and platform admins).
--
--   * customer_accounts: one login per shopper PER STORE (email unique per tenant). It is NOT a Supabase Auth user: the password hash,
--     the session and every rule live here, so a customer credential can never be mistaken for an owner/staff/admin one. Each account
--     points at the store's existing `customers` row (the merchant's CRM record), so there is still one customer entity.
--   * customer_sessions: opaque, server-side sessions. Only the SHA-256 of the token is stored; a session belongs to one tenant and one
--     account, expires, and can be revoked (sign-out).
--   * customer_addresses: the shopper's saved delivery addresses (an address book; an order still snapshots its own copy).
--   * orders.account_id: ties an order to the account it was placed from. A shopper's order history is exactly the orders with their
--     account id, so someone who registers with an email that bought as a guest earlier does NOT inherit that guest's orders.
--
-- Access: ONLY the tenant-pinned `storeforge_checkout` role (the storefront API) can read or write these tables, and only inside the
-- pinned tenant. Dashboard roles (`authenticated`) and anonymous callers get nothing, so an owner can never read a password hash.

CREATE TABLE "customer_accounts" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "tenant_id" uuid NOT NULL REFERENCES "tenants"("id") ON DELETE CASCADE,
  "customer_id" uuid NOT NULL,
  "email" text NOT NULL,
  "full_name" text NOT NULL,
  "phone" text,
  "password_hash" text NOT NULL,
  "failed_attempts" integer NOT NULL DEFAULT 0,
  "locked_until" timestamp with time zone,
  "last_login_at" timestamp with time zone,
  "created_at" timestamp with time zone NOT NULL DEFAULT now(),
  "updated_at" timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT "customer_accounts_tenant_id_id_key" UNIQUE ("tenant_id", "id"),
  CONSTRAINT "customer_accounts_customer_fk" FOREIGN KEY ("tenant_id", "customer_id") REFERENCES "customers"("tenant_id", "id") ON DELETE CASCADE,
  CONSTRAINT "customer_accounts_customer_key" UNIQUE ("customer_id"),
  CONSTRAINT "customer_accounts_email_check" CHECK (char_length("email") BETWEEN 3 AND 254 AND position('@' IN "email") > 1),
  CONSTRAINT "customer_accounts_full_name_check" CHECK (char_length(btrim("full_name")) BETWEEN 1 AND 120),
  CONSTRAINT "customer_accounts_phone_check" CHECK ("phone" IS NULL OR char_length("phone") BETWEEN 4 AND 32),
  CONSTRAINT "customer_accounts_attempts_check" CHECK ("failed_attempts" >= 0)
);
--> statement-breakpoint
CREATE UNIQUE INDEX "customer_accounts_tenant_email_key" ON "customer_accounts" ("tenant_id", lower("email"));
--> statement-breakpoint
CREATE TRIGGER customer_accounts_set_updated_at BEFORE UPDATE ON public.customer_accounts FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();
--> statement-breakpoint

CREATE TABLE "customer_sessions" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "tenant_id" uuid NOT NULL REFERENCES "tenants"("id") ON DELETE CASCADE,
  "account_id" uuid NOT NULL,
  "token_hash" text NOT NULL,
  "created_at" timestamp with time zone NOT NULL DEFAULT now(),
  "expires_at" timestamp with time zone NOT NULL,
  "revoked_at" timestamp with time zone,
  CONSTRAINT "customer_sessions_account_fk" FOREIGN KEY ("tenant_id", "account_id") REFERENCES "customer_accounts"("tenant_id", "id") ON DELETE CASCADE,
  CONSTRAINT "customer_sessions_token_key" UNIQUE ("token_hash"),
  CONSTRAINT "customer_sessions_token_check" CHECK ("token_hash" ~ '^[0-9a-f]{64}$')
);
--> statement-breakpoint
CREATE INDEX "customer_sessions_account_idx" ON "customer_sessions" ("account_id", "expires_at");
--> statement-breakpoint

CREATE TABLE "customer_addresses" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "tenant_id" uuid NOT NULL REFERENCES "tenants"("id") ON DELETE CASCADE,
  "account_id" uuid NOT NULL,
  "label" text,
  "full_name" text NOT NULL,
  "phone" text NOT NULL,
  "line1" text NOT NULL,
  "line2" text,
  "city" text NOT NULL,
  "state" text NOT NULL,
  "state_code" text,
  "postal_code" text NOT NULL,
  "country" text NOT NULL DEFAULT 'IN',
  "is_default" boolean NOT NULL DEFAULT false,
  "created_at" timestamp with time zone NOT NULL DEFAULT now(),
  "updated_at" timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT "customer_addresses_account_fk" FOREIGN KEY ("tenant_id", "account_id") REFERENCES "customer_accounts"("tenant_id", "id") ON DELETE CASCADE,
  CONSTRAINT "customer_addresses_label_check" CHECK ("label" IS NULL OR char_length("label") BETWEEN 1 AND 40),
  CONSTRAINT "customer_addresses_country_check" CHECK ("country" ~ '^[A-Z]{2}$'),
  CONSTRAINT "customer_addresses_fields_check" CHECK (
    char_length(btrim("full_name")) BETWEEN 1 AND 120 AND char_length("phone") BETWEEN 4 AND 32
    AND char_length(btrim("line1")) BETWEEN 1 AND 200 AND ("line2" IS NULL OR char_length("line2") <= 200)
    AND char_length(btrim("city")) BETWEEN 1 AND 100 AND char_length(btrim("state")) BETWEEN 1 AND 100
    AND char_length("postal_code") BETWEEN 3 AND 12)
);
--> statement-breakpoint
CREATE INDEX "customer_addresses_account_idx" ON "customer_addresses" ("account_id", "created_at");
--> statement-breakpoint
-- At most one default address per account.
CREATE UNIQUE INDEX "customer_addresses_default_key" ON "customer_addresses" ("account_id") WHERE "is_default";
--> statement-breakpoint
CREATE TRIGGER customer_addresses_set_updated_at BEFORE UPDATE ON public.customer_addresses FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();
--> statement-breakpoint

-- Orders placed from an account. Deleting the account keeps the order (the merchant's record), only the link goes.
ALTER TABLE "orders" ADD COLUMN "account_id" uuid;
--> statement-breakpoint
ALTER TABLE "orders" ADD CONSTRAINT "orders_account_fk" FOREIGN KEY ("tenant_id", "account_id") REFERENCES "customer_accounts"("tenant_id", "id") ON DELETE SET NULL ("account_id");
--> statement-breakpoint
CREATE INDEX "orders_account_placed_idx" ON "orders" ("account_id", "placed_at" DESC) WHERE "account_id" IS NOT NULL;
--> statement-breakpoint

-- Access ---------------------------------------------------------------------------------------------------------------------------------
ALTER TABLE "customer_accounts" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "customer_sessions" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "customer_addresses" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
-- Supabase grants new tables to anon/authenticated by default; nothing here is for them.
REVOKE ALL ON public.customer_accounts, public.customer_sessions, public.customer_addresses FROM public, anon, authenticated;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ("full_name", "phone", "password_hash", "failed_attempts", "locked_until", "last_login_at", "updated_at") ON "customer_accounts" TO storeforge_checkout;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ("revoked_at"), DELETE ON "customer_sessions" TO storeforge_checkout;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON "customer_addresses" TO storeforge_checkout;
--> statement-breakpoint

DO $pin$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['customer_accounts', 'customer_sessions', 'customer_addresses']
  LOOP
    EXECUTE format('CREATE POLICY %I ON public.%I FOR ALL TO storeforge_checkout USING (tenant_id = public.pinned_tenant_id()) WITH CHECK (tenant_id = public.pinned_tenant_id())',
      t || '_checkout_pinned', t);
  END LOOP;
END
$pin$;
