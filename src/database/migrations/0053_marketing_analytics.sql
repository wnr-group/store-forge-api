-- Custom migration: Marketing & Analytics foundations (phase 1 of docs/MARKETING_ANALYTICS_PLAN.md).
--
-- promotional_campaigns / campaign_targets   what a campaign is and which products or collections it covers.
-- discount_codes / discount_code_targets     a tenant's codes: percentage or fixed, limits, window, scope.
-- discount_redemptions                       one row per order that used a code (usage limits and performance).
-- tenant_marketing_settings                  abandoned-cart threshold and recovery link lifetime.
-- abandoned_carts                            a server-side checkpoint of a cart whose shopper gave an email at checkout.
-- marketing_integrations / ..._events        a tenant's own Google Analytics 4 and Meta Pixel connections, and their audit log.
--
-- Access follows the modules that already exist (no new RLS module): discounts, campaigns, abandoned carts and reports use
-- `orders` read/write; integrations and marketing settings use `settings` read/write. Every policy shuts out the PostgREST
-- login role `authenticator`. Writes that must be atomic with an order (redemptions, abandoned-cart recovery) and the public
-- cart checkpoint are added by the phase that needs them, as SECURITY DEFINER functions or pinned-role policies.
-- Integration identifiers (a GA4 Measurement ID, a Pixel ID) are public by nature and live in `config`; the optional encrypted
-- secret columns exist for future server-side APIs (Conversions API, Measurement Protocol) and follow 0049 exactly.

-- Campaigns ----------------------------------------------------------------------------------------------------------------
CREATE TABLE "promotional_campaigns" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "tenant_id" uuid NOT NULL REFERENCES "tenants"("id") ON DELETE CASCADE,
  "name" text NOT NULL,
  "description" text,
  "status" text NOT NULL DEFAULT 'draft',
  "starts_at" timestamp with time zone,
  "ends_at" timestamp with time zone,
  -- Reserved for future email / SMS sends: { "email": { ... }, "sms": { ... } }. Nothing reads it yet.
  "channels" jsonb NOT NULL DEFAULT '{}'::jsonb,
  "created_at" timestamp with time zone NOT NULL DEFAULT now(),
  "created_by" uuid REFERENCES auth.users("id") ON DELETE SET NULL,
  "updated_at" timestamp with time zone NOT NULL DEFAULT now(),
  "updated_by" uuid REFERENCES auth.users("id") ON DELETE SET NULL,
  CONSTRAINT "pc_tenant_id_id_key" UNIQUE ("tenant_id", "id"),
  CONSTRAINT "pc_name_check" CHECK (char_length("name") BETWEEN 1 AND 120),
  CONSTRAINT "pc_description_check" CHECK ("description" IS NULL OR char_length("description") <= 2000),
  CONSTRAINT "pc_status_check" CHECK ("status" IN ('draft', 'active', 'paused', 'completed')),
  CONSTRAINT "pc_window_check" CHECK ("starts_at" IS NULL OR "ends_at" IS NULL OR "ends_at" > "starts_at"),
  CONSTRAINT "pc_channels_check" CHECK (jsonb_typeof("channels") = 'object' AND pg_column_size("channels") <= 8192)
);
--> statement-breakpoint
CREATE UNIQUE INDEX "pc_tenant_name_key" ON "promotional_campaigns" ("tenant_id", lower("name"));
--> statement-breakpoint
CREATE INDEX "pc_tenant_status_idx" ON "promotional_campaigns" ("tenant_id", "status", "created_at" DESC);
--> statement-breakpoint

CREATE TABLE "campaign_targets" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "tenant_id" uuid NOT NULL,
  "campaign_id" uuid NOT NULL,
  "product_id" uuid,
  "collection_id" uuid,
  CONSTRAINT "ct_campaign_fk" FOREIGN KEY ("tenant_id", "campaign_id") REFERENCES "promotional_campaigns"("tenant_id", "id") ON DELETE CASCADE,
  CONSTRAINT "ct_product_fk" FOREIGN KEY ("tenant_id", "product_id") REFERENCES "products"("tenant_id", "id") ON DELETE CASCADE,
  CONSTRAINT "ct_collection_fk" FOREIGN KEY ("tenant_id", "collection_id") REFERENCES "collections"("tenant_id", "id") ON DELETE CASCADE,
  CONSTRAINT "ct_one_target_check" CHECK (("product_id" IS NOT NULL) <> ("collection_id" IS NOT NULL))
);
--> statement-breakpoint
CREATE UNIQUE INDEX "ct_campaign_product_key" ON "campaign_targets" ("campaign_id", "product_id") WHERE "product_id" IS NOT NULL;
--> statement-breakpoint
CREATE UNIQUE INDEX "ct_campaign_collection_key" ON "campaign_targets" ("campaign_id", "collection_id") WHERE "collection_id" IS NOT NULL;
--> statement-breakpoint
CREATE INDEX "ct_tenant_idx" ON "campaign_targets" ("tenant_id");
--> statement-breakpoint

-- Discount codes -----------------------------------------------------------------------------------------------------------
CREATE TABLE "discount_codes" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "tenant_id" uuid NOT NULL REFERENCES "tenants"("id") ON DELETE CASCADE,
  "campaign_id" uuid,
  -- Always stored upper-case; the checkout upper-cases what the shopper typed before comparing.
  "code" text NOT NULL,
  "description" text,
  "kind" text NOT NULL,
  -- percentage: basis points (1000 = 10%); fixed: paise.
  "value" bigint NOT NULL,
  "min_subtotal_minor" bigint NOT NULL DEFAULT 0,
  -- Cap on one order's discount; only meaningful for a percentage code.
  "max_discount_minor" bigint,
  "starts_at" timestamp with time zone,
  "expires_at" timestamp with time zone,
  "usage_limit" integer,
  "per_customer_limit" integer,
  "applies_to" text NOT NULL DEFAULT 'all',
  "is_active" boolean NOT NULL DEFAULT true,
  -- Changed only by the order transaction (never by the dashboard): see the column grants below.
  "redemption_count" integer NOT NULL DEFAULT 0,
  "created_at" timestamp with time zone NOT NULL DEFAULT now(),
  "created_by" uuid REFERENCES auth.users("id") ON DELETE SET NULL,
  "updated_at" timestamp with time zone NOT NULL DEFAULT now(),
  "updated_by" uuid REFERENCES auth.users("id") ON DELETE SET NULL,
  CONSTRAINT "dc_tenant_id_id_key" UNIQUE ("tenant_id", "id"),
  CONSTRAINT "dc_tenant_code_key" UNIQUE ("tenant_id", "code"),
  CONSTRAINT "dc_campaign_fk" FOREIGN KEY ("tenant_id", "campaign_id") REFERENCES "promotional_campaigns"("tenant_id", "id") ON DELETE SET NULL ("campaign_id"),
  CONSTRAINT "dc_code_check" CHECK ("code" ~ '^[A-Z0-9][A-Z0-9_-]{2,31}$'),
  CONSTRAINT "dc_description_check" CHECK ("description" IS NULL OR char_length("description") <= 500),
  CONSTRAINT "dc_kind_check" CHECK ("kind" IN ('percentage', 'fixed')),
  CONSTRAINT "dc_value_check" CHECK (("kind" = 'percentage' AND "value" BETWEEN 1 AND 10000) OR ("kind" = 'fixed' AND "value" >= 1)),
  CONSTRAINT "dc_min_check" CHECK ("min_subtotal_minor" >= 0),
  CONSTRAINT "dc_max_check" CHECK ("max_discount_minor" IS NULL OR ("kind" = 'percentage' AND "max_discount_minor" >= 1)),
  CONSTRAINT "dc_window_check" CHECK ("starts_at" IS NULL OR "expires_at" IS NULL OR "expires_at" > "starts_at"),
  CONSTRAINT "dc_limits_check" CHECK (("usage_limit" IS NULL OR "usage_limit" >= 1) AND ("per_customer_limit" IS NULL OR "per_customer_limit" >= 1)),
  CONSTRAINT "dc_applies_to_check" CHECK ("applies_to" IN ('all', 'products', 'collections')),
  CONSTRAINT "dc_redemption_count_check" CHECK ("redemption_count" >= 0)
);
--> statement-breakpoint
CREATE INDEX "dc_tenant_created_idx" ON "discount_codes" ("tenant_id", "created_at" DESC);
--> statement-breakpoint
CREATE INDEX "dc_campaign_idx" ON "discount_codes" ("campaign_id") WHERE "campaign_id" IS NOT NULL;
--> statement-breakpoint

CREATE TABLE "discount_code_targets" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "tenant_id" uuid NOT NULL,
  "discount_id" uuid NOT NULL,
  "product_id" uuid,
  "collection_id" uuid,
  CONSTRAINT "dct_discount_fk" FOREIGN KEY ("tenant_id", "discount_id") REFERENCES "discount_codes"("tenant_id", "id") ON DELETE CASCADE,
  CONSTRAINT "dct_product_fk" FOREIGN KEY ("tenant_id", "product_id") REFERENCES "products"("tenant_id", "id") ON DELETE CASCADE,
  CONSTRAINT "dct_collection_fk" FOREIGN KEY ("tenant_id", "collection_id") REFERENCES "collections"("tenant_id", "id") ON DELETE CASCADE,
  CONSTRAINT "dct_one_target_check" CHECK (("product_id" IS NOT NULL) <> ("collection_id" IS NOT NULL))
);
--> statement-breakpoint
CREATE UNIQUE INDEX "dct_discount_product_key" ON "discount_code_targets" ("discount_id", "product_id") WHERE "product_id" IS NOT NULL;
--> statement-breakpoint
CREATE UNIQUE INDEX "dct_discount_collection_key" ON "discount_code_targets" ("discount_id", "collection_id") WHERE "collection_id" IS NOT NULL;
--> statement-breakpoint
CREATE INDEX "dct_tenant_idx" ON "discount_code_targets" ("tenant_id");
--> statement-breakpoint

-- One row per order that used a code. The order is the identity (an order has at most one code), so a replayed checkout can
-- never redeem twice. `customer_key` is the customer id when known, else the lower-cased email: it is what the per-customer
-- limit counts. The code text and amount are copied so history survives the code being edited or deleted.
CREATE TABLE "discount_redemptions" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "tenant_id" uuid NOT NULL REFERENCES "tenants"("id") ON DELETE CASCADE,
  "discount_id" uuid,
  "order_id" uuid NOT NULL,
  "code" text NOT NULL,
  "customer_key" text NOT NULL,
  "discount_minor" bigint NOT NULL,
  "created_at" timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT "dr_discount_fk" FOREIGN KEY ("tenant_id", "discount_id") REFERENCES "discount_codes"("tenant_id", "id") ON DELETE SET NULL ("discount_id"),
  CONSTRAINT "dr_order_fk" FOREIGN KEY ("tenant_id", "order_id") REFERENCES "orders"("tenant_id", "id") ON DELETE CASCADE,
  CONSTRAINT "dr_order_key" UNIQUE ("tenant_id", "order_id"),
  CONSTRAINT "dr_amount_check" CHECK ("discount_minor" >= 0),
  CONSTRAINT "dr_customer_key_check" CHECK (char_length("customer_key") BETWEEN 1 AND 320)
);
--> statement-breakpoint
CREATE INDEX "dr_discount_customer_idx" ON "discount_redemptions" ("discount_id", "customer_key");
--> statement-breakpoint
CREATE INDEX "dr_tenant_created_idx" ON "discount_redemptions" ("tenant_id", "created_at" DESC);
--> statement-breakpoint

-- Abandoned carts ----------------------------------------------------------------------------------------------------------
CREATE TABLE "tenant_marketing_settings" (
  "tenant_id" uuid PRIMARY KEY REFERENCES "tenants"("id") ON DELETE CASCADE,
  -- A cart with no activity for this long, and no order, counts as abandoned.
  "abandonment_threshold_minutes" integer NOT NULL DEFAULT 60,
  -- How long a recovery link keeps working after the cart was last active.
  "recovery_link_days" integer NOT NULL DEFAULT 14,
  "updated_at" timestamp with time zone NOT NULL DEFAULT now(),
  "updated_by" uuid REFERENCES auth.users("id") ON DELETE SET NULL,
  CONSTRAINT "tms_threshold_check" CHECK ("abandonment_threshold_minutes" BETWEEN 15 AND 10080),
  CONSTRAINT "tms_link_days_check" CHECK ("recovery_link_days" BETWEEN 1 AND 90)
);
--> statement-breakpoint

CREATE TABLE "abandoned_carts" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "tenant_id" uuid NOT NULL REFERENCES "tenants"("id") ON DELETE CASCADE,
  -- SHA-256 of the random id the browser keeps for its cart. The browser id itself is never stored.
  "cart_key_hash" text NOT NULL,
  -- SHA-256 of the recovery token placed in the recovery link. The token itself is never stored.
  "recovery_token_hash" text NOT NULL,
  "customer_id" uuid,
  "email" text,
  "phone" text,
  "customer_name" text,
  -- The shopper agreed to be contacted about this cart. Nothing is ever sent without it (and without a configured provider).
  "marketing_consent" boolean NOT NULL DEFAULT false,
  -- [{ "productId", "variantId", "name", "quantity", "unitPriceMinor" }]: a snapshot, re-priced when the cart is resumed.
  "items" jsonb NOT NULL,
  "item_count" integer NOT NULL,
  "cart_value_minor" bigint NOT NULL,
  "currency" text NOT NULL,
  "status" text NOT NULL DEFAULT 'active',
  "last_activity_at" timestamp with time zone NOT NULL DEFAULT now(),
  "abandoned_at" timestamp with time zone,
  "recovered_at" timestamp with time zone,
  "recovered_order_id" uuid,
  "recovery_clicks" integer NOT NULL DEFAULT 0,
  "created_at" timestamp with time zone NOT NULL DEFAULT now(),
  "updated_at" timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT "ac_tenant_id_id_key" UNIQUE ("tenant_id", "id"),
  CONSTRAINT "ac_tenant_cart_key" UNIQUE ("tenant_id", "cart_key_hash"),
  CONSTRAINT "ac_recovery_token_key" UNIQUE ("recovery_token_hash"),
  CONSTRAINT "ac_customer_fk" FOREIGN KEY ("tenant_id", "customer_id") REFERENCES "customers"("tenant_id", "id") ON DELETE SET NULL ("customer_id"),
  CONSTRAINT "ac_order_fk" FOREIGN KEY ("tenant_id", "recovered_order_id") REFERENCES "orders"("tenant_id", "id") ON DELETE SET NULL ("recovered_order_id"),
  CONSTRAINT "ac_status_check" CHECK ("status" IN ('active', 'abandoned', 'recovered', 'expired')),
  CONSTRAINT "ac_items_check" CHECK (jsonb_typeof("items") = 'array' AND jsonb_array_length("items") BETWEEN 1 AND 100 AND pg_column_size("items") <= 65536),
  CONSTRAINT "ac_amounts_check" CHECK ("cart_value_minor" >= 0 AND "item_count" >= 1),
  CONSTRAINT "ac_currency_check" CHECK ("currency" ~ '^[A-Z]{3}$'),
  CONSTRAINT "ac_email_check" CHECK ("email" IS NULL OR (char_length("email") <= 320 AND "email" = lower("email"))),
  CONSTRAINT "ac_recovered_check" CHECK (("status" = 'recovered') = ("recovered_at" IS NOT NULL)),
  CONSTRAINT "ac_abandoned_check" CHECK ("status" NOT IN ('abandoned', 'expired') OR "abandoned_at" IS NOT NULL)
);
--> statement-breakpoint
CREATE INDEX "ac_tenant_status_activity_idx" ON "abandoned_carts" ("tenant_id", "status", "last_activity_at" DESC);
--> statement-breakpoint
CREATE INDEX "ac_tenant_abandoned_idx" ON "abandoned_carts" ("tenant_id", "abandoned_at" DESC) WHERE "abandoned_at" IS NOT NULL;
--> statement-breakpoint

-- Integrations -------------------------------------------------------------------------------------------------------------
CREATE TABLE "marketing_integrations" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "tenant_id" uuid NOT NULL REFERENCES "tenants"("id") ON DELETE CASCADE,
  -- 'ga4', 'meta_pixel'; a future provider needs a code change, not a migration.
  "provider_code" text NOT NULL,
  -- Public identifiers only, e.g. { "measurementId": "G-XXXXXXXXXX" } or { "pixelId": "1234567890" }.
  "config" jsonb NOT NULL DEFAULT '{}'::jsonb,
  -- Optional server-side secret (future Conversions API token, Measurement Protocol API secret), AES-256-GCM like 0049.
  "secret_ciphertext" text,
  "iv" text,
  "auth_tag" text,
  "key_version" smallint,
  "enabled" boolean NOT NULL DEFAULT false,
  "validation_status" text NOT NULL DEFAULT 'unverified',
  "validated_at" timestamp with time zone,
  "validation_error" text,
  "created_at" timestamp with time zone NOT NULL DEFAULT now(),
  "created_by" uuid REFERENCES auth.users("id") ON DELETE SET NULL,
  "updated_at" timestamp with time zone NOT NULL DEFAULT now(),
  "updated_by" uuid REFERENCES auth.users("id") ON DELETE SET NULL,
  CONSTRAINT "mi_tenant_provider_key" UNIQUE ("tenant_id", "provider_code"),
  CONSTRAINT "mi_provider_check" CHECK ("provider_code" ~ '^[a-z][a-z0-9_]{1,30}$'),
  CONSTRAINT "mi_config_check" CHECK (jsonb_typeof("config") = 'object' AND pg_column_size("config") <= 4096),
  CONSTRAINT "mi_secret_all_or_none_check" CHECK (
    ("secret_ciphertext" IS NULL AND "iv" IS NULL AND "auth_tag" IS NULL AND "key_version" IS NULL)
    OR ("secret_ciphertext" IS NOT NULL AND "iv" IS NOT NULL AND "auth_tag" IS NOT NULL AND "key_version" >= 1
        AND "iv" ~ '^[A-Za-z0-9+/]{16}$' AND "auth_tag" ~ '^[A-Za-z0-9+/]{22}==$'
        AND "secret_ciphertext" ~ '^[A-Za-z0-9+/]+={0,2}$' AND char_length("secret_ciphertext") <= 2048)),
  CONSTRAINT "mi_validation_status_check" CHECK ("validation_status" IN ('unverified', 'valid', 'invalid')),
  CONSTRAINT "mi_validated_at_check" CHECK (("validation_status" = 'valid') = ("validated_at" IS NOT NULL)),
  CONSTRAINT "mi_enabled_needs_valid_check" CHECK (NOT "enabled" OR "validation_status" = 'valid'),
  CONSTRAINT "mi_validation_error_check" CHECK ("validation_error" IS NULL OR char_length("validation_error") <= 200)
);
--> statement-breakpoint

-- Changing the identifiers or the secret switches the integration off until it is validated again.
CREATE FUNCTION public.reset_marketing_integration_validation()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = ''
AS $$
BEGIN
  IF NEW.config IS DISTINCT FROM OLD.config OR NEW.secret_ciphertext IS DISTINCT FROM OLD.secret_ciphertext THEN
    NEW.enabled := false;
    NEW.validation_status := 'unverified';
    NEW.validated_at := NULL;
    NEW.validation_error := NULL;
  END IF;
  RETURN NEW;
END
$$;
--> statement-breakpoint
CREATE TRIGGER marketing_integrations_reset_validation
  BEFORE UPDATE ON public.marketing_integrations
  FOR EACH ROW EXECUTE FUNCTION public.reset_marketing_integration_validation();
--> statement-breakpoint

CREATE TABLE "marketing_integration_events" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "tenant_id" uuid NOT NULL REFERENCES "tenants"("id") ON DELETE CASCADE,
  "provider_code" text NOT NULL,
  "action" text NOT NULL,
  "actor_id" uuid,
  -- Never holds a secret or an identifier value: a short human note such as "Measurement ID changed".
  "note" text,
  "created_at" timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT "mie_action_check" CHECK ("action" IN ('configure', 'update', 'validate', 'validate_failed', 'enable', 'disable', 'remove')),
  CONSTRAINT "mie_provider_check" CHECK ("provider_code" ~ '^[a-z][a-z0-9_]{1,30}$'),
  CONSTRAINT "mie_note_check" CHECK ("note" IS NULL OR char_length("note") <= 300)
);
--> statement-breakpoint
CREATE INDEX "mie_tenant_created_idx" ON "marketing_integration_events" ("tenant_id", "created_at" DESC);
--> statement-breakpoint

-- Row level security -------------------------------------------------------------------------------------------------------
ALTER TABLE "promotional_campaigns" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "campaign_targets" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "discount_codes" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "discount_code_targets" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "discount_redemptions" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "tenant_marketing_settings" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "abandoned_carts" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "marketing_integrations" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "marketing_integration_events" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
REVOKE ALL ON "promotional_campaigns", "campaign_targets", "discount_codes", "discount_code_targets", "discount_redemptions",
  "tenant_marketing_settings", "abandoned_carts", "marketing_integrations", "marketing_integration_events" FROM public, anon, authenticated;
--> statement-breakpoint

-- Campaigns: orders read to look, orders write to change.
GRANT SELECT ON "promotional_campaigns" TO authenticated;
--> statement-breakpoint
GRANT INSERT ("tenant_id", "name", "description", "status", "starts_at", "ends_at", "channels", "created_by", "updated_by", "updated_at") ON "promotional_campaigns" TO authenticated;
--> statement-breakpoint
GRANT UPDATE ("name", "description", "status", "starts_at", "ends_at", "channels", "updated_by", "updated_at") ON "promotional_campaigns" TO authenticated;
--> statement-breakpoint
GRANT DELETE ON "promotional_campaigns" TO authenticated;
--> statement-breakpoint
CREATE POLICY pc_select ON public.promotional_campaigns FOR SELECT TO authenticated
  USING (public.has_module_access(tenant_id, 'orders', 'read') AND session_user <> 'authenticator');
--> statement-breakpoint
CREATE POLICY pc_insert ON public.promotional_campaigns FOR INSERT TO authenticated
  WITH CHECK (public.has_module_access(tenant_id, 'orders', 'write') AND session_user <> 'authenticator'
    AND created_by = (SELECT auth.uid()) AND updated_by = (SELECT auth.uid()));
--> statement-breakpoint
CREATE POLICY pc_update ON public.promotional_campaigns FOR UPDATE TO authenticated
  USING (public.has_module_access(tenant_id, 'orders', 'write') AND session_user <> 'authenticator')
  WITH CHECK (public.has_module_access(tenant_id, 'orders', 'write') AND session_user <> 'authenticator' AND updated_by = (SELECT auth.uid()));
--> statement-breakpoint
CREATE POLICY pc_delete ON public.promotional_campaigns FOR DELETE TO authenticated
  USING (public.has_module_access(tenant_id, 'orders', 'write') AND session_user <> 'authenticator');
--> statement-breakpoint

GRANT SELECT, INSERT, DELETE ON "campaign_targets" TO authenticated;
--> statement-breakpoint
CREATE POLICY ct_select ON public.campaign_targets FOR SELECT TO authenticated
  USING (public.has_module_access(tenant_id, 'orders', 'read') AND session_user <> 'authenticator');
--> statement-breakpoint
CREATE POLICY ct_insert ON public.campaign_targets FOR INSERT TO authenticated
  WITH CHECK (public.has_module_access(tenant_id, 'orders', 'write') AND session_user <> 'authenticator');
--> statement-breakpoint
CREATE POLICY ct_delete ON public.campaign_targets FOR DELETE TO authenticated
  USING (public.has_module_access(tenant_id, 'orders', 'write') AND session_user <> 'authenticator');
--> statement-breakpoint

-- Discount codes. `redemption_count` is deliberately absent from every dashboard grant.
GRANT SELECT ON "discount_codes" TO authenticated;
--> statement-breakpoint
GRANT INSERT ("tenant_id", "campaign_id", "code", "description", "kind", "value", "min_subtotal_minor", "max_discount_minor", "starts_at",
  "expires_at", "usage_limit", "per_customer_limit", "applies_to", "is_active", "created_by", "updated_by", "updated_at") ON "discount_codes" TO authenticated;
--> statement-breakpoint
GRANT UPDATE ("campaign_id", "description", "kind", "value", "min_subtotal_minor", "max_discount_minor", "starts_at", "expires_at",
  "usage_limit", "per_customer_limit", "applies_to", "is_active", "updated_by", "updated_at") ON "discount_codes" TO authenticated;
--> statement-breakpoint
GRANT DELETE ON "discount_codes" TO authenticated;
--> statement-breakpoint
CREATE POLICY dc_select ON public.discount_codes FOR SELECT TO authenticated
  USING (public.has_module_access(tenant_id, 'orders', 'read') AND session_user <> 'authenticator');
--> statement-breakpoint
CREATE POLICY dc_insert ON public.discount_codes FOR INSERT TO authenticated
  WITH CHECK (public.has_module_access(tenant_id, 'orders', 'write') AND session_user <> 'authenticator'
    AND created_by = (SELECT auth.uid()) AND updated_by = (SELECT auth.uid()));
--> statement-breakpoint
CREATE POLICY dc_update ON public.discount_codes FOR UPDATE TO authenticated
  USING (public.has_module_access(tenant_id, 'orders', 'write') AND session_user <> 'authenticator')
  WITH CHECK (public.has_module_access(tenant_id, 'orders', 'write') AND session_user <> 'authenticator' AND updated_by = (SELECT auth.uid()));
--> statement-breakpoint
CREATE POLICY dc_delete ON public.discount_codes FOR DELETE TO authenticated
  USING (public.has_module_access(tenant_id, 'orders', 'write') AND session_user <> 'authenticator');
--> statement-breakpoint
-- The checkout reads codes of the pinned tenant only; it records redemptions in phase 2 through a SECURITY DEFINER function.
GRANT SELECT ON "discount_codes", "discount_code_targets" TO storeforge_checkout;
--> statement-breakpoint
CREATE POLICY dc_checkout_pinned ON public.discount_codes FOR SELECT TO storeforge_checkout
  USING (tenant_id = public.pinned_tenant_id());
--> statement-breakpoint

GRANT SELECT, INSERT, DELETE ON "discount_code_targets" TO authenticated;
--> statement-breakpoint
CREATE POLICY dct_select ON public.discount_code_targets FOR SELECT TO authenticated
  USING (public.has_module_access(tenant_id, 'orders', 'read') AND session_user <> 'authenticator');
--> statement-breakpoint
CREATE POLICY dct_insert ON public.discount_code_targets FOR INSERT TO authenticated
  WITH CHECK (public.has_module_access(tenant_id, 'orders', 'write') AND session_user <> 'authenticator');
--> statement-breakpoint
CREATE POLICY dct_delete ON public.discount_code_targets FOR DELETE TO authenticated
  USING (public.has_module_access(tenant_id, 'orders', 'write') AND session_user <> 'authenticator');
--> statement-breakpoint
CREATE POLICY dct_checkout_pinned ON public.discount_code_targets FOR SELECT TO storeforge_checkout
  USING (tenant_id = public.pinned_tenant_id());
--> statement-breakpoint

-- Redemptions are read-only to the dashboard.
GRANT SELECT ON "discount_redemptions" TO authenticated;
--> statement-breakpoint
CREATE POLICY dr_select ON public.discount_redemptions FOR SELECT TO authenticated
  USING (public.has_module_access(tenant_id, 'orders', 'read') AND session_user <> 'authenticator');
--> statement-breakpoint

-- Marketing settings and abandoned carts: orders read to look; settings are changed with orders write. Carts are read-only here:
-- the storefront checkpoint and the recovery transitions are added in phase 3.
GRANT SELECT, INSERT, UPDATE ON "tenant_marketing_settings" TO authenticated;
--> statement-breakpoint
CREATE POLICY tms_select ON public.tenant_marketing_settings FOR SELECT TO authenticated
  USING (public.has_module_access(tenant_id, 'orders', 'read') AND session_user <> 'authenticator');
--> statement-breakpoint
CREATE POLICY tms_insert ON public.tenant_marketing_settings FOR INSERT TO authenticated
  WITH CHECK (public.has_module_access(tenant_id, 'settings', 'write') AND session_user <> 'authenticator' AND updated_by = (SELECT auth.uid()));
--> statement-breakpoint
CREATE POLICY tms_update ON public.tenant_marketing_settings FOR UPDATE TO authenticated
  USING (public.has_module_access(tenant_id, 'settings', 'write') AND session_user <> 'authenticator')
  WITH CHECK (public.has_module_access(tenant_id, 'settings', 'write') AND session_user <> 'authenticator' AND updated_by = (SELECT auth.uid()));
--> statement-breakpoint
-- (A `recovery_token_hash` and `cart_key_hash` are lookups, not secrets a dashboard needs: they are left out of the grant.)
GRANT SELECT ("id", "tenant_id", "customer_id", "email", "phone", "customer_name", "marketing_consent", "items", "item_count",
  "cart_value_minor", "currency", "status", "last_activity_at", "abandoned_at", "recovered_at", "recovered_order_id",
  "recovery_clicks", "created_at", "updated_at") ON "abandoned_carts" TO authenticated;
--> statement-breakpoint
CREATE POLICY ac_select ON public.abandoned_carts FOR SELECT TO authenticated
  USING (public.has_module_access(tenant_id, 'orders', 'read') AND session_user <> 'authenticator');
--> statement-breakpoint

-- Integrations: public identifiers readable by anyone who can see settings; changes need settings write. The ciphertext columns
-- are never granted: no SELECT, no UPDATE of their reading path besides the write-only INSERT/UPDATE below.
GRANT SELECT ("id", "tenant_id", "provider_code", "config", "enabled", "validation_status", "validated_at", "validation_error",
  "created_at", "created_by", "updated_at", "updated_by") ON "marketing_integrations" TO authenticated;
--> statement-breakpoint
GRANT INSERT ("tenant_id", "provider_code", "config", "secret_ciphertext", "iv", "auth_tag", "key_version", "created_by", "updated_by", "updated_at")
  ON "marketing_integrations" TO authenticated;
--> statement-breakpoint
GRANT UPDATE ("config", "secret_ciphertext", "iv", "auth_tag", "key_version", "updated_by", "updated_at") ON "marketing_integrations" TO authenticated;
--> statement-breakpoint
GRANT DELETE ON "marketing_integrations" TO authenticated;
--> statement-breakpoint
CREATE POLICY mi_select ON public.marketing_integrations FOR SELECT TO authenticated
  USING (public.has_module_access(tenant_id, 'settings', 'read') AND session_user <> 'authenticator');
--> statement-breakpoint
CREATE POLICY mi_insert ON public.marketing_integrations FOR INSERT TO authenticated
  WITH CHECK (public.has_module_access(tenant_id, 'settings', 'write') AND session_user <> 'authenticator'
    AND created_by = (SELECT auth.uid()) AND updated_by = (SELECT auth.uid()));
--> statement-breakpoint
CREATE POLICY mi_update ON public.marketing_integrations FOR UPDATE TO authenticated
  USING (public.has_module_access(tenant_id, 'settings', 'write') AND session_user <> 'authenticator')
  WITH CHECK (public.has_module_access(tenant_id, 'settings', 'write') AND session_user <> 'authenticator' AND updated_by = (SELECT auth.uid()));
--> statement-breakpoint
CREATE POLICY mi_delete ON public.marketing_integrations FOR DELETE TO authenticated
  USING (public.has_module_access(tenant_id, 'settings', 'write') AND session_user <> 'authenticator');
--> statement-breakpoint

GRANT SELECT, INSERT ON "marketing_integration_events" TO authenticated;
--> statement-breakpoint
CREATE POLICY mie_select ON public.marketing_integration_events FOR SELECT TO authenticated
  USING (public.has_module_access(tenant_id, 'settings', 'read') AND session_user <> 'authenticator');
--> statement-breakpoint
CREATE POLICY mie_insert ON public.marketing_integration_events FOR INSERT TO authenticated
  WITH CHECK (public.has_module_access(tenant_id, 'settings', 'write') AND session_user <> 'authenticator' AND actor_id = (SELECT auth.uid()));
--> statement-breakpoint

-- State changes that are not plain column edits: re-check access inside, touch only the intended columns.
CREATE FUNCTION public.set_marketing_integration_enabled(p_tenant uuid, p_provider text, p_enabled boolean)
RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_status text;
BEGIN
  IF NOT public.has_module_access(p_tenant, 'settings', 'write') OR session_user = 'authenticator' THEN RETURN 'forbidden'; END IF;
  SELECT validation_status INTO v_status FROM public.marketing_integrations
    WHERE tenant_id = p_tenant AND provider_code = p_provider FOR UPDATE;
  IF NOT FOUND THEN RETURN 'not_configured'; END IF;
  IF p_enabled AND v_status <> 'valid' THEN RETURN 'not_valid'; END IF;
  UPDATE public.marketing_integrations SET enabled = p_enabled, updated_by = auth.uid(), updated_at = now()
    WHERE tenant_id = p_tenant AND provider_code = p_provider;
  RETURN 'ok';
END
$$;
--> statement-breakpoint
CREATE FUNCTION public.record_marketing_integration_validation(p_tenant uuid, p_provider text, p_ok boolean, p_error text)
RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  IF NOT public.has_module_access(p_tenant, 'settings', 'write') OR session_user = 'authenticator' THEN RETURN 'forbidden'; END IF;
  UPDATE public.marketing_integrations
    SET validation_status = CASE WHEN p_ok THEN 'valid' ELSE 'invalid' END,
        validated_at = CASE WHEN p_ok THEN now() ELSE NULL END,
        validation_error = CASE WHEN p_ok THEN NULL ELSE left(p_error, 200) END,
        enabled = CASE WHEN p_ok THEN enabled ELSE false END,
        updated_by = auth.uid(), updated_at = now()
    WHERE tenant_id = p_tenant AND provider_code = p_provider;
  IF NOT FOUND THEN RETURN 'not_configured'; END IF;
  RETURN 'ok';
END
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION public.set_marketing_integration_enabled(uuid, text, boolean),
  public.record_marketing_integration_validation(uuid, text, boolean, text) FROM public, anon;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION public.set_marketing_integration_enabled(uuid, text, boolean),
  public.record_marketing_integration_validation(uuid, text, boolean, text) TO authenticated;
