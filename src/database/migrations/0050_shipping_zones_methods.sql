-- Custom migration: shipping zones, methods, rates, the shipping origin, product weights and the shipping snapshot on orders.
--
-- Zones group destinations. A zone holds AREAS of five kinds, from most to least specific: a single PIN code, a PIN code range, a
-- city (within a state), a state, or the whole country. A destination belongs to the zone holding its most specific matching
-- area. Ambiguity cannot exist: the same area cannot be in two zones (unique indexes below), and overlapping PIN ranges are
-- refused by the API under a per-tenant lock, so there is always at most one winner.
-- Methods belong to a zone and price shipping one of five ways: flat, free, by weight tiers, by order value tiers, or from a live
-- carrier quote. Tiers must cover the whole range (the API enforces: start at 0, contiguous, last one open-ended).
-- Settings readers/writers: the same `settings` module access that guards the store settings (Owner always). The tenant-pinned
-- checkout role may only READ these tables, for its own tenant.

ALTER TABLE "products" ADD COLUMN "weight_grams" integer NOT NULL DEFAULT 0,
  ADD CONSTRAINT "products_weight_check" CHECK ("weight_grams" BETWEEN 0 AND 1000000);
--> statement-breakpoint
-- Product edits are granted column by column (so tenant_id and id can never change): the new column joins that grant.
GRANT UPDATE ("weight_grams") ON public.products TO authenticated;
--> statement-breakpoint

CREATE TABLE "shipping_zones" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "tenant_id" uuid NOT NULL REFERENCES "tenants"("id") ON DELETE CASCADE,
  "name" text NOT NULL,
  "enabled" boolean NOT NULL DEFAULT true,
  "cod_allowed" boolean NOT NULL DEFAULT true,
  "created_at" timestamp with time zone NOT NULL DEFAULT now(),
  "updated_at" timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT "shipping_zones_tenant_id_id_key" UNIQUE ("tenant_id", "id"),
  CONSTRAINT "shipping_zones_tenant_name_key" UNIQUE ("tenant_id", "name"),
  CONSTRAINT "shipping_zones_name_check" CHECK (char_length(btrim("name")) BETWEEN 1 AND 80)
);
--> statement-breakpoint
CREATE TABLE "shipping_zone_areas" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "tenant_id" uuid NOT NULL REFERENCES "tenants"("id") ON DELETE CASCADE,
  "zone_id" uuid NOT NULL,
  "kind" text NOT NULL,
  "state_code" text,
  "city" text,
  "postal_code" text,
  "postal_from" text,
  "postal_to" text,
  CONSTRAINT "shipping_zone_areas_zone_fk" FOREIGN KEY ("tenant_id", "zone_id") REFERENCES "shipping_zones"("tenant_id", "id") ON DELETE CASCADE,
  CONSTRAINT "shipping_zone_areas_kind_check" CHECK (
    ("kind" = 'country' AND "state_code" IS NULL AND "city" IS NULL AND "postal_code" IS NULL AND "postal_from" IS NULL AND "postal_to" IS NULL)
    OR ("kind" = 'state' AND "state_code" ~ '^[0-9]{2}$' AND "city" IS NULL AND "postal_code" IS NULL AND "postal_from" IS NULL AND "postal_to" IS NULL)
    OR ("kind" = 'city' AND "state_code" ~ '^[0-9]{2}$' AND "city" IS NOT NULL AND char_length("city") BETWEEN 1 AND 100 AND "city" = lower(btrim("city"))
        AND "postal_code" IS NULL AND "postal_from" IS NULL AND "postal_to" IS NULL)
    OR ("kind" = 'postal_code' AND "postal_code" ~ '^[1-9][0-9]{5}$' AND "state_code" IS NULL AND "city" IS NULL AND "postal_from" IS NULL AND "postal_to" IS NULL)
    OR ("kind" = 'postal_range' AND "postal_from" ~ '^[1-9][0-9]{5}$' AND "postal_to" ~ '^[1-9][0-9]{5}$' AND "postal_from" <= "postal_to"
        AND "state_code" IS NULL AND "city" IS NULL AND "postal_code" IS NULL))
);
--> statement-breakpoint
-- The same area can live in only one zone of a tenant.
CREATE UNIQUE INDEX "shipping_zone_areas_country_key" ON "shipping_zone_areas" ("tenant_id") WHERE "kind" = 'country';
--> statement-breakpoint
CREATE UNIQUE INDEX "shipping_zone_areas_state_key" ON "shipping_zone_areas" ("tenant_id", "state_code") WHERE "kind" = 'state';
--> statement-breakpoint
CREATE UNIQUE INDEX "shipping_zone_areas_city_key" ON "shipping_zone_areas" ("tenant_id", "state_code", "city") WHERE "kind" = 'city';
--> statement-breakpoint
CREATE UNIQUE INDEX "shipping_zone_areas_postal_key" ON "shipping_zone_areas" ("tenant_id", "postal_code") WHERE "kind" = 'postal_code';
--> statement-breakpoint
CREATE INDEX "shipping_zone_areas_range_idx" ON "shipping_zone_areas" ("tenant_id", "postal_from", "postal_to") WHERE "kind" = 'postal_range';
--> statement-breakpoint
CREATE INDEX "shipping_zone_areas_zone_idx" ON "shipping_zone_areas" ("zone_id");
--> statement-breakpoint

CREATE TABLE "shipping_methods" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "tenant_id" uuid NOT NULL REFERENCES "tenants"("id") ON DELETE CASCADE,
  "zone_id" uuid NOT NULL,
  "name" text NOT NULL,
  "kind" text NOT NULL DEFAULT 'standard',
  "pricing_type" text NOT NULL,
  "flat_rate_minor" bigint NOT NULL DEFAULT 0,
  "free_over_minor" bigint,
  "handling_minor" bigint NOT NULL DEFAULT 0,
  "min_order_minor" bigint NOT NULL DEFAULT 0,
  "max_order_minor" bigint,
  "min_weight_grams" integer NOT NULL DEFAULT 0,
  "max_weight_grams" integer,
  "est_days_min" integer,
  "est_days_max" integer,
  "cod_allowed" boolean NOT NULL DEFAULT true,
  "carrier_code" text,
  "sort_order" integer NOT NULL DEFAULT 0,
  "enabled" boolean NOT NULL DEFAULT true,
  "created_at" timestamp with time zone NOT NULL DEFAULT now(),
  "updated_at" timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT "shipping_methods_zone_fk" FOREIGN KEY ("tenant_id", "zone_id") REFERENCES "shipping_zones"("tenant_id", "id") ON DELETE CASCADE,
  CONSTRAINT "shipping_methods_tenant_id_id_key" UNIQUE ("tenant_id", "id"),
  CONSTRAINT "shipping_methods_zone_name_key" UNIQUE ("zone_id", "name"),
  CONSTRAINT "shipping_methods_name_check" CHECK (char_length(btrim("name")) BETWEEN 1 AND 80),
  CONSTRAINT "shipping_methods_kind_check" CHECK ("kind" IN ('standard', 'express')),
  CONSTRAINT "shipping_methods_pricing_check" CHECK ("pricing_type" IN ('flat', 'free', 'weight', 'order_value', 'carrier')),
  CONSTRAINT "shipping_methods_money_check" CHECK ("flat_rate_minor" BETWEEN 0 AND 100000000000 AND "handling_minor" BETWEEN 0 AND 100000000000
    AND ("free_over_minor" IS NULL OR "free_over_minor" BETWEEN 0 AND 100000000000)),
  CONSTRAINT "shipping_methods_order_range_check" CHECK ("min_order_minor" >= 0 AND ("max_order_minor" IS NULL OR "max_order_minor" >= "min_order_minor")),
  CONSTRAINT "shipping_methods_weight_range_check" CHECK ("min_weight_grams" >= 0 AND ("max_weight_grams" IS NULL OR "max_weight_grams" >= "min_weight_grams")),
  CONSTRAINT "shipping_methods_days_check" CHECK (("est_days_min" IS NULL OR "est_days_min" BETWEEN 0 AND 120) AND ("est_days_max" IS NULL OR "est_days_max" BETWEEN 0 AND 120)
    AND ("est_days_min" IS NULL OR "est_days_max" IS NULL OR "est_days_min" <= "est_days_max")),
  CONSTRAINT "shipping_methods_carrier_check" CHECK ("carrier_code" IS NULL OR ("pricing_type" = 'carrier' AND "carrier_code" ~ '^[a-z][a-z0-9_]{1,30}$'))
);
--> statement-breakpoint
CREATE INDEX "shipping_methods_zone_idx" ON "shipping_methods" ("tenant_id", "zone_id", "sort_order");
--> statement-breakpoint

CREATE TABLE "shipping_rate_tiers" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "tenant_id" uuid NOT NULL REFERENCES "tenants"("id") ON DELETE CASCADE,
  "method_id" uuid NOT NULL,
  "from_value" bigint NOT NULL,
  "to_value" bigint,
  "rate_minor" bigint NOT NULL,
  CONSTRAINT "shipping_rate_tiers_method_fk" FOREIGN KEY ("tenant_id", "method_id") REFERENCES "shipping_methods"("tenant_id", "id") ON DELETE CASCADE,
  CONSTRAINT "shipping_rate_tiers_method_from_key" UNIQUE ("method_id", "from_value"),
  CONSTRAINT "shipping_rate_tiers_range_check" CHECK ("from_value" >= 0 AND ("to_value" IS NULL OR "to_value" > "from_value")),
  CONSTRAINT "shipping_rate_tiers_rate_check" CHECK ("rate_minor" BETWEEN 0 AND 100000000000)
);
--> statement-breakpoint

CREATE TABLE "tenant_shipping_origin" (
  "tenant_id" uuid PRIMARY KEY REFERENCES "tenants"("id") ON DELETE CASCADE,
  "name" text NOT NULL,
  "phone" text NOT NULL,
  "email" text,
  "line1" text NOT NULL,
  "line2" text,
  "city" text NOT NULL,
  "state" text NOT NULL,
  "state_code" text NOT NULL,
  "postal_code" text NOT NULL,
  "updated_at" timestamp with time zone NOT NULL DEFAULT now(),
  "updated_by" uuid REFERENCES auth.users("id") ON DELETE SET NULL,
  CONSTRAINT "tenant_shipping_origin_check" CHECK (char_length(btrim("name")) BETWEEN 1 AND 120 AND char_length("phone") BETWEEN 4 AND 32
    AND char_length(btrim("line1")) BETWEEN 1 AND 200 AND ("line2" IS NULL OR char_length("line2") <= 200) AND char_length(btrim("city")) BETWEEN 1 AND 100
    AND "state_code" ~ '^[0-9]{2}$' AND "postal_code" ~ '^[1-9][0-9]{5}$' AND ("email" IS NULL OR char_length("email") <= 254))
);
--> statement-breakpoint

-- Orders keep what shipping was chosen and priced, as it was.
ALTER TABLE "orders"
  ADD COLUMN "shipping_method_id" uuid,
  ADD COLUMN "shipping_method_name" text,
  ADD COLUMN "shipping_zone_name" text,
  ADD COLUMN "shipping_carrier_code" text,
  ADD COLUMN "shipping_service_code" text,
  ADD COLUMN "shipping_days_min" integer,
  ADD COLUMN "shipping_days_max" integer,
  ADD COLUMN "shipping_weight_grams" integer NOT NULL DEFAULT 0,
  ADD CONSTRAINT "orders_shipping_snapshot_check" CHECK (("shipping_method_name" IS NULL OR char_length("shipping_method_name") <= 80)
    AND "shipping_weight_grams" >= 0);
--> statement-breakpoint

-- Access ------------------------------------------------------------------------------------------------------------------
ALTER TABLE "shipping_zones" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "shipping_zone_areas" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "shipping_methods" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "shipping_rate_tiers" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "tenant_shipping_origin" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
REVOKE ALL ON "shipping_zones", "shipping_zone_areas", "shipping_methods", "shipping_rate_tiers", "tenant_shipping_origin" FROM public, anon, authenticated;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON "shipping_zones", "shipping_zone_areas", "shipping_methods", "shipping_rate_tiers" TO authenticated;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON "tenant_shipping_origin" TO authenticated;
--> statement-breakpoint

DO $pol$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['shipping_zones', 'shipping_zone_areas', 'shipping_methods', 'shipping_rate_tiers']
  LOOP
    EXECUTE format('CREATE POLICY %I ON public.%I FOR SELECT TO authenticated USING (public.has_module_access(tenant_id, ''settings'', ''read'') AND session_user <> ''authenticator'')', t || '_select', t);
    EXECUTE format('CREATE POLICY %I ON public.%I FOR INSERT TO authenticated WITH CHECK (public.has_module_access(tenant_id, ''settings'', ''write'') AND session_user <> ''authenticator'')', t || '_insert', t);
    EXECUTE format('CREATE POLICY %I ON public.%I FOR UPDATE TO authenticated USING (public.has_module_access(tenant_id, ''settings'', ''write'') AND session_user <> ''authenticator'') WITH CHECK (public.has_module_access(tenant_id, ''settings'', ''write'') AND session_user <> ''authenticator'')', t || '_update', t);
    EXECUTE format('CREATE POLICY %I ON public.%I FOR DELETE TO authenticated USING (public.has_module_access(tenant_id, ''settings'', ''write'') AND session_user <> ''authenticator'')', t || '_delete', t);
    EXECUTE format('GRANT SELECT ON public.%I TO storeforge_checkout', t);
    EXECUTE format('CREATE POLICY %I ON public.%I FOR SELECT TO storeforge_checkout USING (tenant_id = public.pinned_tenant_id())', t || '_checkout_pinned', t);
  END LOOP;
END
$pol$;
--> statement-breakpoint
CREATE POLICY tenant_shipping_origin_select ON public.tenant_shipping_origin FOR SELECT TO authenticated
  USING (public.has_module_access(tenant_id, 'settings', 'read') AND session_user <> 'authenticator');
--> statement-breakpoint
CREATE POLICY tenant_shipping_origin_insert ON public.tenant_shipping_origin FOR INSERT TO authenticated
  WITH CHECK (public.has_module_access(tenant_id, 'settings', 'write') AND session_user <> 'authenticator' AND updated_by = (SELECT auth.uid()));
--> statement-breakpoint
CREATE POLICY tenant_shipping_origin_update ON public.tenant_shipping_origin FOR UPDATE TO authenticated
  USING (public.has_module_access(tenant_id, 'settings', 'write') AND session_user <> 'authenticator')
  WITH CHECK (public.has_module_access(tenant_id, 'settings', 'write') AND session_user <> 'authenticator' AND updated_by = (SELECT auth.uid()));
--> statement-breakpoint
GRANT SELECT ON "tenant_shipping_origin" TO storeforge_checkout;
--> statement-breakpoint
CREATE POLICY tenant_shipping_origin_checkout_pinned ON public.tenant_shipping_origin FOR SELECT TO storeforge_checkout
  USING (tenant_id = public.pinned_tenant_id());
