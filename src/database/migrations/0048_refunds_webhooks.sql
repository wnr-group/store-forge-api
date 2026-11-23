-- Custom migration: refunds, Razorpay webhook events and the payment reconciliation lookup.
--
-- refunds: one row per refund request. A row is inserted as 'pending' BEFORE Razorpay is called, under a lock on the payment
-- transaction, together with the "refunded so far" check, so two requests can never refund more than was captured. Our own row id
-- is sent to Razorpay as the refund `receipt`, which lets an unclear outcome (timeout) be reconciled by looking the refund up
-- instead of sending it twice. Refunds made directly in the Razorpay dashboard are recorded from their webhook.
-- payment_webhook_events: every authenticated webhook is stored once per (tenant, Razorpay event id), which makes redelivery
-- harmless.

CREATE TABLE "refunds" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "tenant_id" uuid NOT NULL REFERENCES "tenants"("id") ON DELETE CASCADE,
  "order_id" uuid NOT NULL,
  "payment_transaction_id" uuid NOT NULL,
  "amount_minor" bigint NOT NULL,
  "currency" text NOT NULL,
  "status" text NOT NULL DEFAULT 'pending',
  "reason" text,
  "source" text NOT NULL DEFAULT 'storeforge',
  "idempotency_key" text NOT NULL,
  "razorpay_refund_id" text,
  "failure_reason" text,
  "requested_by" uuid,
  "created_at" timestamp with time zone NOT NULL DEFAULT now(),
  "updated_at" timestamp with time zone NOT NULL DEFAULT now(),
  "processed_at" timestamp with time zone,
  CONSTRAINT "refunds_order_fk" FOREIGN KEY ("tenant_id", "order_id") REFERENCES "orders"("tenant_id", "id") ON DELETE CASCADE,
  CONSTRAINT "refunds_transaction_fk" FOREIGN KEY ("tenant_id", "payment_transaction_id") REFERENCES "payment_transactions"("tenant_id", "id") ON DELETE CASCADE,
  CONSTRAINT "refunds_tenant_id_id_key" UNIQUE ("tenant_id", "id"),
  CONSTRAINT "refunds_tenant_idempotency_key" UNIQUE ("tenant_id", "idempotency_key"),
  CONSTRAINT "refunds_amount_check" CHECK ("amount_minor" > 0),
  CONSTRAINT "refunds_currency_check" CHECK ("currency" ~ '^[A-Z]{3}$'),
  CONSTRAINT "refunds_status_check" CHECK ("status" IN ('pending', 'processing', 'processed', 'failed')),
  CONSTRAINT "refunds_source_check" CHECK ("source" IN ('storeforge', 'razorpay_dashboard')),
  CONSTRAINT "refunds_processed_check" CHECK (("status" = 'processed') = ("processed_at" IS NOT NULL)),
  CONSTRAINT "refunds_text_check" CHECK (
    ("reason" IS NULL OR char_length("reason") <= 500) AND ("failure_reason" IS NULL OR char_length("failure_reason") <= 500)
    AND char_length("idempotency_key") BETWEEN 8 AND 128)
);
--> statement-breakpoint
CREATE UNIQUE INDEX "refunds_razorpay_refund_key" ON "refunds" ("tenant_id", "razorpay_refund_id") WHERE "razorpay_refund_id" IS NOT NULL;
--> statement-breakpoint
CREATE INDEX "refunds_transaction_idx" ON "refunds" ("payment_transaction_id");
--> statement-breakpoint
CREATE INDEX "refunds_tenant_created_idx" ON "refunds" ("tenant_id", "created_at" DESC);
--> statement-breakpoint
CREATE INDEX "refunds_open_idx" ON "refunds" ("updated_at") WHERE "status" IN ('pending', 'processing');
--> statement-breakpoint
ALTER TABLE "refunds" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
REVOKE ALL ON "refunds" FROM public, anon, authenticated;
--> statement-breakpoint
GRANT SELECT ON "refunds" TO authenticated;
--> statement-breakpoint
CREATE POLICY refunds_select_owner ON public.refunds FOR SELECT TO authenticated
  USING (public.has_tenant_role(tenant_id, ARRAY['owner']) AND session_user <> 'authenticator');
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON "refunds" TO storeforge_checkout;
--> statement-breakpoint
CREATE POLICY refunds_checkout_pinned ON public.refunds FOR ALL TO storeforge_checkout
  USING (tenant_id = public.pinned_tenant_id()) WITH CHECK (tenant_id = public.pinned_tenant_id());
--> statement-breakpoint

CREATE TABLE "payment_webhook_events" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "tenant_id" uuid NOT NULL REFERENCES "tenants"("id") ON DELETE CASCADE,
  "event_id" text NOT NULL,
  "event_type" text NOT NULL,
  "razorpay_order_id" text,
  "razorpay_payment_id" text,
  "razorpay_refund_id" text,
  "status" text NOT NULL DEFAULT 'received',
  "note" text,
  "attempts" integer NOT NULL DEFAULT 1,
  "received_at" timestamp with time zone NOT NULL DEFAULT now(),
  "processed_at" timestamp with time zone,
  CONSTRAINT "payment_webhook_events_tenant_event_key" UNIQUE ("tenant_id", "event_id"),
  CONSTRAINT "payment_webhook_events_status_check" CHECK ("status" IN ('received', 'processed', 'ignored', 'failed')),
  CONSTRAINT "payment_webhook_events_text_check" CHECK (char_length("event_id") BETWEEN 1 AND 200 AND char_length("event_type") BETWEEN 1 AND 100
    AND ("note" IS NULL OR char_length("note") <= 500))
);
--> statement-breakpoint
CREATE INDEX "payment_webhook_events_order_idx" ON "payment_webhook_events" ("tenant_id", "razorpay_order_id");
--> statement-breakpoint
CREATE INDEX "payment_webhook_events_received_idx" ON "payment_webhook_events" ("tenant_id", "received_at" DESC);
--> statement-breakpoint
ALTER TABLE "payment_webhook_events" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
REVOKE ALL ON "payment_webhook_events" FROM public, anon, authenticated;
--> statement-breakpoint
GRANT SELECT ON "payment_webhook_events" TO authenticated;
--> statement-breakpoint
CREATE POLICY payment_webhook_events_select_owner ON public.payment_webhook_events FOR SELECT TO authenticated
  USING (public.has_tenant_role(tenant_id, ARRAY['owner']) AND session_user <> 'authenticator');
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON "payment_webhook_events" TO storeforge_checkout;
--> statement-breakpoint
CREATE POLICY payment_webhook_events_checkout_pinned ON public.payment_webhook_events FOR ALL TO storeforge_checkout
  USING (tenant_id = public.pinned_tenant_id()) WITH CHECK (tenant_id = public.pinned_tenant_id());
--> statement-breakpoint

-- Tenants with online payments or refunds that have been waiting for an answer for a while (reconciliation job).
CREATE FUNCTION public.tenants_needing_payment_reconciliation(p_limit integer)
RETURNS SETOF uuid
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
  SELECT tenant_id FROM (
    SELECT t.tenant_id FROM public.payment_transactions t
    WHERE t.provider = 'razorpay' AND t.status IN ('created', 'authorized', 'failed')
      AND t.updated_at < now() - interval '10 minutes' AND t.created_at > now() - interval '3 days'
    UNION
    SELECT r.tenant_id FROM public.refunds r
    WHERE r.status IN ('pending', 'processing') AND r.updated_at < now() - interval '10 minutes'
  ) x
  LIMIT greatest(1, least(coalesce(p_limit, 50), 200))
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION public.tenants_needing_payment_reconciliation(integer) FROM public, anon, authenticated;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION public.tenants_needing_payment_reconciliation(integer) TO storeforge_checkout;
