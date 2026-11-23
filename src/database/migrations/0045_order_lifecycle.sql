-- Custom migration: the order lifecycle, inventory reservations and the tenant-pinned checkout role.
--
-- 1. Orders were read-only (no checkout). They now carry a lifecycle status, a payment status, a payment method, money
--    breakdown columns (discount, shipping, COD fee, tax) and a customer snapshot (guests have no customer row).
--    Legacy statuses are mapped: pending -> pending_payment, paid -> confirmed, fulfilled -> delivered, refunded -> returned.
-- 2. order_addresses (shipping/billing snapshots), order_status_history (append-only audit trail),
--    inventory_reservations (stock held for an unpaid order), tenant_order_counters (gap-free per-tenant order numbers).
-- 3. `storeforge_checkout`: a NOLOGIN role for the flows that have no signed-in user (guest checkout, payment webhooks,
--    the reservation-expiry job). The API switches to it with SET LOCAL ROLE and pins ONE tenant for the transaction
--    (`app.tenant_id`, resolved server-side from the store/webhook URL, never from a request body). Every policy below
--    requires tenant_id = that pinned value, so the role can never read or write another tenant's rows. It has no
--    access to the payment credential tables at all (credentials are read through a dedicated reviewed function later).

-- Roles ---------------------------------------------------------------------------------------------------------
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'storeforge_checkout') THEN
    CREATE ROLE storeforge_checkout NOLOGIN NOINHERIT NOBYPASSRLS;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'storeforge_app') THEN
    GRANT storeforge_checkout TO storeforge_app;
  END IF;
END
$$;
--> statement-breakpoint
GRANT USAGE ON SCHEMA public TO storeforge_checkout;
--> statement-breakpoint

CREATE FUNCTION public.pinned_tenant_id()
RETURNS uuid
LANGUAGE sql
STABLE
SET search_path = ''
AS $$
  SELECT nullif(current_setting('app.tenant_id', true), '')::uuid
$$;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION public.pinned_tenant_id() TO storeforge_checkout, authenticated;
--> statement-breakpoint

-- Orders ----------------------------------------------------------------------------------------------------------
ALTER TABLE "orders" DROP CONSTRAINT "orders_status_check";
--> statement-breakpoint
UPDATE "orders" SET "status" = CASE "status"
  WHEN 'pending' THEN 'pending_payment' WHEN 'paid' THEN 'confirmed'
  WHEN 'fulfilled' THEN 'delivered' WHEN 'refunded' THEN 'returned' ELSE "status" END;
--> statement-breakpoint
ALTER TABLE "orders"
  ALTER COLUMN "status" SET DEFAULT 'pending_payment',
  ADD COLUMN "payment_method" text,
  ADD COLUMN "payment_status" text NOT NULL DEFAULT 'unpaid',
  ADD COLUMN "fulfillment_status" text NOT NULL DEFAULT 'unfulfilled',
  ADD COLUMN "discount_minor" bigint NOT NULL DEFAULT 0,
  ADD COLUMN "shipping_minor" bigint NOT NULL DEFAULT 0,
  ADD COLUMN "cod_fee_minor" bigint NOT NULL DEFAULT 0,
  ADD COLUMN "tax_minor" bigint NOT NULL DEFAULT 0,
  ADD COLUMN "tax_inclusive" boolean NOT NULL DEFAULT false,
  ADD COLUMN "customer_name" text,
  ADD COLUMN "customer_email" text,
  ADD COLUMN "customer_phone" text,
  ADD COLUMN "idempotency_key" text,
  ADD COLUMN "cancelled_at" timestamp with time zone,
  ADD COLUMN "cancel_reason" text,
  ADD COLUMN "updated_at" timestamp with time zone NOT NULL DEFAULT now(),
  ADD CONSTRAINT "orders_status_check" CHECK ("status" IN ('pending_payment', 'confirmed', 'processing', 'ready_to_ship',
    'shipped', 'out_for_delivery', 'delivered', 'cancelled', 'failed', 'returned')),
  ADD CONSTRAINT "orders_payment_method_check" CHECK ("payment_method" IS NULL OR "payment_method" IN ('razorpay', 'cod')),
  ADD CONSTRAINT "orders_payment_status_check" CHECK ("payment_status" IN ('unpaid', 'pending_collection', 'paid', 'collected',
    'failed', 'partially_refunded', 'refunded')),
  ADD CONSTRAINT "orders_fulfillment_status_check" CHECK ("fulfillment_status" IN ('unfulfilled', 'partial', 'fulfilled', 'returned')),
  ADD CONSTRAINT "orders_breakdown_check" CHECK ("discount_minor" >= 0 AND "shipping_minor" >= 0 AND "cod_fee_minor" >= 0 AND "tax_minor" >= 0),
  ADD CONSTRAINT "orders_idempotency_key_check" CHECK ("idempotency_key" IS NULL OR char_length("idempotency_key") BETWEEN 8 AND 128),
  ADD CONSTRAINT "orders_cod_fee_method_check" CHECK ("cod_fee_minor" = 0 OR "payment_method" = 'cod');
--> statement-breakpoint
-- Enforced for every new or changed order; legacy rows (no breakdown) are not re-validated.
ALTER TABLE "orders" ADD CONSTRAINT "orders_total_check" CHECK (
  "total_minor" = "subtotal_minor" - "discount_minor" + "shipping_minor" + "cod_fee_minor"
    + CASE WHEN "tax_inclusive" THEN 0 ELSE "tax_minor" END
) NOT VALID;
--> statement-breakpoint
CREATE UNIQUE INDEX "orders_tenant_idempotency_key" ON "orders" ("tenant_id", "idempotency_key") WHERE "idempotency_key" IS NOT NULL;
--> statement-breakpoint
CREATE INDEX "orders_tenant_status_idx" ON "orders" ("tenant_id", "status", "placed_at" DESC);
--> statement-breakpoint

ALTER TABLE "order_items"
  ADD COLUMN "tax_minor" bigint NOT NULL DEFAULT 0,
  ADD COLUMN "tax_rate_bps" integer NOT NULL DEFAULT 0,
  ADD COLUMN "hsn_code" text,
  ADD COLUMN "weight_grams" integer NOT NULL DEFAULT 0,
  ADD CONSTRAINT "order_items_tax_check" CHECK ("tax_minor" >= 0 AND "tax_rate_bps" BETWEEN 0 AND 10000 AND "weight_grams" >= 0);
--> statement-breakpoint

-- Addresses (snapshots) -------------------------------------------------------------------------------------------
CREATE TABLE "order_addresses" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "tenant_id" uuid NOT NULL REFERENCES "tenants"("id") ON DELETE CASCADE,
  "order_id" uuid NOT NULL,
  "kind" text NOT NULL,
  "full_name" text NOT NULL,
  "phone" text NOT NULL,
  "line1" text NOT NULL,
  "line2" text,
  "city" text NOT NULL,
  "state" text NOT NULL,
  "state_code" text,
  "postal_code" text NOT NULL,
  "country" text NOT NULL DEFAULT 'IN',
  CONSTRAINT "order_addresses_order_fk" FOREIGN KEY ("tenant_id", "order_id") REFERENCES "orders"("tenant_id", "id") ON DELETE CASCADE,
  CONSTRAINT "order_addresses_order_kind_key" UNIQUE ("order_id", "kind"),
  CONSTRAINT "order_addresses_kind_check" CHECK ("kind" IN ('shipping', 'billing')),
  CONSTRAINT "order_addresses_country_check" CHECK ("country" ~ '^[A-Z]{2}$'),
  CONSTRAINT "order_addresses_fields_check" CHECK (
    char_length(btrim("full_name")) BETWEEN 1 AND 120 AND char_length("phone") BETWEEN 4 AND 32
    AND char_length(btrim("line1")) BETWEEN 1 AND 200 AND ("line2" IS NULL OR char_length("line2") <= 200)
    AND char_length(btrim("city")) BETWEEN 1 AND 100 AND char_length(btrim("state")) BETWEEN 1 AND 100
    AND char_length("postal_code") BETWEEN 3 AND 12)
);
--> statement-breakpoint
CREATE INDEX "order_addresses_postal_idx" ON "order_addresses" ("tenant_id", "postal_code");
--> statement-breakpoint

-- Status history (append-only) ------------------------------------------------------------------------------------
CREATE TABLE "order_status_history" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "tenant_id" uuid NOT NULL REFERENCES "tenants"("id") ON DELETE CASCADE,
  "order_id" uuid NOT NULL,
  "from_status" text,
  "to_status" text NOT NULL,
  "actor_type" text NOT NULL,
  "actor_id" uuid,
  "note" text,
  "created_at" timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT "order_status_history_order_fk" FOREIGN KEY ("tenant_id", "order_id") REFERENCES "orders"("tenant_id", "id") ON DELETE CASCADE,
  CONSTRAINT "order_status_history_actor_check" CHECK ("actor_type" IN ('customer', 'owner', 'member', 'system', 'payment', 'carrier')),
  CONSTRAINT "order_status_history_note_check" CHECK ("note" IS NULL OR char_length("note") <= 500)
);
--> statement-breakpoint
CREATE INDEX "order_status_history_order_idx" ON "order_status_history" ("order_id", "created_at");
--> statement-breakpoint

-- Inventory reservations ------------------------------------------------------------------------------------------
-- Stock on hand stays in products.quantity / product_variants.quantity. Available = on hand - SUM(active reservations),
-- computed while the stock row is locked FOR UPDATE, so concurrent checkouts serialise per product or variant.
CREATE TABLE "inventory_reservations" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "tenant_id" uuid NOT NULL REFERENCES "tenants"("id") ON DELETE CASCADE,
  "order_id" uuid NOT NULL,
  "product_id" uuid NOT NULL,
  "variant_id" uuid,
  "quantity" integer NOT NULL,
  "status" text NOT NULL DEFAULT 'active',
  "expires_at" timestamp with time zone NOT NULL,
  "created_at" timestamp with time zone NOT NULL DEFAULT now(),
  "resolved_at" timestamp with time zone,
  CONSTRAINT "inventory_reservations_order_fk" FOREIGN KEY ("tenant_id", "order_id") REFERENCES "orders"("tenant_id", "id") ON DELETE CASCADE,
  CONSTRAINT "inventory_reservations_product_fk" FOREIGN KEY ("tenant_id", "product_id") REFERENCES "products"("tenant_id", "id") ON DELETE CASCADE,
  CONSTRAINT "inventory_reservations_variant_fk" FOREIGN KEY ("tenant_id", "variant_id") REFERENCES "product_variants"("tenant_id", "id") ON DELETE CASCADE,
  CONSTRAINT "inventory_reservations_quantity_check" CHECK ("quantity" > 0),
  CONSTRAINT "inventory_reservations_status_check" CHECK ("status" IN ('active', 'committed', 'released', 'expired')),
  CONSTRAINT "inventory_reservations_resolved_check" CHECK (("status" = 'active') = ("resolved_at" IS NULL))
);
--> statement-breakpoint
CREATE INDEX "inventory_reservations_active_idx" ON "inventory_reservations" ("tenant_id", "product_id", "variant_id") WHERE "status" = 'active';
--> statement-breakpoint
CREATE INDEX "inventory_reservations_expiry_idx" ON "inventory_reservations" ("expires_at") WHERE "status" = 'active';
--> statement-breakpoint
CREATE INDEX "inventory_reservations_order_idx" ON "inventory_reservations" ("order_id");
--> statement-breakpoint

-- Per-tenant order numbers ----------------------------------------------------------------------------------------
CREATE TABLE "tenant_order_counters" (
  "tenant_id" uuid PRIMARY KEY REFERENCES "tenants"("id") ON DELETE CASCADE,
  "last_number" integer NOT NULL DEFAULT 0,
  CONSTRAINT "tenant_order_counters_check" CHECK ("last_number" >= 0)
);
--> statement-breakpoint
INSERT INTO "tenant_order_counters" ("tenant_id", "last_number")
  SELECT "tenant_id", max("order_number") FROM "orders" GROUP BY "tenant_id";
--> statement-breakpoint

ALTER TABLE "order_addresses" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "order_status_history" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "inventory_reservations" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "tenant_order_counters" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint

-- Dashboard (authenticated) access --------------------------------------------------------------------------------
-- Members with the orders module read what the checkout wrote. Status changes by the Owner/members go through the API
-- (UPDATE of the lifecycle columns only); inserts and deletes of orders stay closed to dashboard users.
REVOKE ALL ON "order_addresses", "order_status_history", "inventory_reservations", "tenant_order_counters" FROM public, anon, authenticated;
--> statement-breakpoint
GRANT SELECT ON "order_addresses", "order_status_history", "inventory_reservations" TO authenticated;
--> statement-breakpoint
GRANT INSERT ON "order_status_history" TO authenticated;
--> statement-breakpoint
GRANT UPDATE ("status", "payment_status", "fulfillment_status", "cancelled_at", "cancel_reason", "updated_at") ON "orders" TO authenticated;
--> statement-breakpoint
CREATE POLICY order_addresses_select_member ON public.order_addresses FOR SELECT TO authenticated
  USING (public.has_module_access(tenant_id, 'orders', 'read'));
--> statement-breakpoint
CREATE POLICY order_status_history_select_member ON public.order_status_history FOR SELECT TO authenticated
  USING (public.has_module_access(tenant_id, 'orders', 'read'));
--> statement-breakpoint
CREATE POLICY order_status_history_insert_member ON public.order_status_history FOR INSERT TO authenticated
  WITH CHECK (public.has_module_access(tenant_id, 'orders', 'write') AND actor_type IN ('owner', 'member') AND actor_id = (SELECT auth.uid()));
--> statement-breakpoint
CREATE POLICY inventory_reservations_select_member ON public.inventory_reservations FOR SELECT TO authenticated
  USING (public.has_module_access(tenant_id, 'products', 'read'));
--> statement-breakpoint
-- The existing orders policies only allow SELECT to members; add the UPDATE path for the lifecycle columns.
CREATE POLICY orders_update_member ON public.orders FOR UPDATE TO authenticated
  USING (public.has_module_access(tenant_id, 'orders', 'write'))
  WITH CHECK (public.has_module_access(tenant_id, 'orders', 'write'));
--> statement-breakpoint

-- Checkout role (tenant-pinned) -----------------------------------------------------------------------------------
GRANT SELECT, INSERT ON "orders", "order_items", "order_addresses", "inventory_reservations" TO storeforge_checkout;
--> statement-breakpoint
GRANT INSERT, SELECT ON "order_status_history" TO storeforge_checkout;
--> statement-breakpoint
GRANT UPDATE ("status", "payment_status", "fulfillment_status", "cancelled_at", "cancel_reason", "updated_at", "payment_method") ON "orders" TO storeforge_checkout;
--> statement-breakpoint
GRANT UPDATE ("status", "resolved_at") ON "inventory_reservations" TO storeforge_checkout;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON "tenant_order_counters" TO storeforge_checkout;
--> statement-breakpoint
GRANT SELECT ON "products", "product_variants", "stores", "tenants" TO storeforge_checkout;
--> statement-breakpoint
GRANT UPDATE ("quantity", "updated_at") ON "products", "product_variants" TO storeforge_checkout;
--> statement-breakpoint
GRANT INSERT ON "inventory_adjustments" TO storeforge_checkout;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ("full_name", "phone", "updated_at") ON "customers" TO storeforge_checkout;
--> statement-breakpoint

DO $pin$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['orders', 'order_items', 'order_addresses', 'order_status_history', 'inventory_reservations',
    'tenant_order_counters', 'inventory_adjustments', 'customers']
  LOOP
    EXECUTE format('CREATE POLICY %I ON public.%I FOR ALL TO storeforge_checkout USING (tenant_id = public.pinned_tenant_id()) WITH CHECK (tenant_id = public.pinned_tenant_id())',
      t || '_checkout_pinned', t);
  END LOOP;
  FOREACH t IN ARRAY ARRAY['products', 'product_variants']
  LOOP
    EXECUTE format('CREATE POLICY %I ON public.%I FOR ALL TO storeforge_checkout USING (tenant_id = public.pinned_tenant_id()) WITH CHECK (tenant_id = public.pinned_tenant_id())',
      t || '_checkout_pinned', t);
  END LOOP;
  CREATE POLICY stores_checkout_pinned ON public.stores FOR SELECT TO storeforge_checkout USING (tenant_id = public.pinned_tenant_id());
  CREATE POLICY tenants_checkout_pinned ON public.tenants FOR SELECT TO storeforge_checkout USING (id = public.pinned_tenant_id());
END
$pin$;
