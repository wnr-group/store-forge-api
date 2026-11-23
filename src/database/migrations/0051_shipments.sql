-- Custom migration: shipments, what each one carries, its tracking history and its label.
--
-- A shipment is a parcel booked with one of the tenant's own carriers for some (or all) of an order's items. Rows are written
-- only by the API, through the tenant-pinned `storeforge_checkout` role, because creating one talks to an outside carrier and
-- moves the order along; signed-in dashboard users can READ them when they have `orders` read access.
--
-- A shipment row is saved as `creating` BEFORE the carrier is called, so a crash or a lost answer can never leave a booked
-- parcel the system does not know about: the row says what was attempted, `provider_order_id`/`provider_shipment_id` record how
-- far the carrier got, and a retry resumes instead of booking twice. Only one `creating` row can exist per order at a time.

CREATE TABLE "shipments" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "tenant_id" uuid NOT NULL REFERENCES "tenants"("id") ON DELETE CASCADE,
  "order_id" uuid NOT NULL,
  "provider_code" text NOT NULL,
  "status" text NOT NULL DEFAULT 'creating',
  "service_code" text,
  "courier_name" text,
  "awb" text,
  "provider_order_id" text,
  "provider_shipment_id" text,
  "tracking_url" text,
  "estimated_delivery" timestamp with time zone,
  "payment_mode" text NOT NULL,
  "cod_amount_minor" bigint NOT NULL DEFAULT 0,
  "declared_value_minor" bigint NOT NULL DEFAULT 0,
  "weight_grams" integer NOT NULL,
  "length_cm" integer,
  "breadth_cm" integer,
  "height_cm" integer,
  "label_url" text,
  "has_label" boolean NOT NULL DEFAULT false,
  "failure_reason" text,
  "attempts" integer NOT NULL DEFAULT 0,
  "last_synced_at" timestamp with time zone,
  "picked_up_at" timestamp with time zone,
  "delivered_at" timestamp with time zone,
  "cancelled_at" timestamp with time zone,
  "created_by" uuid,
  "created_at" timestamp with time zone NOT NULL DEFAULT now(),
  "updated_at" timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT "shipments_tenant_id_id_key" UNIQUE ("tenant_id", "id"),
  CONSTRAINT "shipments_order_fk" FOREIGN KEY ("tenant_id", "order_id") REFERENCES "orders"("tenant_id", "id") ON DELETE CASCADE,
  CONSTRAINT "shipments_status_check" CHECK ("status" IN ('creating', 'created', 'picked_up', 'in_transit', 'out_for_delivery', 'undelivered', 'returning', 'delivered', 'returned', 'cancelled', 'failed')),
  CONSTRAINT "shipments_payment_mode_check" CHECK ("payment_mode" IN ('prepaid', 'cod')),
  CONSTRAINT "shipments_amounts_check" CHECK ("cod_amount_minor" >= 0 AND "declared_value_minor" >= 0 AND ("payment_mode" = 'cod' OR "cod_amount_minor" = 0)),
  CONSTRAINT "shipments_weight_check" CHECK ("weight_grams" BETWEEN 1 AND 1000000),
  CONSTRAINT "shipments_dimensions_check" CHECK (
    ("length_cm" IS NULL AND "breadth_cm" IS NULL AND "height_cm" IS NULL)
    OR ("length_cm" BETWEEN 1 AND 500 AND "breadth_cm" BETWEEN 1 AND 500 AND "height_cm" BETWEEN 1 AND 500)),
  -- Once a carrier has accepted the parcel the shipment has its waybill number; one never booked (or cancelled before) may not.
  CONSTRAINT "shipments_awb_check" CHECK ("status" IN ('creating', 'failed', 'cancelled') OR "awb" IS NOT NULL),
  CONSTRAINT "shipments_provider_code_check" CHECK ("provider_code" ~ '^[a-z][a-z0-9_]{1,31}$')
);
--> statement-breakpoint
-- A waybill number identifies one parcel of one carrier account; it cannot be recorded twice for the same tenant and carrier.
CREATE UNIQUE INDEX "shipments_tenant_awb_key" ON "shipments" ("tenant_id", "provider_code", "awb") WHERE "awb" IS NOT NULL;
--> statement-breakpoint
-- Only one booking attempt per order at a time: two people pressing "create shipment" cannot both book.
CREATE UNIQUE INDEX "shipments_one_creating_per_order" ON "shipments" ("tenant_id", "order_id") WHERE "status" = 'creating';
--> statement-breakpoint
CREATE INDEX "shipments_order_idx" ON "shipments" ("tenant_id", "order_id");
--> statement-breakpoint
CREATE INDEX "shipments_tenant_status_idx" ON "shipments" ("tenant_id", "status", "created_at" DESC);
--> statement-breakpoint
-- What the tracking sync and the carrier webhooks look for.
CREATE INDEX "shipments_open_sync_idx" ON "shipments" ("last_synced_at" NULLS FIRST) WHERE "status" IN ('created', 'picked_up', 'in_transit', 'out_for_delivery', 'undelivered', 'returning') AND "awb" IS NOT NULL;
--> statement-breakpoint
CREATE INDEX "shipments_provider_awb_idx" ON "shipments" ("provider_code", "awb") WHERE "awb" IS NOT NULL;
--> statement-breakpoint

CREATE TABLE "shipment_items" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "tenant_id" uuid NOT NULL REFERENCES "tenants"("id") ON DELETE CASCADE,
  "shipment_id" uuid NOT NULL,
  "order_item_id" uuid NOT NULL,
  "quantity" integer NOT NULL,
  CONSTRAINT "shipment_items_shipment_fk" FOREIGN KEY ("tenant_id", "shipment_id") REFERENCES "shipments"("tenant_id", "id") ON DELETE CASCADE,
  CONSTRAINT "shipment_items_quantity_check" CHECK ("quantity" > 0),
  CONSTRAINT "shipment_items_shipment_item_key" UNIQUE ("shipment_id", "order_item_id")
);
--> statement-breakpoint
CREATE INDEX "shipment_items_order_item_idx" ON "shipment_items" ("order_item_id");
--> statement-breakpoint

CREATE TABLE "shipment_events" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "tenant_id" uuid NOT NULL REFERENCES "tenants"("id") ON DELETE CASCADE,
  "shipment_id" uuid NOT NULL,
  -- A fingerprint of the event (when, what, where), so seeing the same carrier update twice records it once.
  "event_key" text NOT NULL,
  "status" text NOT NULL,
  "description" text NOT NULL,
  "location" text,
  "occurred_at" timestamp with time zone,
  "source" text NOT NULL,
  "created_at" timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT "shipment_events_shipment_fk" FOREIGN KEY ("tenant_id", "shipment_id") REFERENCES "shipments"("tenant_id", "id") ON DELETE CASCADE,
  CONSTRAINT "shipment_events_key_key" UNIQUE ("shipment_id", "event_key"),
  CONSTRAINT "shipment_events_source_check" CHECK ("source" IN ('system', 'carrier_api', 'carrier_webhook', 'owner')),
  CONSTRAINT "shipment_events_text_check" CHECK (char_length("description") <= 500 AND ("location" IS NULL OR char_length("location") <= 200))
);
--> statement-breakpoint
CREATE INDEX "shipment_events_shipment_idx" ON "shipment_events" ("shipment_id", "occurred_at" DESC NULLS LAST, "created_at" DESC);
--> statement-breakpoint

-- Label PDFs a carrier handed back as bytes. Served only through the API (after the permission check): no signed-in role reads it.
CREATE TABLE "shipment_labels" (
  "shipment_id" uuid PRIMARY KEY,
  "tenant_id" uuid NOT NULL REFERENCES "tenants"("id") ON DELETE CASCADE,
  "content" bytea NOT NULL,
  "created_at" timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT "shipment_labels_shipment_fk" FOREIGN KEY ("tenant_id", "shipment_id") REFERENCES "shipments"("tenant_id", "id") ON DELETE CASCADE,
  CONSTRAINT "shipment_labels_size_check" CHECK (octet_length("content") BETWEEN 1 AND 5242880)
);
--> statement-breakpoint

ALTER TABLE "shipments" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "shipment_items" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "shipment_events" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "shipment_labels" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint

-- Dashboard users read shipments with `orders` read access; nobody signed in writes them.
GRANT SELECT ON "shipments", "shipment_items", "shipment_events" TO authenticated;
--> statement-breakpoint
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['shipments', 'shipment_items', 'shipment_events'] LOOP
    EXECUTE format('CREATE POLICY %I ON public.%I FOR SELECT TO authenticated USING (public.has_module_access(tenant_id, ''orders'', ''read'') AND session_user <> ''authenticator'')', t || '_select', t);
    EXECUTE format('CREATE POLICY %I ON public.%I FOR ALL TO storeforge_checkout USING (tenant_id = public.pinned_tenant_id()) WITH CHECK (tenant_id = public.pinned_tenant_id())', t || '_checkout_pinned', t);
  END LOOP;
END $$;
--> statement-breakpoint
CREATE POLICY shipment_labels_checkout_pinned ON public.shipment_labels FOR ALL TO storeforge_checkout
  USING (tenant_id = public.pinned_tenant_id()) WITH CHECK (tenant_id = public.pinned_tenant_id());
--> statement-breakpoint
-- Shipments are never deleted by the application (history matters); labels may be replaced.
GRANT SELECT, INSERT, UPDATE ON "shipments", "shipment_items" TO storeforge_checkout;
--> statement-breakpoint
GRANT SELECT, INSERT ON "shipment_events" TO storeforge_checkout;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON "shipment_labels" TO storeforge_checkout;
--> statement-breakpoint

-- Which shipments (of any tenant) does a carrier's webhook talk about? A webhook arrives without a signed-in user or a tenant, so
-- it can only be matched by the carrier's own waybill number. Returns identifiers only and is callable by the checkout role alone.
CREATE FUNCTION public.shipments_for_carrier_webhook(p_provider text, p_awbs text[])
RETURNS TABLE (tenant_id uuid, shipment_id uuid)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
  SELECT s.tenant_id, s.id FROM public.shipments s
  WHERE s.provider_code = p_provider AND s.awb = ANY (p_awbs)
    AND s.status IN ('created', 'picked_up', 'in_transit', 'out_for_delivery', 'undelivered', 'returning')
  LIMIT 20;
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION public.shipments_for_carrier_webhook(text, text[]) FROM public, anon, authenticated;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION public.shipments_for_carrier_webhook(text, text[]) TO storeforge_checkout;
--> statement-breakpoint

-- Tenants with parcels on the road whose tracking has not been refreshed lately (the scheduled sync's work list).
CREATE FUNCTION public.tenants_needing_shipment_sync(p_limit integer, p_stale_minutes integer)
RETURNS SETOF uuid
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
  SELECT s.tenant_id FROM public.shipments s
  WHERE s.status IN ('created', 'picked_up', 'in_transit', 'out_for_delivery', 'undelivered', 'returning')
    AND s.awb IS NOT NULL
    AND (s.last_synced_at IS NULL OR s.last_synced_at < now() - make_interval(mins => p_stale_minutes))
  GROUP BY s.tenant_id
  ORDER BY min(coalesce(s.last_synced_at, 'epoch'::timestamptz))
  LIMIT p_limit;
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION public.tenants_needing_shipment_sync(integer, integer) FROM public, anon, authenticated;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION public.tenants_needing_shipment_sync(integer, integer) TO storeforge_checkout;
