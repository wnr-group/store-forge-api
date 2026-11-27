-- Custom migration: self-service sign-up (a customer buys a plan first, then creates their own store).
--
--   * signup_orders: the purchase record that exists BEFORE a tenant does. One row per attempt to buy a plan: who, which plan and
--     interval, the amounts agreed at that moment, the Razorpay order and payment, and (once the store exists) the tenant and the
--     invoice. It is the only thing that links a payment to a person while no organization exists yet.
--   * provision_tenant_internal(): the ONE routine that creates tenant + owner membership + store. platform_provision_tenant()
--     (Platform Admin) and signup_provision() (a customer who has paid) are both thin wrappers around it, so the two ways of creating a
--     tenant cannot drift apart. The Platform Admin function keeps its signature, grants and behaviour.
--   * signup_* functions hold the rules (price, payment settlement, idempotency, ownership) in the database, like the billing_* ones.
--     Nothing here trusts the browser: an order becomes `paid` only through signup_apply_payment(), which the API calls after it has
--     checked Razorpay's signature and asked Razorpay itself (or from Razorpay's signed webhook).
--   * Free plans (nothing to charge) become `paid` straight away, so the same store step follows.

-- The shared routine ---------------------------------------------------------------------------------------------------------------------
-- The body of platform_provision_tenant() with the "who is calling" check removed: callers authorise first. No grants: it is reachable only
-- from other SECURITY DEFINER functions.
CREATE FUNCTION public.provision_tenant_internal(
  p_owner_id           uuid,
  p_tenant_name        text,
  p_store_name         text,
  p_store_slug         text,
  p_store_description  text DEFAULT NULL,
  p_contact_phone      text DEFAULT NULL,
  p_address            text DEFAULT NULL,
  p_public_id          text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_tenant_name text := btrim(coalesce(p_tenant_name, ''));
  v_store_name  text := btrim(coalesce(p_store_name, ''));
  v_description text := nullif(btrim(coalesce(p_store_description, '')), '');
  v_phone       text := nullif(btrim(coalesce(p_contact_phone, '')), '');
  v_address     text := nullif(btrim(coalesce(p_address, '')), '');
  v_public_id   text := p_public_id;
  v_tenant_id   uuid;
  v_store_id    uuid;
  v_tenant_slug text;
  v_currency    text := 'INR';
  v_timezone    text := 'Asia/Kolkata';
  v_status      text := 'active';
  v_constraint  text;
BEGIN
  IF p_owner_id IS NULL OR NOT EXISTS (SELECT 1 FROM auth.users u WHERE u.id = p_owner_id) THEN
    RAISE EXCEPTION 'owner_not_found';
  END IF;

  IF char_length(v_tenant_name) NOT BETWEEN 2 AND 80
     OR char_length(v_store_name) NOT BETWEEN 2 AND 80
     OR char_length(coalesce(v_description, '')) > 500
     OR (v_phone IS NOT NULL AND char_length(v_phone) NOT BETWEEN 4 AND 32)
     OR char_length(coalesce(v_address, '')) > 300
     OR (v_public_id IS NOT NULL AND v_public_id !~ '^[a-z0-9]{5,8}$') THEN
    RAISE EXCEPTION 'invalid_input';
  END IF;

  IF NOT public.is_valid_store_slug(p_store_slug) THEN
    RAISE EXCEPTION 'invalid_slug';
  END IF;

  PERFORM pg_advisory_xact_lock(hashtextextended(p_owner_id::text, 42));

  -- Idempotent: the same owner asking for the same store address again gets the store they already have.
  SELECT t.id, s.id INTO v_tenant_id, v_store_id
  FROM public.stores s
  JOIN public.tenants t ON t.id = s.tenant_id
  JOIN public.memberships m ON m.tenant_id = t.id
  WHERE s.slug = p_store_slug AND m.user_id = p_owner_id AND m.role = 'owner';

  IF v_store_id IS NOT NULL THEN
    RETURN jsonb_build_object(
      'tenant_id', v_tenant_id, 'store_id', v_store_id,
      'store_slug', p_store_slug, 'created', false);
  END IF;

  IF EXISTS (SELECT 1 FROM public.stores s WHERE s.slug = p_store_slug) THEN
    RAISE EXCEPTION 'slug_taken';
  END IF;

  v_tenant_slug := p_store_slug;
  IF EXISTS (SELECT 1 FROM public.tenants t WHERE t.slug = v_tenant_slug) THEN
    v_tenant_slug := left(p_store_slug, 31) || '-' || substr(replace(gen_random_uuid()::text, '-', ''), 1, 6);
  END IF;

  -- No value supplied: generate one here, retrying until it is free.
  IF v_public_id IS NULL THEN
    LOOP
      v_public_id := public.generate_tenant_public_id();
      EXIT WHEN NOT EXISTS (SELECT 1 FROM public.tenants t WHERE t.public_id = v_public_id);
    END LOOP;
  ELSIF EXISTS (SELECT 1 FROM public.tenants t WHERE t.public_id = v_public_id) THEN
    RAISE EXCEPTION 'public_id_taken';
  END IF;

  SELECT s.default_currency, s.default_timezone, s.default_store_status INTO v_currency, v_timezone, v_status
  FROM public.platform_settings s;

  BEGIN
    INSERT INTO public.tenants (name, slug, public_id, contact_phone, address, created_by)
    VALUES (v_tenant_name, v_tenant_slug, v_public_id, v_phone, v_address, p_owner_id)
    RETURNING id INTO v_tenant_id;

    INSERT INTO public.memberships (tenant_id, user_id, role)
    VALUES (v_tenant_id, p_owner_id, 'owner');

    INSERT INTO public.stores (tenant_id, name, slug, description, contact_phone, currency, timezone, status)
    VALUES (v_tenant_id, v_store_name, p_store_slug, v_description, v_phone, v_currency, v_timezone, v_status)
    RETURNING id INTO v_store_id;
  EXCEPTION WHEN unique_violation THEN
    GET STACKED DIAGNOSTICS v_constraint = CONSTRAINT_NAME;
    IF v_constraint = 'tenants_public_id_key' THEN
      RAISE EXCEPTION 'public_id_taken';
    END IF;
    RAISE EXCEPTION 'slug_taken';
  END;

  RETURN jsonb_build_object(
    'tenant_id', v_tenant_id, 'store_id', v_store_id,
    'store_slug', p_store_slug, 'created', true);
END;
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION public.provision_tenant_internal(uuid, text, text, text, text, text, text, text) FROM public, anon, authenticated;
--> statement-breakpoint

-- Platform Admin tenant creation: same signature, grants and result as before; only the body now delegates.
CREATE OR REPLACE FUNCTION public.platform_provision_tenant(
  p_owner_id           uuid,
  p_tenant_name        text,
  p_store_name         text,
  p_store_slug         text,
  p_store_description  text DEFAULT NULL,
  p_contact_phone      text DEFAULT NULL,
  p_address            text DEFAULT NULL,
  p_public_id          text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  IF (SELECT auth.uid()) IS NULL OR NOT public.platform_role_in(ARRAY['super_admin', 'admin']) THEN
    RAISE EXCEPTION 'not_platform_admin' USING errcode = '42501';
  END IF;
  RETURN public.provision_tenant_internal(
    p_owner_id, p_tenant_name, p_store_name, p_store_slug, p_store_description, p_contact_phone, p_address, p_public_id);
END;
$$;
--> statement-breakpoint

-- Purchases ------------------------------------------------------------------------------------------------------------------------------
CREATE TABLE "signup_orders" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"plan_id" uuid NOT NULL,
	"billing_interval" text NOT NULL,
	"currency" text NOT NULL,
	"subtotal_minor" bigint NOT NULL,
	"tax_rate_bps" integer NOT NULL,
	"tax_minor" bigint NOT NULL,
	"total_minor" bigint NOT NULL,
	"status" text DEFAULT 'created' NOT NULL,
	"razorpay_order_id" text,
	"razorpay_payment_id" text,
	"payment_method" text,
	"last_failure_code" text,
	"last_failure_description" text,
	"refund_required" boolean DEFAULT false NOT NULL,
	"paid_at" timestamp with time zone,
	"tenant_id" uuid,
	"invoice_id" uuid,
	"provisioned_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "signup_orders_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "auth"."users"("id") ON DELETE CASCADE,
	CONSTRAINT "signup_orders_plan_id_fkey" FOREIGN KEY ("plan_id") REFERENCES "plans"("id") ON DELETE RESTRICT,
	CONSTRAINT "signup_orders_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE SET NULL,
	CONSTRAINT "signup_orders_invoice_id_fkey" FOREIGN KEY ("invoice_id") REFERENCES "billing_invoices"("id") ON DELETE SET NULL,
	CONSTRAINT "signup_orders_status_check" CHECK ("status" in ('created', 'paid', 'provisioned', 'canceled')),
	CONSTRAINT "signup_orders_interval_check" CHECK ("billing_interval" in ('monthly', 'yearly')),
	CONSTRAINT "signup_orders_currency_check" CHECK ("currency" ~ '^[A-Z]{3}$'),
	CONSTRAINT "signup_orders_amounts_check" CHECK ("subtotal_minor" >= 0 and "tax_minor" >= 0 and "total_minor" = "subtotal_minor" + "tax_minor" and "tax_rate_bps" between 0 and 10000),
	CONSTRAINT "signup_orders_paid_check" CHECK (("status" in ('paid', 'provisioned')) = ("paid_at" is not null) or "status" = 'canceled')
);
--> statement-breakpoint
CREATE UNIQUE INDEX "signup_orders_razorpay_order_key" ON "signup_orders" USING btree ("razorpay_order_id") WHERE "razorpay_order_id" IS NOT NULL;
--> statement-breakpoint
CREATE UNIQUE INDEX "signup_orders_razorpay_payment_key" ON "signup_orders" USING btree ("razorpay_payment_id") WHERE "razorpay_payment_id" IS NOT NULL;
--> statement-breakpoint
-- One purchase in progress per person: choosing another plan replaces the unpaid one, a paid one must be finished first.
CREATE UNIQUE INDEX "signup_orders_open_user_key" ON "signup_orders" USING btree ("user_id") WHERE "status" IN ('created', 'paid');
--> statement-breakpoint
CREATE INDEX "signup_orders_user_idx" ON "signup_orders" USING btree ("user_id", "created_at" DESC);
--> statement-breakpoint
CREATE TRIGGER signup_orders_set_updated_at BEFORE UPDATE ON public.signup_orders FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();
--> statement-breakpoint

-- Access: a person reads only their own purchases, staff who handle billing read all; every write goes through the functions below.
ALTER TABLE "signup_orders" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
REVOKE ALL ON public.signup_orders FROM public, anon, authenticated;
--> statement-breakpoint
GRANT SELECT ON public.signup_orders TO authenticated;
--> statement-breakpoint
CREATE POLICY signup_orders_read ON public.signup_orders FOR SELECT TO authenticated
  USING (user_id = (SELECT auth.uid()) OR public.platform_role_in(ARRAY['super_admin', 'admin', 'billing_admin']));
--> statement-breakpoint

-- Functions ------------------------------------------------------------------------------------------------------------------------------

-- Starts (or resumes) the purchase of a published plan for the signed-in person. Amounts are computed here from the plan and the current
-- tax settings, never taken from the browser. Resuming reuses the same order, so a retry after a failed payment needs no new account.
CREATE FUNCTION public.signup_prepare(p_plan_code text, p_interval text)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_uid uuid := (SELECT auth.uid());
  v_plan public.plans%ROWTYPE;
  st public.billing_settings%ROWTYPE;
  v_existing public.signup_orders%ROWTYPE;
  v_order public.signup_orders%ROWTYPE;
  v_price bigint;
  v_tax bigint;
  v_total bigint;
BEGIN
  IF session_user = 'authenticator' THEN RAISE EXCEPTION 'forbidden' USING errcode = '42501'; END IF;
  IF v_uid IS NULL THEN RAISE EXCEPTION 'not_authenticated' USING errcode = '28000'; END IF;
  IF p_interval IS NULL OR p_interval NOT IN ('monthly', 'yearly') THEN RAISE EXCEPTION 'invalid_input'; END IF;
  -- Platform staff can never own a store (a person is staff or a member, never both), so they must not be charged for one.
  IF EXISTS (SELECT 1 FROM public.platform_admins pa WHERE pa.user_id = v_uid) THEN
    RAISE EXCEPTION 'platform_admin_cannot_be_member' USING errcode = '42501';
  END IF;

  -- Only what the public site shows can be bought: active and not an internal / grandfathered plan.
  SELECT * INTO v_plan FROM public.plans p WHERE p.code = p_plan_code AND p.status = 'active' AND NOT p.is_unrestricted;
  IF NOT FOUND THEN RAISE EXCEPTION 'plan_not_found'; END IF;

  PERFORM pg_advisory_xact_lock(hashtextextended(v_uid::text, 43));

  SELECT * INTO st FROM public.billing_settings;
  v_price := CASE WHEN p_interval = 'yearly' THEN v_plan.yearly_price_minor ELSE v_plan.monthly_price_minor END;
  -- A paid plan with no price for the chosen period (say, no yearly price) is NOT free for that period: refuse it rather than give it away.
  IF v_price = 0 AND (v_plan.monthly_price_minor > 0 OR v_plan.yearly_price_minor > 0) THEN
    RAISE EXCEPTION 'interval_unavailable';
  END IF;
  v_tax := round(v_price::numeric * st.tax_rate_bps / 10000)::bigint;
  v_total := v_price + v_tax;

  SELECT * INTO v_existing FROM public.signup_orders o WHERE o.user_id = v_uid AND o.status IN ('created', 'paid') FOR UPDATE;
  IF FOUND THEN
    -- Already paid: nothing to buy again, the store step is next whatever plan was asked for.
    IF v_existing.status = 'paid' THEN
      v_order := v_existing;
    ELSIF v_existing.plan_id = v_plan.id AND v_existing.billing_interval = p_interval AND v_existing.total_minor = v_total
          AND v_existing.currency = v_plan.currency AND v_existing.created_at > now() - interval '12 hours' THEN
      v_order := v_existing;
    ELSE
      -- A different plan, a changed price or an old order: replace it. A payment that still arrives for the old Razorpay order is kept
      -- and flagged refund_required (signup_apply_payment), so money is never lost.
      UPDATE public.signup_orders SET status = 'canceled' WHERE id = v_existing.id;
    END IF;
  END IF;

  IF v_order.id IS NULL THEN
    INSERT INTO public.signup_orders
      (user_id, plan_id, billing_interval, currency, subtotal_minor, tax_rate_bps, tax_minor, total_minor, status, paid_at)
    VALUES
      (v_uid, v_plan.id, p_interval, v_plan.currency, v_price, st.tax_rate_bps, v_tax, v_total,
       CASE WHEN v_total = 0 THEN 'paid' ELSE 'created' END,
       CASE WHEN v_total = 0 THEN now() ELSE NULL END)
    RETURNING * INTO v_order;
  END IF;

  SELECT * INTO v_plan FROM public.plans p WHERE p.id = v_order.plan_id;
  RETURN jsonb_build_object(
    'signupId', v_order.id, 'status', v_order.status, 'planCode', v_plan.code, 'planName', v_plan.name,
    'billingInterval', v_order.billing_interval, 'currency', v_order.currency, 'subtotalMinor', v_order.subtotal_minor,
    'taxMinor', v_order.tax_minor, 'totalMinor', v_order.total_minor, 'existingOrderId', v_order.razorpay_order_id);
END;
$$;
--> statement-breakpoint

-- Records the Razorpay order created for a purchase. If another request attached one first, that one wins and is returned.
CREATE FUNCTION public.signup_attach_order(p_signup uuid, p_order_id text, p_amount bigint, p_currency text)
RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  o public.signup_orders%ROWTYPE;
BEGIN
  IF session_user = 'authenticator' THEN RAISE EXCEPTION 'forbidden' USING errcode = '42501'; END IF;
  SELECT * INTO o FROM public.signup_orders WHERE id = p_signup AND user_id = (SELECT auth.uid()) FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'not_found'; END IF;
  IF o.status <> 'created' THEN RAISE EXCEPTION 'order_not_open'; END IF;
  IF p_amount IS DISTINCT FROM o.total_minor OR p_currency IS DISTINCT FROM o.currency THEN RAISE EXCEPTION 'amount_mismatch'; END IF;
  IF o.razorpay_order_id IS NULL THEN
    UPDATE public.signup_orders SET razorpay_order_id = p_order_id WHERE id = o.id;
    RETURN p_order_id;
  END IF;
  RETURN o.razorpay_order_id;
END;
$$;
--> statement-breakpoint

-- Applies what Razorpay reports (the person's verified checkout, or the signed webhook). The CALLER has already authenticated the event.
-- Idempotent. A signed-in caller must own the purchase; the webhook has no user. Refused over REST either way.
--   captured -> the order becomes paid (once). The same payment again is a 'duplicate'. A second, different payment for an order that is
--               already paid, or any payment for a replaced order, is kept and flagged refund_required.
--   failed   -> only remembered; the order stays open so the same person can pay again.
CREATE FUNCTION public.signup_apply_payment(
  p_order text, p_payment_id text, p_amount bigint, p_currency text, p_method text, p_outcome text, p_fail_code text, p_fail_desc text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  o public.signup_orders%ROWTYPE;
BEGIN
  IF session_user = 'authenticator' THEN RAISE EXCEPTION 'forbidden' USING errcode = '42501'; END IF;
  IF p_outcome IS NULL OR p_outcome NOT IN ('captured', 'failed') THEN RAISE EXCEPTION 'invalid_input'; END IF;
  SELECT * INTO o FROM public.signup_orders WHERE razorpay_order_id = p_order FOR UPDATE;
  IF NOT FOUND THEN RETURN jsonb_build_object('result', 'unknown_order'); END IF;
  IF (SELECT auth.uid()) IS NOT NULL AND o.user_id IS DISTINCT FROM (SELECT auth.uid()) THEN
    RAISE EXCEPTION 'forbidden' USING errcode = '42501';
  END IF;

  IF p_outcome = 'failed' THEN
    IF o.status = 'created' THEN
      UPDATE public.signup_orders SET last_failure_code = left(p_fail_code, 100), last_failure_description = left(p_fail_desc, 300) WHERE id = o.id;
    END IF;
    RETURN jsonb_build_object('result', 'failed', 'signupId', o.id, 'status', o.status);
  END IF;

  IF p_amount IS DISTINCT FROM o.total_minor OR p_currency IS DISTINCT FROM o.currency THEN
    RAISE EXCEPTION 'amount_mismatch';
  END IF;

  IF o.razorpay_payment_id IS NOT DISTINCT FROM p_payment_id THEN
    RETURN jsonb_build_object('result', 'duplicate', 'signupId', o.id, 'status', o.status);
  END IF;

  IF o.status = 'created' THEN
    UPDATE public.signup_orders SET status = 'paid', razorpay_payment_id = p_payment_id, payment_method = p_method,
      paid_at = now(), last_failure_code = NULL, last_failure_description = NULL WHERE id = o.id;
    RETURN jsonb_build_object('result', 'captured', 'signupId', o.id, 'status', 'paid');
  END IF;

  -- The order was already settled by another payment, or it was replaced: this money has to be given back.
  UPDATE public.signup_orders SET refund_required = true WHERE id = o.id;
  RETURN jsonb_build_object('result', 'refund_required', 'signupId', o.id, 'status', o.status);
END;
$$;
--> statement-breakpoint

-- What the signed-in person should do next: pay, create the store, or open it.
CREATE FUNCTION public.signup_status()
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_uid uuid := (SELECT auth.uid());
  o public.signup_orders%ROWTYPE;
  v_plan public.plans%ROWTYPE;
  v_state text;
BEGIN
  IF session_user = 'authenticator' THEN RAISE EXCEPTION 'forbidden' USING errcode = '42501'; END IF;
  IF v_uid IS NULL THEN RAISE EXCEPTION 'not_authenticated' USING errcode = '28000'; END IF;
  SELECT * INTO o FROM public.signup_orders s WHERE s.user_id = v_uid AND s.status IN ('created', 'paid');
  IF NOT FOUND THEN
    SELECT * INTO o FROM public.signup_orders s WHERE s.user_id = v_uid AND s.status = 'provisioned' ORDER BY s.provisioned_at DESC LIMIT 1;
    IF NOT FOUND THEN RETURN jsonb_build_object('state', 'none'); END IF;
  END IF;
  v_state := CASE o.status WHEN 'created' THEN 'payment_required' WHEN 'paid' THEN 'store_required' ELSE 'provisioned' END;
  SELECT * INTO v_plan FROM public.plans p WHERE p.id = o.plan_id;
  RETURN jsonb_build_object(
    'state', v_state, 'signupId', o.id, 'planCode', v_plan.code, 'planName', v_plan.name, 'billingInterval', o.billing_interval,
    'currency', o.currency, 'subtotalMinor', o.subtotal_minor, 'taxMinor', o.tax_minor, 'totalMinor', o.total_minor,
    'tenantId', o.tenant_id, 'lastFailure', o.last_failure_description);
END;
$$;
--> statement-breakpoint

-- Creates the paid customer's organization: tenant + Owner membership + store (through the shared routine), puts the tenant on the plan it
-- paid for, and records the paid invoice and payment so billing history is complete. Safe to call again: a second call returns the same
-- tenant and writes nothing. Only the person who paid can do this, and only after the payment was settled.
CREATE FUNCTION public.signup_provision(p_signup uuid, p_store_name text, p_store_slug text, p_public_id text)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_uid uuid := (SELECT auth.uid());
  o public.signup_orders%ROWTYPE;
  v_plan public.plans%ROWTYPE;
  st public.billing_settings%ROWTYPE;
  sub public.tenant_subscriptions%ROWTYPE;
  v_result jsonb;
  v_tenant uuid;
  v_invoice uuid;
  v_payment uuid;
  v_slug text;
  v_public_id text;
BEGIN
  IF session_user = 'authenticator' THEN RAISE EXCEPTION 'forbidden' USING errcode = '42501'; END IF;
  IF v_uid IS NULL THEN RAISE EXCEPTION 'not_authenticated' USING errcode = '28000'; END IF;

  SELECT * INTO o FROM public.signup_orders WHERE id = p_signup AND user_id = v_uid FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'not_found'; END IF;

  IF o.status = 'provisioned' THEN
    SELECT s.slug INTO v_slug FROM public.stores s WHERE s.tenant_id = o.tenant_id ORDER BY s.created_at LIMIT 1;
    SELECT t.public_id INTO v_public_id FROM public.tenants t WHERE t.id = o.tenant_id;
    RETURN jsonb_build_object('tenant_id', o.tenant_id, 'store_slug', v_slug, 'public_id', v_public_id, 'created', false);
  END IF;
  IF o.status <> 'paid' THEN RAISE EXCEPTION 'payment_required'; END IF;

  v_result := public.provision_tenant_internal(v_uid, p_store_name, p_store_name, p_store_slug, NULL, NULL, NULL, p_public_id);
  v_tenant := (v_result ->> 'tenant_id')::uuid;

  -- The new-tenant trigger gave the tenant the default plan (as a trial). It paid for a plan, so that plan applies, active, from now.
  SELECT * INTO v_plan FROM public.plans WHERE id = o.plan_id;
  PERFORM public.apply_plan_to_tenant(v_tenant, o.plan_id, o.billing_interval, false);
  SELECT * INTO sub FROM public.tenant_subscriptions WHERE tenant_id = v_tenant;

  IF o.total_minor > 0 THEN
    SELECT * INTO st FROM public.billing_settings;
    INSERT INTO public.billing_invoices
      (number, tenant_id, tenant_name, subscription_id, plan_code, plan_name, billing_interval, description, period_start, period_end,
       currency, subtotal_minor, tax_rate_bps, tax_minor, total_minor, seller, status, paid_at, due_at, created_by)
    VALUES
      (public.billing_next_invoice_number(), v_tenant, btrim(p_store_name), sub.id, v_plan.code, v_plan.name, o.billing_interval,
       v_plan.name || ' plan, ' || o.billing_interval || ' subscription', sub.current_period_start,
       coalesce(sub.current_period_end, sub.current_period_start + CASE WHEN o.billing_interval = 'yearly' THEN interval '1 year' ELSE interval '1 month' END),
       o.currency, o.subtotal_minor, o.tax_rate_bps, o.tax_minor, o.total_minor,
       jsonb_build_object('legalName', st.legal_name, 'address', st.address, 'gstin', st.gstin, 'taxLabel', st.tax_label),
       'paid', o.paid_at, o.paid_at, v_uid)
    RETURNING id INTO v_invoice;
    INSERT INTO public.billing_payments
      (invoice_id, tenant_id, provider, status, amount_minor, currency, razorpay_order_id, razorpay_payment_id, method, captured_at)
    VALUES
      (v_invoice, v_tenant, 'razorpay', 'succeeded', o.total_minor, o.currency, o.razorpay_order_id, o.razorpay_payment_id, o.payment_method, o.paid_at)
    RETURNING id INTO v_payment;
  END IF;

  UPDATE public.signup_orders SET status = 'provisioned', tenant_id = v_tenant, invoice_id = v_invoice, provisioned_at = now() WHERE id = o.id;
  SELECT t.public_id INTO v_public_id FROM public.tenants t WHERE t.id = v_tenant;
  RETURN jsonb_build_object('tenant_id', v_tenant, 'store_slug', v_result ->> 'store_slug', 'public_id', v_public_id, 'created', true);
END;
$$;
--> statement-breakpoint

REVOKE ALL ON FUNCTION public.signup_prepare(text, text) FROM public, anon;
--> statement-breakpoint
REVOKE ALL ON FUNCTION public.signup_attach_order(uuid, text, bigint, text) FROM public, anon;
--> statement-breakpoint
REVOKE ALL ON FUNCTION public.signup_apply_payment(text, text, bigint, text, text, text, text, text) FROM public, anon;
--> statement-breakpoint
REVOKE ALL ON FUNCTION public.signup_status() FROM public, anon;
--> statement-breakpoint
REVOKE ALL ON FUNCTION public.signup_provision(uuid, text, text, text) FROM public, anon;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION public.signup_prepare(text, text) TO authenticated;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION public.signup_attach_order(uuid, text, bigint, text) TO authenticated;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION public.signup_apply_payment(text, text, bigint, text, text, text, text, text) TO authenticated;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION public.signup_status() TO authenticated;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION public.signup_provision(uuid, text, text, text) TO authenticated;
