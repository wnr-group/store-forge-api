-- Custom migration: GST. The seller's tax settings, product tax fields, and the tax saved on every order, line by line.
--
-- An organization that has not turned tax on charges none (exactly as before). One that has, saves its GSTIN and whether its prices
-- include tax; each product may carry its own rate and HSN/SAC code (otherwise the organization's default rate applies). At
-- checkout the server works out CGST+SGST (same state) or IGST (different state) for every item, the delivery charge and the cash-
-- on-delivery charge, and saves the result on the order as it was: later changes to settings or products never rewrite it.
-- Rates are stored in basis points (1800 = 18%), amounts in paise.

CREATE TABLE "tenant_tax_settings" (
  "tenant_id" uuid PRIMARY KEY REFERENCES "tenants"("id") ON DELETE CASCADE,
  "enabled" boolean NOT NULL DEFAULT false,
  "gstin" text,
  "legal_name" text,
  -- The two-digit GST state code of the seller, always the first two characters of the GSTIN.
  "state_code" text,
  "prices_include_tax" boolean NOT NULL DEFAULT false,
  "default_rate_bps" integer NOT NULL DEFAULT 1800,
  -- Delivery and cash-on-delivery charges are taxed too (as a service), at their own rate.
  "charges_taxable" boolean NOT NULL DEFAULT true,
  "charges_rate_bps" integer NOT NULL DEFAULT 1800,
  "updated_at" timestamp with time zone NOT NULL DEFAULT now(),
  "updated_by" uuid REFERENCES "auth"."users"("id") ON DELETE SET NULL,
  CONSTRAINT "tenant_tax_settings_gstin_check" CHECK ("gstin" IS NULL OR "gstin" ~ '^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][1-9A-Z]Z[0-9A-Z]$'),
  CONSTRAINT "tenant_tax_settings_state_check" CHECK ("state_code" IS NULL OR ("state_code" ~ '^[0-9]{2}$' AND "gstin" IS NOT NULL AND substr("gstin", 1, 2) = "state_code")),
  CONSTRAINT "tenant_tax_settings_enabled_check" CHECK (NOT "enabled" OR ("gstin" IS NOT NULL AND "state_code" IS NOT NULL)),
  CONSTRAINT "tenant_tax_settings_rates_check" CHECK (
    "default_rate_bps" IN (0, 25, 300, 500, 1200, 1800, 2800, 4000) AND "charges_rate_bps" IN (0, 25, 300, 500, 1200, 1800, 2800, 4000)),
  CONSTRAINT "tenant_tax_settings_legal_name_check" CHECK ("legal_name" IS NULL OR char_length("legal_name") BETWEEN 1 AND 200)
);
--> statement-breakpoint
ALTER TABLE "tenant_tax_settings" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
REVOKE ALL ON "tenant_tax_settings" FROM public, anon, authenticated;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON "tenant_tax_settings" TO authenticated;
--> statement-breakpoint
CREATE POLICY tenant_tax_settings_select ON public.tenant_tax_settings FOR SELECT TO authenticated
  USING (public.has_module_access(tenant_id, 'settings', 'read') AND session_user <> 'authenticator');
--> statement-breakpoint
CREATE POLICY tenant_tax_settings_insert ON public.tenant_tax_settings FOR INSERT TO authenticated
  WITH CHECK (public.has_module_access(tenant_id, 'settings', 'write') AND session_user <> 'authenticator' AND updated_by = (SELECT auth.uid()));
--> statement-breakpoint
CREATE POLICY tenant_tax_settings_update ON public.tenant_tax_settings FOR UPDATE TO authenticated
  USING (public.has_module_access(tenant_id, 'settings', 'write') AND session_user <> 'authenticator')
  WITH CHECK (public.has_module_access(tenant_id, 'settings', 'write') AND session_user <> 'authenticator' AND updated_by = (SELECT auth.uid()));
--> statement-breakpoint
GRANT SELECT ON "tenant_tax_settings" TO storeforge_checkout;
--> statement-breakpoint
CREATE POLICY tenant_tax_settings_checkout_pinned ON public.tenant_tax_settings FOR SELECT TO storeforge_checkout
  USING (tenant_id = public.pinned_tenant_id());
--> statement-breakpoint

-- Product tax fields. No rate means "use the organization's default rate".
ALTER TABLE "products" ADD COLUMN "tax_rate_bps" integer,
  ADD COLUMN "hsn_code" text,
  ADD CONSTRAINT "products_tax_rate_check" CHECK ("tax_rate_bps" IS NULL OR "tax_rate_bps" IN (0, 25, 300, 500, 1200, 1800, 2800, 4000)),
  ADD CONSTRAINT "products_hsn_check" CHECK ("hsn_code" IS NULL OR "hsn_code" ~ '^([0-9]{4}|[0-9]{6}|[0-9]{8})$');
--> statement-breakpoint
-- Product edits are granted column by column: the new columns join that grant.
GRANT UPDATE ("tax_rate_bps", "hsn_code") ON public.products TO authenticated;
--> statement-breakpoint

-- What was charged, on the order. `tax_minor` was already there; these say which tax it was and where it was due.
ALTER TABLE "orders" ADD COLUMN "tax_regime" text NOT NULL DEFAULT 'none',
  ADD COLUMN "state_tax_kind" text NOT NULL DEFAULT 'sgst',
  ADD COLUMN "cgst_minor" bigint NOT NULL DEFAULT 0,
  ADD COLUMN "sgst_minor" bigint NOT NULL DEFAULT 0,
  ADD COLUMN "igst_minor" bigint NOT NULL DEFAULT 0,
  ADD COLUMN "seller_gstin" text,
  ADD COLUMN "seller_state_code" text,
  ADD COLUMN "supply_state_code" text,
  ADD CONSTRAINT "orders_tax_regime_check" CHECK ("tax_regime" IN ('none', 'intra', 'inter')),
  ADD CONSTRAINT "orders_state_tax_kind_check" CHECK ("state_tax_kind" IN ('sgst', 'utgst')),
  ADD CONSTRAINT "orders_tax_parts_check" CHECK (
    "cgst_minor" >= 0 AND "sgst_minor" >= 0 AND "igst_minor" >= 0 AND "tax_minor" = "cgst_minor" + "sgst_minor" + "igst_minor"
    AND ("tax_regime" <> 'inter' OR ("cgst_minor" = 0 AND "sgst_minor" = 0))
    AND ("tax_regime" <> 'intra' OR ("igst_minor" = 0 AND "cgst_minor" = "sgst_minor"))
    AND ("tax_regime" <> 'none' OR "tax_minor" = 0));
--> statement-breakpoint

-- One row per taxed line of an order: each item, the delivery charge, the cash-on-delivery charge.
CREATE TABLE "order_tax_lines" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "tenant_id" uuid NOT NULL REFERENCES "tenants"("id") ON DELETE CASCADE,
  "order_id" uuid NOT NULL,
  "order_item_id" uuid REFERENCES "order_items"("id") ON DELETE CASCADE,
  "kind" text NOT NULL,
  "description" text NOT NULL,
  "hsn_code" text,
  "taxable_minor" bigint NOT NULL,
  "rate_bps" integer NOT NULL,
  "cgst_minor" bigint NOT NULL DEFAULT 0,
  "sgst_minor" bigint NOT NULL DEFAULT 0,
  "igst_minor" bigint NOT NULL DEFAULT 0,
  "tax_minor" bigint NOT NULL,
  "sort_order" integer NOT NULL DEFAULT 0,
  CONSTRAINT "order_tax_lines_order_fk" FOREIGN KEY ("tenant_id", "order_id") REFERENCES "orders"("tenant_id", "id") ON DELETE CASCADE,
  CONSTRAINT "order_tax_lines_kind_check" CHECK ("kind" IN ('item', 'shipping', 'cod_fee')),
  CONSTRAINT "order_tax_lines_item_check" CHECK ("kind" = 'item' OR "order_item_id" IS NULL),
  CONSTRAINT "order_tax_lines_amounts_check" CHECK (
    "taxable_minor" >= 0 AND "cgst_minor" >= 0 AND "sgst_minor" >= 0 AND "igst_minor" >= 0
    AND "tax_minor" = "cgst_minor" + "sgst_minor" + "igst_minor"
    AND ("igst_minor" = 0 OR ("cgst_minor" = 0 AND "sgst_minor" = 0))
    AND "cgst_minor" = "sgst_minor"),
  CONSTRAINT "order_tax_lines_rate_check" CHECK ("rate_bps" IN (0, 25, 300, 500, 1200, 1800, 2800, 4000)),
  CONSTRAINT "order_tax_lines_hsn_check" CHECK ("hsn_code" IS NULL OR "hsn_code" ~ '^([0-9]{4}|[0-9]{6}|[0-9]{8})$')
);
--> statement-breakpoint
CREATE INDEX "order_tax_lines_order_idx" ON "order_tax_lines" ("tenant_id", "order_id", "sort_order");
--> statement-breakpoint
ALTER TABLE "order_tax_lines" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
REVOKE ALL ON "order_tax_lines" FROM public, anon, authenticated;
--> statement-breakpoint
GRANT SELECT ON "order_tax_lines" TO authenticated;
--> statement-breakpoint
CREATE POLICY order_tax_lines_select ON public.order_tax_lines FOR SELECT TO authenticated
  USING (public.has_module_access(tenant_id, 'orders', 'read') AND session_user <> 'authenticator');
--> statement-breakpoint
-- Written once, with the order, by the checkout (the tenant-pinned role); never edited afterwards.
GRANT SELECT, INSERT ON "order_tax_lines" TO storeforge_checkout;
--> statement-breakpoint
CREATE POLICY order_tax_lines_checkout_pinned ON public.order_tax_lines FOR ALL TO storeforge_checkout
  USING (tenant_id = public.pinned_tenant_id()) WITH CHECK (tenant_id = public.pinned_tenant_id());
