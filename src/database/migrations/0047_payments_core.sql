-- Custom migration: Razorpay connection state, COD settings and payment transactions.
--
-- 1. tenant_razorpay_config gains `enabled` and a verification state (unverified / verified / failed). Replacing the Key ID or
--    Key Secret resets both (trigger), so new credentials must be verified against Razorpay again before they take payments.
--    The Owner changes them only through two SECURITY DEFINER functions that re-check the Owner role; enabling requires a
--    successful verification.
-- 2. get_razorpay_credentials() is the ONLY way the encrypted secret leaves the table. It is granted to the tenant-pinned
--    storeforge_checkout role alone and refuses any tenant other than the pinned one; the API decrypts in memory with the
--    server-side key. `authenticated` (and so PostgREST) cannot call it.
-- 3. tenant_cod_config: per-tenant Cash on Delivery settings (Owner only), readable by the pinned checkout role.
-- 4. payment_transactions: one row per order and provider. Online rows carry the Razorpay order and payment ids; COD rows track
--    collection separately (pending_collection -> collected). Unique ids make a payment impossible to apply twice.

-- Razorpay connection state --------------------------------------------------------------------------------------------
ALTER TABLE "tenant_razorpay_config"
  ADD COLUMN "enabled" boolean NOT NULL DEFAULT false,
  ADD COLUMN "verification_status" text NOT NULL DEFAULT 'unverified',
  ADD COLUMN "verified_at" timestamp with time zone,
  ADD COLUMN "verification_error" text,
  ADD CONSTRAINT "trc_verification_status_check" CHECK ("verification_status" IN ('unverified', 'verified', 'failed')),
  ADD CONSTRAINT "trc_verified_at_check" CHECK (("verification_status" = 'verified') = ("verified_at" IS NOT NULL)),
  ADD CONSTRAINT "trc_enabled_needs_verified_check" CHECK (NOT "enabled" OR "verification_status" = 'verified'),
  ADD CONSTRAINT "trc_verification_error_check" CHECK ("verification_error" IS NULL OR char_length("verification_error") <= 200);
--> statement-breakpoint

CREATE FUNCTION public.reset_razorpay_verification()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = ''
AS $$
BEGIN
  IF NEW.key_id IS DISTINCT FROM OLD.key_id OR NEW.secret_ciphertext IS DISTINCT FROM OLD.secret_ciphertext THEN
    NEW.enabled := false;
    NEW.verification_status := 'unverified';
    NEW.verified_at := NULL;
    NEW.verification_error := NULL;
  END IF;
  RETURN NEW;
END
$$;
--> statement-breakpoint
CREATE TRIGGER tenant_razorpay_config_reset_verification
  BEFORE UPDATE ON public.tenant_razorpay_config
  FOR EACH ROW EXECUTE FUNCTION public.reset_razorpay_verification();
--> statement-breakpoint

GRANT SELECT (enabled, verification_status, verified_at, verification_error) ON public.tenant_razorpay_config TO authenticated;
--> statement-breakpoint

CREATE FUNCTION public.set_razorpay_enabled(p_tenant uuid, p_enabled boolean)
RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_status text;
BEGIN
  IF NOT public.has_tenant_role(p_tenant, ARRAY['owner']) OR session_user = 'authenticator' THEN
    RETURN 'forbidden';
  END IF;
  SELECT verification_status INTO v_status FROM public.tenant_razorpay_config WHERE tenant_id = p_tenant FOR UPDATE;
  IF NOT FOUND THEN RETURN 'not_configured'; END IF;
  IF p_enabled AND v_status <> 'verified' THEN RETURN 'not_verified'; END IF;
  UPDATE public.tenant_razorpay_config SET enabled = p_enabled WHERE tenant_id = p_tenant;
  RETURN 'ok';
END
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION public.set_razorpay_enabled(uuid, boolean) FROM public, anon;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION public.set_razorpay_enabled(uuid, boolean) TO authenticated;
--> statement-breakpoint

CREATE FUNCTION public.record_razorpay_verification(p_tenant uuid, p_ok boolean, p_error text)
RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  IF NOT public.has_tenant_role(p_tenant, ARRAY['owner']) OR session_user = 'authenticator' THEN
    RETURN 'forbidden';
  END IF;
  UPDATE public.tenant_razorpay_config
  SET verification_status = CASE WHEN p_ok THEN 'verified' ELSE 'failed' END,
      verified_at = CASE WHEN p_ok THEN now() ELSE NULL END,
      verification_error = CASE WHEN p_ok THEN NULL ELSE left(p_error, 200) END,
      enabled = CASE WHEN p_ok THEN enabled ELSE false END
  WHERE tenant_id = p_tenant;
  IF NOT FOUND THEN RETURN 'not_configured'; END IF;
  RETURN 'ok';
END
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION public.record_razorpay_verification(uuid, boolean, text) FROM public, anon;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION public.record_razorpay_verification(uuid, boolean, text) TO authenticated;
--> statement-breakpoint

CREATE FUNCTION public.get_razorpay_credentials(p_tenant uuid)
RETURNS TABLE (
  key_id text, secret_ciphertext text, iv text, auth_tag text, key_version smallint,
  webhook_secret_ciphertext text, webhook_secret_iv text, webhook_secret_auth_tag text, webhook_secret_key_version smallint,
  enabled boolean, verification_status text
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
  SELECT c.key_id, c.secret_ciphertext, c.iv, c.auth_tag, c.key_version,
         c.webhook_secret_ciphertext, c.webhook_secret_iv, c.webhook_secret_auth_tag, c.webhook_secret_key_version,
         c.enabled, c.verification_status
  FROM public.tenant_razorpay_config c
  WHERE c.tenant_id = p_tenant AND p_tenant = public.pinned_tenant_id()
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION public.get_razorpay_credentials(uuid) FROM public, anon, authenticated;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION public.get_razorpay_credentials(uuid) TO storeforge_checkout;
--> statement-breakpoint

-- Webhook URLs name the tenant by its public id; resolving it needs no credentials.
CREATE FUNCTION public.get_tenant_by_public_id(p_public_id text)
RETURNS uuid
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
  SELECT t.id FROM public.tenants t WHERE t.public_id = p_public_id AND t.status = 'active'
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION public.get_tenant_by_public_id(text) FROM public, anon, authenticated;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION public.get_tenant_by_public_id(text) TO storeforge_checkout;
--> statement-breakpoint

-- COD settings ---------------------------------------------------------------------------------------------------------
CREATE TABLE "tenant_cod_config" (
  "tenant_id" uuid PRIMARY KEY REFERENCES "tenants"("id") ON DELETE CASCADE,
  "enabled" boolean NOT NULL DEFAULT false,
  "min_order_minor" bigint NOT NULL DEFAULT 0,
  "max_order_minor" bigint,
  "fee_minor" bigint NOT NULL DEFAULT 0,
  "updated_at" timestamp with time zone NOT NULL DEFAULT now(),
  "updated_by" uuid REFERENCES auth.users("id") ON DELETE SET NULL,
  CONSTRAINT "tcc_amounts_check" CHECK ("min_order_minor" >= 0 AND "fee_minor" >= 0
    AND ("max_order_minor" IS NULL OR "max_order_minor" >= "min_order_minor")
    AND "min_order_minor" <= 100000000000 AND "fee_minor" <= 100000000000)
);
--> statement-breakpoint
ALTER TABLE "tenant_cod_config" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
REVOKE ALL ON "tenant_cod_config" FROM public, anon, authenticated;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ("enabled", "min_order_minor", "max_order_minor", "fee_minor", "updated_at", "updated_by") ON "tenant_cod_config" TO authenticated;
--> statement-breakpoint
GRANT INSERT ("tenant_id") ON "tenant_cod_config" TO authenticated;
--> statement-breakpoint
CREATE POLICY tenant_cod_config_select_owner ON public.tenant_cod_config FOR SELECT TO authenticated
  USING (public.has_tenant_role(tenant_id, ARRAY['owner']) AND session_user <> 'authenticator');
--> statement-breakpoint
CREATE POLICY tenant_cod_config_insert_owner ON public.tenant_cod_config FOR INSERT TO authenticated
  WITH CHECK (public.has_tenant_role(tenant_id, ARRAY['owner']) AND session_user <> 'authenticator' AND updated_by = (SELECT auth.uid()));
--> statement-breakpoint
CREATE POLICY tenant_cod_config_update_owner ON public.tenant_cod_config FOR UPDATE TO authenticated
  USING (public.has_tenant_role(tenant_id, ARRAY['owner']) AND session_user <> 'authenticator')
  WITH CHECK (public.has_tenant_role(tenant_id, ARRAY['owner']) AND session_user <> 'authenticator' AND updated_by = (SELECT auth.uid()));
--> statement-breakpoint
GRANT SELECT ON "tenant_cod_config" TO storeforge_checkout;
--> statement-breakpoint
CREATE POLICY tenant_cod_config_checkout_pinned ON public.tenant_cod_config FOR SELECT TO storeforge_checkout
  USING (tenant_id = public.pinned_tenant_id());
--> statement-breakpoint

-- Payment transactions -------------------------------------------------------------------------------------------------
CREATE TABLE "payment_transactions" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "tenant_id" uuid NOT NULL REFERENCES "tenants"("id") ON DELETE CASCADE,
  "order_id" uuid NOT NULL,
  "provider" text NOT NULL,
  "status" text NOT NULL,
  "amount_minor" bigint NOT NULL,
  "currency" text NOT NULL,
  "razorpay_order_id" text,
  "razorpay_payment_id" text,
  "method" text,
  "failure_code" text,
  "failure_description" text,
  "attempts" integer NOT NULL DEFAULT 0,
  "refund_required" boolean NOT NULL DEFAULT false,
  "captured_at" timestamp with time zone,
  "collected_at" timestamp with time zone,
  "collected_by" uuid,
  "created_at" timestamp with time zone NOT NULL DEFAULT now(),
  "updated_at" timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT "payment_transactions_order_fk" FOREIGN KEY ("tenant_id", "order_id") REFERENCES "orders"("tenant_id", "id") ON DELETE CASCADE,
  CONSTRAINT "payment_transactions_tenant_id_id_key" UNIQUE ("tenant_id", "id"),
  CONSTRAINT "payment_transactions_order_provider_key" UNIQUE ("order_id", "provider"),
  CONSTRAINT "payment_transactions_provider_check" CHECK ("provider" IN ('razorpay', 'cod')),
  CONSTRAINT "payment_transactions_status_check" CHECK ("status" IN ('created', 'authorized', 'captured', 'failed', 'cancelled', 'pending_collection', 'collected')),
  CONSTRAINT "payment_transactions_provider_status_check" CHECK (
    ("provider" = 'razorpay' AND "status" IN ('created', 'authorized', 'captured', 'failed', 'cancelled') AND "razorpay_order_id" IS NOT NULL)
    OR ("provider" = 'cod' AND "status" IN ('pending_collection', 'collected', 'cancelled') AND "razorpay_order_id" IS NULL AND "razorpay_payment_id" IS NULL)),
  CONSTRAINT "payment_transactions_amount_check" CHECK ("amount_minor" > 0),
  CONSTRAINT "payment_transactions_currency_check" CHECK ("currency" ~ '^[A-Z]{3}$'),
  CONSTRAINT "payment_transactions_collected_check" CHECK (("status" = 'collected') = ("collected_at" IS NOT NULL)),
  CONSTRAINT "payment_transactions_failure_check" CHECK (
    ("failure_code" IS NULL OR char_length("failure_code") <= 100) AND ("failure_description" IS NULL OR char_length("failure_description") <= 500))
);
--> statement-breakpoint
CREATE UNIQUE INDEX "payment_transactions_razorpay_order_key" ON "payment_transactions" ("tenant_id", "razorpay_order_id") WHERE "razorpay_order_id" IS NOT NULL;
--> statement-breakpoint
CREATE UNIQUE INDEX "payment_transactions_razorpay_payment_key" ON "payment_transactions" ("tenant_id", "razorpay_payment_id") WHERE "razorpay_payment_id" IS NOT NULL;
--> statement-breakpoint
CREATE INDEX "payment_transactions_tenant_created_idx" ON "payment_transactions" ("tenant_id", "created_at" DESC);
--> statement-breakpoint
CREATE INDEX "payment_transactions_refund_idx" ON "payment_transactions" ("tenant_id") WHERE "refund_required";
--> statement-breakpoint
ALTER TABLE "payment_transactions" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
REVOKE ALL ON "payment_transactions" FROM public, anon, authenticated;
--> statement-breakpoint
GRANT SELECT ON "payment_transactions" TO authenticated;
--> statement-breakpoint
CREATE POLICY payment_transactions_select_member ON public.payment_transactions FOR SELECT TO authenticated
  USING (public.has_module_access(tenant_id, 'orders', 'read') AND session_user <> 'authenticator');
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON "payment_transactions" TO storeforge_checkout;
--> statement-breakpoint
CREATE POLICY payment_transactions_checkout_pinned ON public.payment_transactions FOR ALL TO storeforge_checkout
  USING (tenant_id = public.pinned_tenant_id()) WITH CHECK (tenant_id = public.pinned_tenant_id());
--> statement-breakpoint

-- Checkout asks only "does this store take Razorpay payments?", never for the credentials.
CREATE FUNCTION public.razorpay_accepts_payments(p_tenant uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
  SELECT coalesce((
    SELECT c.enabled AND c.verification_status = 'verified'
    FROM public.tenant_razorpay_config c
    WHERE c.tenant_id = p_tenant AND p_tenant = public.pinned_tenant_id()), false)
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION public.razorpay_accepts_payments(uuid) FROM public, anon, authenticated;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION public.razorpay_accepts_payments(uuid) TO storeforge_checkout;
