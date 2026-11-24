-- Custom migration: subscription billing (invoices, payments, refunds, webhook events) and the billing rules.
--
-- StoreForge bills its tenants per billing period: an invoice is issued for a subscription period, the tenant Owner pays it through
-- Razorpay (StoreForge's own Razorpay account, keys in the server environment), and a verified payment settles the invoice and extends
-- the subscription. Razorpay Subscriptions (automatic recurring charges) are NOT used; see docs/PLATFORM_BILLING.md.
--
--   * billing_settings: seller details printed on invoices, tax rate, due and grace days (one row).
--   * billing_invoices: immutable financial records (a trigger only lets status/paid/void fields change; nothing is ever deleted).
--     No foreign key to tenants: an invoice outlives a deleted tenant, so the tenant name is copied into it.
--   * billing_payments / billing_refunds: what was paid and returned, with the Razorpay ids (unique, so nothing is applied twice).
--   * billing_webhook_events: every authenticated Razorpay webhook once per event id.
--   * Settlement, renewals, refunds and webhook handling are SECURITY DEFINER functions: the webhook and the scheduler have no
--     signed-in user, so the rules live here and are refused on the REST path (session_user = 'authenticator').
--   * Platform Admins read everything; a tenant Owner reads only its own invoices, payments and refunds. Nobody writes the
--     tables directly except Platform Admins on billing_settings.

-- Tables -----------------------------------------------------------------------------------------------------------------------
CREATE TABLE "billing_settings" (
	"id" boolean PRIMARY KEY DEFAULT true NOT NULL,
	"legal_name" text DEFAULT 'StoreForge' NOT NULL,
	"address" text,
	"gstin" text,
	"tax_label" text DEFAULT 'GST' NOT NULL,
	"tax_rate_bps" integer DEFAULT 0 NOT NULL,
	"due_days" integer DEFAULT 7 NOT NULL,
	"grace_days" integer DEFAULT 7 NOT NULL,
	"renewal_notice_days" integer DEFAULT 7 NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" uuid,
	CONSTRAINT "billing_settings_singleton_check" CHECK ("id"),
	CONSTRAINT "billing_settings_legal_name_check" CHECK (char_length(btrim("legal_name")) between 2 and 120),
	CONSTRAINT "billing_settings_address_check" CHECK ("address" is null or char_length("address") <= 300),
	CONSTRAINT "billing_settings_gstin_check" CHECK ("gstin" is null or "gstin" ~ '^[0-9A-Z]{15}$'),
	CONSTRAINT "billing_settings_tax_label_check" CHECK (char_length(btrim("tax_label")) between 1 and 20),
	CONSTRAINT "billing_settings_tax_rate_check" CHECK ("tax_rate_bps" between 0 and 10000),
	CONSTRAINT "billing_settings_days_check" CHECK ("due_days" between 0 and 90 and "grace_days" between 0 and 90 and "renewal_notice_days" between 0 and 60)
);
--> statement-breakpoint
INSERT INTO "billing_settings" ("id") VALUES (true);
--> statement-breakpoint

CREATE TABLE "billing_invoice_counters" (
	"year" integer PRIMARY KEY NOT NULL,
	"last_number" integer NOT NULL,
	CONSTRAINT "billing_invoice_counters_check" CHECK ("last_number" >= 0)
);
--> statement-breakpoint

CREATE TABLE "billing_invoices" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"number" text NOT NULL,
	"tenant_id" uuid NOT NULL,
	"tenant_name" text NOT NULL,
	"subscription_id" uuid,
	"plan_code" text NOT NULL,
	"plan_name" text NOT NULL,
	"billing_interval" text NOT NULL,
	"description" text NOT NULL,
	"period_start" timestamp with time zone NOT NULL,
	"period_end" timestamp with time zone NOT NULL,
	"currency" text NOT NULL,
	"subtotal_minor" bigint NOT NULL,
	"tax_rate_bps" integer NOT NULL,
	"tax_minor" bigint NOT NULL,
	"total_minor" bigint NOT NULL,
	"seller" jsonb NOT NULL,
	"status" text DEFAULT 'open' NOT NULL,
	"issued_at" timestamp with time zone DEFAULT now() NOT NULL,
	"due_at" timestamp with time zone NOT NULL,
	"paid_at" timestamp with time zone,
	"voided_at" timestamp with time zone,
	"void_reason" text,
	"created_by" uuid,
	CONSTRAINT "billing_invoices_status_check" CHECK ("status" in ('open', 'paid', 'void')),
	CONSTRAINT "billing_invoices_interval_check" CHECK ("billing_interval" in ('monthly', 'yearly')),
	CONSTRAINT "billing_invoices_currency_check" CHECK ("currency" ~ '^[A-Z]{3}$'),
	CONSTRAINT "billing_invoices_amounts_check" CHECK ("subtotal_minor" >= 0 and "tax_minor" >= 0 and "total_minor" = "subtotal_minor" + "tax_minor" and "tax_rate_bps" between 0 and 10000),
	CONSTRAINT "billing_invoices_period_check" CHECK ("period_end" > "period_start"),
	CONSTRAINT "billing_invoices_state_check" CHECK (("status" = 'paid') = ("paid_at" is not null) and ("status" = 'void') = ("voided_at" is not null))
);
--> statement-breakpoint
CREATE UNIQUE INDEX "billing_invoices_number_key" ON "billing_invoices" USING btree ("number");
--> statement-breakpoint
-- One live invoice per tenant and period start: the renewal job and a manual issue can never both bill the same period.
CREATE UNIQUE INDEX "billing_invoices_period_key" ON "billing_invoices" USING btree ("tenant_id", "period_start") WHERE "status" <> 'void';
--> statement-breakpoint
CREATE INDEX "billing_invoices_tenant_idx" ON "billing_invoices" USING btree ("tenant_id", "issued_at" DESC);
--> statement-breakpoint
CREATE INDEX "billing_invoices_status_due_idx" ON "billing_invoices" USING btree ("status", "due_at");
--> statement-breakpoint

CREATE TABLE "billing_payments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"invoice_id" uuid NOT NULL,
	"tenant_id" uuid NOT NULL,
	"provider" text NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"amount_minor" bigint NOT NULL,
	"currency" text NOT NULL,
	"razorpay_order_id" text,
	"razorpay_payment_id" text,
	"method" text,
	"reference" text,
	"note" text,
	"failure_code" text,
	"failure_description" text,
	"refund_required" boolean DEFAULT false NOT NULL,
	"refunded_minor" bigint DEFAULT 0 NOT NULL,
	"captured_at" timestamp with time zone,
	"recorded_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "billing_payments_invoice_id_fkey" FOREIGN KEY ("invoice_id") REFERENCES "billing_invoices"("id") ON DELETE RESTRICT,
	CONSTRAINT "billing_payments_provider_check" CHECK ("provider" in ('razorpay', 'manual')),
	CONSTRAINT "billing_payments_status_check" CHECK ("status" in ('pending', 'succeeded', 'failed', 'refunded', 'partially_refunded')),
	CONSTRAINT "billing_payments_amount_check" CHECK ("amount_minor" > 0 and "refunded_minor" between 0 and "amount_minor"),
	CONSTRAINT "billing_payments_currency_check" CHECK ("currency" ~ '^[A-Z]{3}$'),
	CONSTRAINT "billing_payments_reference_check" CHECK ("reference" is null or char_length("reference") <= 120),
	CONSTRAINT "billing_payments_note_check" CHECK ("note" is null or char_length("note") <= 300)
);
--> statement-breakpoint
CREATE UNIQUE INDEX "billing_payments_order_key" ON "billing_payments" USING btree ("razorpay_order_id") WHERE "razorpay_order_id" IS NOT NULL;
--> statement-breakpoint
CREATE UNIQUE INDEX "billing_payments_payment_key" ON "billing_payments" USING btree ("razorpay_payment_id") WHERE "razorpay_payment_id" IS NOT NULL;
--> statement-breakpoint
CREATE INDEX "billing_payments_tenant_idx" ON "billing_payments" USING btree ("tenant_id", "created_at" DESC);
--> statement-breakpoint
CREATE INDEX "billing_payments_invoice_idx" ON "billing_payments" USING btree ("invoice_id");
--> statement-breakpoint
CREATE INDEX "billing_payments_status_idx" ON "billing_payments" USING btree ("status", "created_at" DESC);
--> statement-breakpoint

CREATE TABLE "billing_refunds" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"payment_id" uuid NOT NULL,
	"tenant_id" uuid NOT NULL,
	"amount_minor" bigint NOT NULL,
	"currency" text NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"reason" text,
	"idempotency_key" text NOT NULL,
	"razorpay_refund_id" text,
	"failure_reason" text,
	"requested_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"processed_at" timestamp with time zone,
	CONSTRAINT "billing_refunds_payment_id_fkey" FOREIGN KEY ("payment_id") REFERENCES "billing_payments"("id") ON DELETE RESTRICT,
	CONSTRAINT "billing_refunds_status_check" CHECK ("status" in ('pending', 'processed', 'failed')),
	CONSTRAINT "billing_refunds_amount_check" CHECK ("amount_minor" > 0),
	CONSTRAINT "billing_refunds_reason_check" CHECK ("reason" is null or char_length("reason") <= 300),
	CONSTRAINT "billing_refunds_failure_check" CHECK ("failure_reason" is null or char_length("failure_reason") <= 300)
);
--> statement-breakpoint
CREATE UNIQUE INDEX "billing_refunds_key" ON "billing_refunds" USING btree ("payment_id", "idempotency_key");
--> statement-breakpoint
CREATE UNIQUE INDEX "billing_refunds_razorpay_key" ON "billing_refunds" USING btree ("razorpay_refund_id") WHERE "razorpay_refund_id" IS NOT NULL;
--> statement-breakpoint
CREATE INDEX "billing_refunds_tenant_idx" ON "billing_refunds" USING btree ("tenant_id", "created_at" DESC);
--> statement-breakpoint

CREATE TABLE "billing_webhook_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"event_id" text NOT NULL,
	"event_type" text NOT NULL,
	"razorpay_order_id" text,
	"razorpay_payment_id" text,
	"razorpay_refund_id" text,
	"status" text DEFAULT 'received' NOT NULL,
	"note" text,
	"attempts" integer DEFAULT 1 NOT NULL,
	"received_at" timestamp with time zone DEFAULT now() NOT NULL,
	"processed_at" timestamp with time zone,
	CONSTRAINT "billing_webhook_events_status_check" CHECK ("status" in ('received', 'processed', 'ignored', 'failed')),
	CONSTRAINT "billing_webhook_events_note_check" CHECK ("note" is null or char_length("note") <= 300)
);
--> statement-breakpoint
CREATE UNIQUE INDEX "billing_webhook_events_event_key" ON "billing_webhook_events" USING btree ("event_id");
--> statement-breakpoint
CREATE INDEX "billing_webhook_events_received_idx" ON "billing_webhook_events" USING btree ("received_at" DESC);
--> statement-breakpoint

CREATE TRIGGER billing_settings_set_updated_at BEFORE UPDATE ON public.billing_settings FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();
--> statement-breakpoint
CREATE TRIGGER billing_payments_set_updated_at BEFORE UPDATE ON public.billing_payments FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();
--> statement-breakpoint
CREATE TRIGGER billing_refunds_set_updated_at BEFORE UPDATE ON public.billing_refunds FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();
--> statement-breakpoint

-- Invoices are financial records: only the state fields may change, and nothing is ever deleted.
CREATE FUNCTION public.billing_invoices_guard()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = ''
AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'invoice_immutable' USING errcode = '42501';
  END IF;
  IF (NEW.id, NEW.number, NEW.tenant_id, NEW.tenant_name, NEW.subscription_id, NEW.plan_code, NEW.plan_name, NEW.billing_interval,
      NEW.description, NEW.period_start, NEW.period_end, NEW.currency, NEW.subtotal_minor, NEW.tax_rate_bps, NEW.tax_minor,
      NEW.total_minor, NEW.seller, NEW.issued_at, NEW.due_at, NEW.created_by)
     IS DISTINCT FROM
     (OLD.id, OLD.number, OLD.tenant_id, OLD.tenant_name, OLD.subscription_id, OLD.plan_code, OLD.plan_name, OLD.billing_interval,
      OLD.description, OLD.period_start, OLD.period_end, OLD.currency, OLD.subtotal_minor, OLD.tax_rate_bps, OLD.tax_minor,
      OLD.total_minor, OLD.seller, OLD.issued_at, OLD.due_at, OLD.created_by) THEN
    RAISE EXCEPTION 'invoice_immutable' USING errcode = '42501';
  END IF;
  IF OLD.status IN ('paid', 'void') AND NEW.status IS DISTINCT FROM OLD.status THEN
    RAISE EXCEPTION 'invoice_state_final' USING errcode = '42501';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER billing_invoices_guard BEFORE UPDATE OR DELETE ON public.billing_invoices FOR EACH ROW EXECUTE FUNCTION public.billing_invoices_guard();
--> statement-breakpoint

-- Access ---------------------------------------------------------------------------------------------------------------------
ALTER TABLE "billing_settings" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "billing_invoice_counters" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "billing_invoices" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "billing_payments" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "billing_refunds" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "billing_webhook_events" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
REVOKE ALL ON public.billing_settings, public.billing_invoice_counters, public.billing_invoices, public.billing_payments,
  public.billing_refunds, public.billing_webhook_events FROM public, anon, authenticated;
--> statement-breakpoint
GRANT SELECT, UPDATE ON public.billing_settings TO authenticated;
--> statement-breakpoint
GRANT SELECT ON public.billing_invoices, public.billing_payments, public.billing_refunds, public.billing_webhook_events TO authenticated;
--> statement-breakpoint
CREATE POLICY billing_settings_platform_admin ON public.billing_settings FOR ALL TO authenticated
  USING (public.is_platform_admin()) WITH CHECK (public.is_platform_admin());
--> statement-breakpoint
CREATE POLICY billing_invoices_read ON public.billing_invoices FOR SELECT TO authenticated
  USING (public.is_platform_admin() OR public.has_tenant_role(tenant_id, ARRAY['owner']));
--> statement-breakpoint
CREATE POLICY billing_payments_read ON public.billing_payments FOR SELECT TO authenticated
  USING (public.is_platform_admin() OR public.has_tenant_role(tenant_id, ARRAY['owner']));
--> statement-breakpoint
CREATE POLICY billing_refunds_read ON public.billing_refunds FOR SELECT TO authenticated
  USING (public.is_platform_admin() OR public.has_tenant_role(tenant_id, ARRAY['owner']));
--> statement-breakpoint
CREATE POLICY billing_webhook_events_read ON public.billing_webhook_events FOR SELECT TO authenticated
  USING (public.is_platform_admin());
--> statement-breakpoint

-- Internal rules (no grants) ---------------------------------------------------------------------------------------------------
CREATE FUNCTION public.billing_next_invoice_number()
RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_year integer := extract(year FROM now() AT TIME ZONE 'utc')::integer;
  v_n integer;
BEGIN
  -- The counter row is locked by the upsert, so numbers are gapless: a rolled-back invoice gives its number back.
  INSERT INTO public.billing_invoice_counters (year, last_number) VALUES (v_year, 1)
  ON CONFLICT (year) DO UPDATE SET last_number = public.billing_invoice_counters.last_number + 1
  RETURNING last_number INTO v_n;
  RETURN 'SF-' || v_year || '-' || lpad(v_n::text, 6, '0');
END;
$$;
--> statement-breakpoint

-- Issues the invoice for the subscription period that starts at p_period_start. Amounts come from the plan the tenant is on now.
CREATE FUNCTION public.billing_issue_invoice_internal(p_subscription uuid, p_period_start timestamptz, p_actor uuid)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  s public.tenant_subscriptions%ROWTYPE;
  p public.plans%ROWTYPE;
  st public.billing_settings%ROWTYPE;
  v_name text;
  v_price bigint;
  v_tax bigint;
  v_end timestamptz;
  v_due timestamptz;
  v_id uuid;
BEGIN
  SELECT * INTO s FROM public.tenant_subscriptions WHERE id = p_subscription FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'not_found'; END IF;
  SELECT * INTO p FROM public.plans WHERE id = s.plan_id;
  SELECT * INTO st FROM public.billing_settings;
  SELECT t.name INTO v_name FROM public.tenants t WHERE t.id = s.tenant_id;
  v_price := CASE WHEN s.billing_interval = 'yearly' THEN p.yearly_price_minor ELSE p.monthly_price_minor END;
  IF v_price <= 0 THEN RAISE EXCEPTION 'nothing_to_bill'; END IF;
  IF EXISTS (SELECT 1 FROM public.billing_invoices i WHERE i.tenant_id = s.tenant_id AND i.period_start = p_period_start AND i.status <> 'void') THEN
    RAISE EXCEPTION 'invoice_exists';
  END IF;
  v_end := p_period_start + CASE WHEN s.billing_interval = 'yearly' THEN interval '1 year' ELSE interval '1 month' END;
  v_tax := round(v_price::numeric * st.tax_rate_bps / 10000)::bigint;
  v_due := CASE WHEN p_period_start > now() THEN p_period_start ELSE now() + make_interval(days => st.due_days) END;
  INSERT INTO public.billing_invoices
    (number, tenant_id, tenant_name, subscription_id, plan_code, plan_name, billing_interval, description, period_start, period_end,
     currency, subtotal_minor, tax_rate_bps, tax_minor, total_minor, seller, due_at, created_by)
  VALUES
    (public.billing_next_invoice_number(), s.tenant_id, v_name, s.id, p.code, p.name, s.billing_interval,
     p.name || ' plan, ' || s.billing_interval || ' subscription', p_period_start, v_end,
     p.currency, v_price, st.tax_rate_bps, v_tax, v_price + v_tax,
     jsonb_build_object('legalName', st.legal_name, 'address', st.address, 'gstin', st.gstin, 'taxLabel', st.tax_label),
     v_due, p_actor)
  RETURNING id INTO v_id;
  RETURN v_id;
END;
$$;
--> statement-breakpoint

-- Marks an open invoice paid and extends the subscription. A payment that arrives for an invoice that is already paid or void is kept
-- but flagged refund_required, so money is never silently lost or double counted.
CREATE FUNCTION public.billing_settle_invoice(p_invoice uuid, p_payment uuid)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  i public.billing_invoices%ROWTYPE;
BEGIN
  SELECT * INTO i FROM public.billing_invoices WHERE id = p_invoice FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'not_found'; END IF;
  IF i.status <> 'open' THEN
    UPDATE public.billing_payments SET refund_required = true WHERE id = p_payment;
    RETURN false;
  END IF;
  UPDATE public.billing_invoices SET status = 'paid', paid_at = now() WHERE id = p_invoice;
  UPDATE public.tenant_subscriptions s SET
    status = 'active',
    trial_ends_at = NULL,
    current_period_start = CASE WHEN s.current_period_end IS NULL OR s.current_period_end < i.period_end THEN i.period_start ELSE s.current_period_start END,
    current_period_end = greatest(coalesce(s.current_period_end, i.period_end), i.period_end)
  WHERE s.tenant_id = i.tenant_id AND s.status <> 'canceled';
  RETURN true;
END;
$$;
--> statement-breakpoint

CREATE FUNCTION public.billing_refund_processed(p_refund uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_payment uuid;
  v_total bigint;
  v_amount bigint;
BEGIN
  UPDATE public.billing_refunds SET status = 'processed', processed_at = coalesce(processed_at, now()), failure_reason = NULL
  WHERE id = p_refund RETURNING payment_id INTO v_payment;
  SELECT coalesce(sum(r.amount_minor), 0) INTO v_total FROM public.billing_refunds r WHERE r.payment_id = v_payment AND r.status = 'processed';
  SELECT amount_minor INTO v_amount FROM public.billing_payments WHERE id = v_payment;
  UPDATE public.billing_payments SET
    refunded_minor = least(v_total, v_amount),
    status = CASE WHEN v_total >= v_amount THEN 'refunded' ELSE 'partially_refunded' END
  WHERE id = v_payment AND status IN ('succeeded', 'partially_refunded', 'refunded');
END;
$$;
--> statement-breakpoint

-- Renewals, overdue tracking and expiry for ALL tenants. Idempotent: running it twice does nothing the second time.
CREATE FUNCTION public.billing_process_renewals()
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  st public.billing_settings%ROWTYPE;
  r record;
  v_issued integer := 0;
  v_past_due integer := 0;
  v_expired integer := 0;
BEGIN
  SELECT * INTO st FROM public.billing_settings;
  FOR r IN
    SELECT s.id, s.current_period_end
    FROM public.tenant_subscriptions s
    JOIN public.plans p ON p.id = s.plan_id
    JOIN public.tenants t ON t.id = s.tenant_id
    WHERE s.status IN ('active', 'trialing') AND NOT s.cancel_at_period_end AND s.current_period_end IS NOT NULL
      AND s.current_period_end <= now() + make_interval(days => st.renewal_notice_days)
      AND t.status = 'active'
      AND (CASE WHEN s.billing_interval = 'yearly' THEN p.yearly_price_minor ELSE p.monthly_price_minor END) > 0
      AND NOT EXISTS (SELECT 1 FROM public.billing_invoices i WHERE i.tenant_id = s.tenant_id AND i.period_start = s.current_period_end AND i.status <> 'void')
  LOOP
    PERFORM public.billing_issue_invoice_internal(r.id, r.current_period_end, NULL);
    v_issued := v_issued + 1;
  END LOOP;

  WITH moved AS (
    UPDATE public.tenant_subscriptions s SET status = 'past_due'
    WHERE s.status = 'active'
      AND EXISTS (SELECT 1 FROM public.billing_invoices i WHERE i.tenant_id = s.tenant_id AND i.status = 'open' AND i.due_at < now())
    RETURNING 1)
  SELECT count(*) INTO v_past_due FROM moved;

  WITH moved AS (
    UPDATE public.tenant_subscriptions s SET status = 'expired'
    WHERE s.status IN ('past_due', 'trialing')
      AND EXISTS (SELECT 1 FROM public.billing_invoices i WHERE i.tenant_id = s.tenant_id AND i.status = 'open'
                  AND i.due_at < now() - make_interval(days => st.grace_days))
    RETURNING 1)
  SELECT count(*) INTO v_expired FROM moved;

  RETURN jsonb_build_object('invoicesIssued', v_issued, 'markedPastDue', v_past_due, 'expired', v_expired);
END;
$$;
--> statement-breakpoint

-- Platform Admin actions ------------------------------------------------------------------------------------------------------
CREATE FUNCTION public.platform_issue_invoice(p_tenant uuid, p_period text)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  s public.tenant_subscriptions%ROWTYPE;
  v_start timestamptz;
BEGIN
  IF NOT public.is_platform_admin() THEN
    RAISE EXCEPTION 'not_platform_admin' USING errcode = '42501';
  END IF;
  IF p_period IS NULL OR p_period NOT IN ('current', 'next') THEN RAISE EXCEPTION 'invalid_input'; END IF;
  SELECT * INTO s FROM public.tenant_subscriptions WHERE tenant_id = p_tenant;
  IF NOT FOUND THEN RAISE EXCEPTION 'not_found'; END IF;
  v_start := CASE WHEN p_period = 'current' THEN s.current_period_start ELSE s.current_period_end END;
  IF v_start IS NULL THEN RAISE EXCEPTION 'nothing_to_bill'; END IF;
  RETURN public.billing_issue_invoice_internal(s.id, v_start, (SELECT auth.uid()));
END;
$$;
--> statement-breakpoint

CREATE FUNCTION public.platform_void_invoice(p_invoice uuid, p_reason text)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_status text;
BEGIN
  IF NOT public.is_platform_admin() THEN
    RAISE EXCEPTION 'not_platform_admin' USING errcode = '42501';
  END IF;
  IF p_reason IS NULL OR char_length(btrim(p_reason)) NOT BETWEEN 3 AND 300 THEN RAISE EXCEPTION 'invalid_input'; END IF;
  SELECT status INTO v_status FROM public.billing_invoices WHERE id = p_invoice FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'not_found'; END IF;
  IF v_status <> 'open' THEN RAISE EXCEPTION 'invoice_not_open'; END IF;
  UPDATE public.billing_invoices SET status = 'void', voided_at = now(), void_reason = btrim(p_reason) WHERE id = p_invoice;
END;
$$;
--> statement-breakpoint

CREATE FUNCTION public.platform_record_manual_payment(p_invoice uuid, p_reference text, p_method text, p_note text)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  i public.billing_invoices%ROWTYPE;
  v_id uuid;
BEGIN
  IF NOT public.is_platform_admin() THEN
    RAISE EXCEPTION 'not_platform_admin' USING errcode = '42501';
  END IF;
  IF p_reference IS NULL OR char_length(btrim(p_reference)) NOT BETWEEN 2 AND 120
     OR p_method IS NULL OR char_length(btrim(p_method)) NOT BETWEEN 2 AND 40
     OR (p_note IS NOT NULL AND char_length(p_note) > 300) THEN
    RAISE EXCEPTION 'invalid_input';
  END IF;
  SELECT * INTO i FROM public.billing_invoices WHERE id = p_invoice FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'not_found'; END IF;
  IF i.status <> 'open' THEN RAISE EXCEPTION 'invoice_not_open'; END IF;
  INSERT INTO public.billing_payments
    (invoice_id, tenant_id, provider, status, amount_minor, currency, method, reference, note, captured_at, recorded_by)
  VALUES (i.id, i.tenant_id, 'manual', 'succeeded', i.total_minor, i.currency, btrim(p_method), btrim(p_reference), nullif(btrim(p_note), ''), now(), (SELECT auth.uid()))
  RETURNING id INTO v_id;
  PERFORM public.billing_settle_invoice(i.id, v_id);
  RETURN v_id;
END;
$$;
--> statement-breakpoint

-- Step 1 of a refund: reserve it (pending) so the same request cannot refund twice. Step 2 is the call to Razorpay, step 3 the finish.
CREATE FUNCTION public.platform_refund_begin(p_payment uuid, p_amount bigint, p_reason text, p_key text)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  pay public.billing_payments%ROWTYPE;
  r public.billing_refunds%ROWTYPE;
  v_pending bigint;
  v_id uuid;
BEGIN
  IF NOT public.is_platform_admin() THEN
    RAISE EXCEPTION 'not_platform_admin' USING errcode = '42501';
  END IF;
  IF p_key IS NULL OR char_length(btrim(p_key)) NOT BETWEEN 8 AND 100
     OR p_reason IS NULL OR char_length(btrim(p_reason)) NOT BETWEEN 3 AND 300 THEN
    RAISE EXCEPTION 'invalid_input';
  END IF;
  SELECT * INTO pay FROM public.billing_payments WHERE id = p_payment FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'not_found'; END IF;
  SELECT * INTO r FROM public.billing_refunds WHERE payment_id = p_payment AND idempotency_key = btrim(p_key);
  IF FOUND THEN
    RETURN jsonb_build_object('refundId', r.id, 'created', false, 'status', r.status, 'provider', pay.provider,
      'razorpayPaymentId', pay.razorpay_payment_id, 'amountMinor', r.amount_minor, 'currency', r.currency);
  END IF;
  IF pay.status NOT IN ('succeeded', 'partially_refunded') THEN RAISE EXCEPTION 'payment_not_refundable'; END IF;
  SELECT coalesce(sum(x.amount_minor), 0) INTO v_pending FROM public.billing_refunds x WHERE x.payment_id = p_payment AND x.status = 'pending';
  IF p_amount IS NULL OR p_amount < 1 OR p_amount > pay.amount_minor - pay.refunded_minor - v_pending THEN
    RAISE EXCEPTION 'invalid_refund_amount';
  END IF;
  INSERT INTO public.billing_refunds (payment_id, tenant_id, amount_minor, currency, reason, idempotency_key, requested_by)
  VALUES (p_payment, pay.tenant_id, p_amount, pay.currency, btrim(p_reason), btrim(p_key), (SELECT auth.uid()))
  RETURNING id INTO v_id;
  RETURN jsonb_build_object('refundId', v_id, 'created', true, 'status', 'pending', 'provider', pay.provider,
    'razorpayPaymentId', pay.razorpay_payment_id, 'amountMinor', p_amount, 'currency', pay.currency);
END;
$$;
--> statement-breakpoint

CREATE FUNCTION public.platform_refund_finish(p_refund uuid, p_razorpay_refund_id text, p_status text, p_failure text)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  r public.billing_refunds%ROWTYPE;
BEGIN
  IF NOT public.is_platform_admin() THEN
    RAISE EXCEPTION 'not_platform_admin' USING errcode = '42501';
  END IF;
  IF p_status IS NULL OR p_status NOT IN ('pending', 'processed', 'failed') THEN RAISE EXCEPTION 'invalid_input'; END IF;
  SELECT * INTO r FROM public.billing_refunds WHERE id = p_refund FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'not_found'; END IF;
  IF r.status = 'processed' THEN RETURN; END IF;
  UPDATE public.billing_refunds SET
    razorpay_refund_id = coalesce(p_razorpay_refund_id, razorpay_refund_id),
    status = CASE WHEN p_status = 'processed' THEN status ELSE p_status END,
    failure_reason = CASE WHEN p_status = 'failed' THEN left(p_failure, 300) ELSE NULL END
  WHERE id = p_refund;
  IF p_status = 'processed' THEN PERFORM public.billing_refund_processed(p_refund); END IF;
END;
$$;
--> statement-breakpoint

-- Tenant Owner: start paying an invoice -------------------------------------------------------------------------------------------
-- Returns what the API needs to create (or reuse) a Razorpay order. Only the tenant Owner of an OPEN invoice can ask.
CREATE FUNCTION public.billing_prepare_payment(p_invoice uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  i public.billing_invoices%ROWTYPE;
  pay public.billing_payments%ROWTYPE;
BEGIN
  IF session_user = 'authenticator' THEN RAISE EXCEPTION 'forbidden' USING errcode = '42501'; END IF;
  SELECT * INTO i FROM public.billing_invoices WHERE id = p_invoice;
  IF NOT FOUND OR NOT public.has_tenant_role(i.tenant_id, ARRAY['owner']) THEN RAISE EXCEPTION 'not_found'; END IF;
  IF i.status <> 'open' THEN RAISE EXCEPTION 'invoice_not_open'; END IF;
  SELECT * INTO pay FROM public.billing_payments
   WHERE invoice_id = i.id AND provider = 'razorpay' AND status = 'pending' AND amount_minor = i.total_minor
     AND created_at > now() - interval '12 hours'
   ORDER BY created_at DESC LIMIT 1;
  RETURN jsonb_build_object('invoiceId', i.id, 'number', i.number, 'tenantId', i.tenant_id, 'amountMinor', i.total_minor,
    'currency', i.currency, 'existingOrderId', pay.razorpay_order_id);
END;
$$;
--> statement-breakpoint

CREATE FUNCTION public.billing_attach_order(p_invoice uuid, p_order_id text, p_amount bigint, p_currency text)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  i public.billing_invoices%ROWTYPE;
  v_id uuid;
BEGIN
  IF session_user = 'authenticator' THEN RAISE EXCEPTION 'forbidden' USING errcode = '42501'; END IF;
  SELECT * INTO i FROM public.billing_invoices WHERE id = p_invoice;
  IF NOT FOUND OR NOT public.has_tenant_role(i.tenant_id, ARRAY['owner']) THEN RAISE EXCEPTION 'not_found'; END IF;
  IF i.status <> 'open' THEN RAISE EXCEPTION 'invoice_not_open'; END IF;
  IF p_amount IS DISTINCT FROM i.total_minor OR p_currency IS DISTINCT FROM i.currency THEN RAISE EXCEPTION 'amount_mismatch'; END IF;
  INSERT INTO public.billing_payments (invoice_id, tenant_id, provider, status, amount_minor, currency, razorpay_order_id)
  VALUES (i.id, i.tenant_id, 'razorpay', 'pending', i.total_minor, i.currency, p_order_id)
  ON CONFLICT (razorpay_order_id) WHERE razorpay_order_id IS NOT NULL DO UPDATE SET updated_at = now()
  RETURNING id INTO v_id;
  RETURN v_id;
END;
$$;
--> statement-breakpoint

-- Applying what Razorpay reports (webhook, or the Owner's verified checkout) ---------------------------------------------------------
-- The CALLER has already authenticated the event (webhook signature, or checkout signature plus a lookup at Razorpay). Idempotent.
-- A signed-in caller must be the Owner of the payment's tenant; the webhook has no user. Refused over REST either way.
CREATE FUNCTION public.billing_apply_payment(
  p_order text, p_payment_id text, p_amount bigint, p_currency text, p_method text, p_outcome text, p_fail_code text, p_fail_desc text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  pay public.billing_payments%ROWTYPE;
  v_settled boolean;
BEGIN
  IF session_user = 'authenticator' THEN RAISE EXCEPTION 'forbidden' USING errcode = '42501'; END IF;
  IF p_outcome IS NULL OR p_outcome NOT IN ('captured', 'failed') THEN RAISE EXCEPTION 'invalid_input'; END IF;
  SELECT * INTO pay FROM public.billing_payments WHERE razorpay_order_id = p_order FOR UPDATE;
  IF NOT FOUND THEN RETURN jsonb_build_object('result', 'unknown_order'); END IF;
  IF (SELECT auth.uid()) IS NOT NULL AND NOT public.has_tenant_role(pay.tenant_id, ARRAY['owner']) THEN
    RAISE EXCEPTION 'forbidden' USING errcode = '42501';
  END IF;

  IF pay.status IN ('succeeded', 'partially_refunded', 'refunded') THEN
    RETURN jsonb_build_object('result', 'duplicate', 'tenantId', pay.tenant_id, 'invoiceId', pay.invoice_id);
  END IF;

  IF p_outcome = 'captured' THEN
    IF p_amount IS DISTINCT FROM pay.amount_minor OR p_currency IS DISTINCT FROM pay.currency THEN
      RAISE EXCEPTION 'amount_mismatch';
    END IF;
    UPDATE public.billing_payments SET status = 'succeeded', razorpay_payment_id = p_payment_id, method = p_method,
      captured_at = now(), failure_code = NULL, failure_description = NULL WHERE id = pay.id;
    v_settled := public.billing_settle_invoice(pay.invoice_id, pay.id);
    RETURN jsonb_build_object('result', 'captured', 'settled', v_settled, 'tenantId', pay.tenant_id, 'invoiceId', pay.invoice_id);
  END IF;

  UPDATE public.billing_payments SET status = 'failed', razorpay_payment_id = coalesce(razorpay_payment_id, p_payment_id), method = coalesce(p_method, method),
    failure_code = left(p_fail_code, 100), failure_description = left(p_fail_desc, 300) WHERE id = pay.id;
  RETURN jsonb_build_object('result', 'failed', 'tenantId', pay.tenant_id, 'invoiceId', pay.invoice_id);
END;
$$;
--> statement-breakpoint

CREATE FUNCTION public.billing_apply_refund_event(p_payment_id text, p_refund_id text, p_amount bigint, p_status text, p_receipt text)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  pay public.billing_payments%ROWTYPE;
  r public.billing_refunds%ROWTYPE;
BEGIN
  IF session_user = 'authenticator' OR (SELECT auth.uid()) IS NOT NULL THEN RAISE EXCEPTION 'forbidden' USING errcode = '42501'; END IF;
  IF p_status IS NULL OR p_status NOT IN ('pending', 'processed', 'failed') THEN RAISE EXCEPTION 'invalid_input'; END IF;
  SELECT * INTO pay FROM public.billing_payments WHERE razorpay_payment_id = p_payment_id FOR UPDATE;
  IF NOT FOUND THEN RETURN jsonb_build_object('result', 'unknown_payment'); END IF;

  SELECT * INTO r FROM public.billing_refunds WHERE razorpay_refund_id = p_refund_id;
  IF NOT FOUND AND p_receipt ~ '^[0-9a-f-]{36}$' THEN
    SELECT * INTO r FROM public.billing_refunds WHERE id = p_receipt::uuid AND payment_id = pay.id;
  END IF;
  IF NOT FOUND THEN
    -- A refund made in the Razorpay dashboard: record it so the books agree.
    INSERT INTO public.billing_refunds (payment_id, tenant_id, amount_minor, currency, status, reason, idempotency_key, razorpay_refund_id)
    VALUES (pay.id, pay.tenant_id, p_amount, pay.currency, p_status, 'Made in the Razorpay dashboard', 'rzp:' || p_refund_id, p_refund_id)
    RETURNING * INTO r;
  ELSE
    UPDATE public.billing_refunds SET razorpay_refund_id = coalesce(razorpay_refund_id, p_refund_id) WHERE id = r.id;
  END IF;
  IF p_status = 'processed' THEN
    PERFORM public.billing_refund_processed(r.id);
  ELSIF p_status = 'failed' AND r.status = 'pending' THEN
    UPDATE public.billing_refunds SET status = 'failed', failure_reason = 'Razorpay could not complete the refund' WHERE id = r.id;
  END IF;
  RETURN jsonb_build_object('result', p_status, 'tenantId', pay.tenant_id);
END;
$$;
--> statement-breakpoint

-- Webhook de-duplication: 'new' (first time), 'retry' (an earlier attempt did not finish), 'duplicate' (already handled).
CREATE FUNCTION public.billing_log_webhook(p_event_id text, p_type text, p_order text, p_payment text, p_refund text)
RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  e public.billing_webhook_events%ROWTYPE;
BEGIN
  IF session_user = 'authenticator' OR (SELECT auth.uid()) IS NOT NULL THEN RAISE EXCEPTION 'forbidden' USING errcode = '42501'; END IF;
  INSERT INTO public.billing_webhook_events (event_id, event_type, razorpay_order_id, razorpay_payment_id, razorpay_refund_id)
  VALUES (left(p_event_id, 200), left(p_type, 100), p_order, p_payment, p_refund)
  ON CONFLICT (event_id) DO NOTHING;
  IF FOUND THEN RETURN 'new'; END IF;
  SELECT * INTO e FROM public.billing_webhook_events WHERE event_id = left(p_event_id, 200) FOR UPDATE;
  IF e.status IN ('processed', 'ignored') THEN RETURN 'duplicate'; END IF;
  UPDATE public.billing_webhook_events SET attempts = attempts + 1 WHERE id = e.id;
  RETURN 'retry';
END;
$$;
--> statement-breakpoint

CREATE FUNCTION public.billing_finish_webhook(p_event_id text, p_status text, p_note text)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  IF session_user = 'authenticator' OR (SELECT auth.uid()) IS NOT NULL THEN RAISE EXCEPTION 'forbidden' USING errcode = '42501'; END IF;
  IF p_status NOT IN ('processed', 'ignored', 'failed') THEN RAISE EXCEPTION 'invalid_input'; END IF;
  UPDATE public.billing_webhook_events SET status = p_status, note = left(p_note, 300),
    processed_at = CASE WHEN p_status = 'failed' THEN NULL ELSE now() END
  WHERE event_id = left(p_event_id, 200);
END;
$$;
--> statement-breakpoint

-- Scheduled and manual runs -------------------------------------------------------------------------------------------------------------
CREATE FUNCTION public.billing_run_scheduled()
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  IF session_user = 'authenticator' OR (SELECT auth.uid()) IS NOT NULL THEN RAISE EXCEPTION 'forbidden' USING errcode = '42501'; END IF;
  RETURN public.billing_process_renewals();
END;
$$;
--> statement-breakpoint

CREATE FUNCTION public.platform_run_billing()
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  IF NOT public.is_platform_admin() THEN
    RAISE EXCEPTION 'not_platform_admin' USING errcode = '42501';
  END IF;
  RETURN public.billing_process_renewals();
END;
$$;
--> statement-breakpoint

-- Grants: internal functions to nobody; the rest to the request role (each one checks who is asking).
REVOKE ALL ON FUNCTION public.billing_next_invoice_number() FROM public, anon, authenticated;
--> statement-breakpoint
REVOKE ALL ON FUNCTION public.billing_issue_invoice_internal(uuid, timestamptz, uuid) FROM public, anon, authenticated;
--> statement-breakpoint
REVOKE ALL ON FUNCTION public.billing_settle_invoice(uuid, uuid) FROM public, anon, authenticated;
--> statement-breakpoint
REVOKE ALL ON FUNCTION public.billing_refund_processed(uuid) FROM public, anon, authenticated;
--> statement-breakpoint
REVOKE ALL ON FUNCTION public.billing_process_renewals() FROM public, anon, authenticated;
--> statement-breakpoint
REVOKE ALL ON FUNCTION public.billing_invoices_guard() FROM public, anon, authenticated;
--> statement-breakpoint
REVOKE ALL ON FUNCTION public.platform_issue_invoice(uuid, text) FROM public, anon;
--> statement-breakpoint
REVOKE ALL ON FUNCTION public.platform_void_invoice(uuid, text) FROM public, anon;
--> statement-breakpoint
REVOKE ALL ON FUNCTION public.platform_record_manual_payment(uuid, text, text, text) FROM public, anon;
--> statement-breakpoint
REVOKE ALL ON FUNCTION public.platform_refund_begin(uuid, bigint, text, text) FROM public, anon;
--> statement-breakpoint
REVOKE ALL ON FUNCTION public.platform_refund_finish(uuid, text, text, text) FROM public, anon;
--> statement-breakpoint
REVOKE ALL ON FUNCTION public.platform_run_billing() FROM public, anon;
--> statement-breakpoint
REVOKE ALL ON FUNCTION public.billing_prepare_payment(uuid) FROM public, anon;
--> statement-breakpoint
REVOKE ALL ON FUNCTION public.billing_attach_order(uuid, text, bigint, text) FROM public, anon;
--> statement-breakpoint
REVOKE ALL ON FUNCTION public.billing_apply_payment(text, text, bigint, text, text, text, text, text) FROM public, anon;
--> statement-breakpoint
REVOKE ALL ON FUNCTION public.billing_apply_refund_event(text, text, bigint, text, text) FROM public, anon;
--> statement-breakpoint
REVOKE ALL ON FUNCTION public.billing_log_webhook(text, text, text, text, text) FROM public, anon;
--> statement-breakpoint
REVOKE ALL ON FUNCTION public.billing_finish_webhook(text, text, text) FROM public, anon;
--> statement-breakpoint
REVOKE ALL ON FUNCTION public.billing_run_scheduled() FROM public, anon;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION public.platform_issue_invoice(uuid, text) TO authenticated;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION public.platform_void_invoice(uuid, text) TO authenticated;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION public.platform_record_manual_payment(uuid, text, text, text) TO authenticated;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION public.platform_refund_begin(uuid, bigint, text, text) TO authenticated;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION public.platform_refund_finish(uuid, text, text, text) TO authenticated;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION public.platform_run_billing() TO authenticated;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION public.billing_prepare_payment(uuid) TO authenticated;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION public.billing_attach_order(uuid, text, bigint, text) TO authenticated;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION public.billing_apply_payment(text, text, bigint, text, text, text, text, text) TO authenticated;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION public.billing_apply_refund_event(text, text, bigint, text, text) TO authenticated;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION public.billing_log_webhook(text, text, text, text, text) TO authenticated;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION public.billing_finish_webhook(text, text, text) TO authenticated;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION public.billing_run_scheduled() TO authenticated;
--> statement-breakpoint

-- The audit log accepts billing entities.
ALTER TABLE "admin_audit_logs" DROP CONSTRAINT "admin_audit_logs_entity_type_check";
--> statement-breakpoint
ALTER TABLE "admin_audit_logs" ADD CONSTRAINT "admin_audit_logs_entity_type_check" CHECK ("entity_type" in ('organization', 'store', 'team_member', 'platform_admin', 'support_note', 'platform_settings', 'plan', 'subscription', 'entitlement', 'invoice', 'payment', 'billing_settings'));
