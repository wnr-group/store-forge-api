-- Custom migration: each tenant's own shipping carrier connections, shipping preferences and the audit history of both.
--
-- tenant_carrier_connections: one row per tenant and carrier (Shiprocket, Delhivery, Blue Dart, ...). The carrier's SECRET
-- credentials exist only as one AES-256-GCM ciphertext (tenant id as authenticated data, like the Razorpay keys); the settings
-- that are not secret (a pickup location name, an environment) are kept readable so the dashboard can show them, and
-- `secret_keys` lists which secrets are saved without revealing them. The request role can never read the ciphertext columns.
--   * Owner only (RLS), and the PostgREST login role `authenticator` is shut out of every policy.
--   * enabled and is_default are changed only by SECURITY DEFINER functions that re-check the Owner role; enabling needs a
--     successful connection check, a default must be enabled, and a tenant has at most one default (partial unique index).
--   * Changing credentials or settings (trigger) switches the carrier off again until it is re-checked.
-- get_carrier_credentials(): the ONLY way the ciphertext leaves the table. Granted to the tenant-pinned storeforge_checkout role
-- alone and refuses any tenant but the pinned one; the API decrypts in memory.
-- carrier_connection_events: append-only history of who connected, changed, checked, enabled or removed a carrier.
-- tenant_shipping_preferences: how a carrier is chosen for an order (manual, or automatic by a strategy).

CREATE TABLE "tenant_carrier_connections" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "tenant_id" uuid NOT NULL REFERENCES "tenants"("id") ON DELETE CASCADE,
  "provider_code" text NOT NULL,
  "settings" jsonb NOT NULL DEFAULT '{}'::jsonb,
  "secret_keys" text[] NOT NULL DEFAULT '{}',
  "secrets_ciphertext" text NOT NULL,
  "iv" text NOT NULL,
  "auth_tag" text NOT NULL,
  "key_version" smallint NOT NULL,
  "enabled" boolean NOT NULL DEFAULT false,
  "is_default" boolean NOT NULL DEFAULT false,
  "verification_status" text NOT NULL DEFAULT 'unverified',
  "verified_at" timestamp with time zone,
  "verification_error" text,
  "created_at" timestamp with time zone NOT NULL DEFAULT now(),
  "created_by" uuid REFERENCES auth.users("id") ON DELETE SET NULL,
  "updated_at" timestamp with time zone NOT NULL DEFAULT now(),
  "updated_by" uuid REFERENCES auth.users("id") ON DELETE SET NULL,
  CONSTRAINT "tcc_tenant_provider_key" UNIQUE ("tenant_id", "provider_code"),
  CONSTRAINT "tcc_tenant_id_id_key" UNIQUE ("tenant_id", "id"),
  CONSTRAINT "tcc_provider_check" CHECK ("provider_code" ~ '^[a-z][a-z0-9_]{1,30}$'),
  CONSTRAINT "tcc_settings_check" CHECK (jsonb_typeof("settings") = 'object' AND pg_column_size("settings") <= 8192),
  CONSTRAINT "tcc_secret_keys_check" CHECK (cardinality("secret_keys") <= 20),
  CONSTRAINT "tcc_key_version_check" CHECK ("key_version" >= 1),
  CONSTRAINT "tcc_iv_check" CHECK ("iv" ~ '^[A-Za-z0-9+/]{16}$'),
  CONSTRAINT "tcc_auth_tag_check" CHECK ("auth_tag" ~ '^[A-Za-z0-9+/]{22}==$'),
  CONSTRAINT "tcc_ciphertext_check" CHECK ("secrets_ciphertext" ~ '^[A-Za-z0-9+/]+={0,2}$' AND char_length("secrets_ciphertext") <= 2048),
  CONSTRAINT "tcc_verification_status_check" CHECK ("verification_status" IN ('unverified', 'verified', 'failed')),
  CONSTRAINT "tcc_verified_at_check" CHECK (("verification_status" = 'verified') = ("verified_at" IS NOT NULL)),
  CONSTRAINT "tcc_enabled_needs_verified_check" CHECK (NOT "enabled" OR "verification_status" = 'verified'),
  CONSTRAINT "tcc_default_needs_enabled_check" CHECK (NOT "is_default" OR "enabled"),
  CONSTRAINT "tcc_verification_error_check" CHECK ("verification_error" IS NULL OR char_length("verification_error") <= 200)
);
--> statement-breakpoint
CREATE UNIQUE INDEX "tcc_one_default_per_tenant" ON "tenant_carrier_connections" ("tenant_id") WHERE "is_default";
--> statement-breakpoint

CREATE FUNCTION public.reset_carrier_verification()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = ''
AS $$
BEGIN
  IF NEW.secrets_ciphertext IS DISTINCT FROM OLD.secrets_ciphertext OR NEW.settings IS DISTINCT FROM OLD.settings THEN
    NEW.enabled := false;
    NEW.is_default := false;
    NEW.verification_status := 'unverified';
    NEW.verified_at := NULL;
    NEW.verification_error := NULL;
  END IF;
  RETURN NEW;
END
$$;
--> statement-breakpoint
CREATE TRIGGER tenant_carrier_connections_reset_verification
  BEFORE UPDATE ON public.tenant_carrier_connections
  FOR EACH ROW EXECUTE FUNCTION public.reset_carrier_verification();
--> statement-breakpoint

ALTER TABLE "tenant_carrier_connections" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
REVOKE ALL ON "tenant_carrier_connections" FROM public, anon, authenticated;
--> statement-breakpoint
GRANT SELECT ("id", "tenant_id", "provider_code", "settings", "secret_keys", "enabled", "is_default", "verification_status", "verified_at",
  "verification_error", "created_at", "created_by", "updated_at", "updated_by") ON "tenant_carrier_connections" TO authenticated;
--> statement-breakpoint
GRANT INSERT ("tenant_id", "provider_code", "settings", "secret_keys", "secrets_ciphertext", "iv", "auth_tag", "key_version", "created_by",
  "updated_by", "updated_at") ON "tenant_carrier_connections" TO authenticated;
--> statement-breakpoint
GRANT UPDATE ("settings", "secret_keys", "secrets_ciphertext", "iv", "auth_tag", "key_version", "updated_by", "updated_at") ON "tenant_carrier_connections" TO authenticated;
--> statement-breakpoint
GRANT DELETE ON "tenant_carrier_connections" TO authenticated;
--> statement-breakpoint
CREATE POLICY tcc_select_owner ON public.tenant_carrier_connections FOR SELECT TO authenticated
  USING (public.has_tenant_role(tenant_id, ARRAY['owner']) AND session_user <> 'authenticator');
--> statement-breakpoint
CREATE POLICY tcc_insert_owner ON public.tenant_carrier_connections FOR INSERT TO authenticated
  WITH CHECK (public.has_tenant_role(tenant_id, ARRAY['owner']) AND session_user <> 'authenticator'
    AND created_by = (SELECT auth.uid()) AND updated_by = (SELECT auth.uid()));
--> statement-breakpoint
CREATE POLICY tcc_update_owner ON public.tenant_carrier_connections FOR UPDATE TO authenticated
  USING (public.has_tenant_role(tenant_id, ARRAY['owner']) AND session_user <> 'authenticator')
  WITH CHECK (public.has_tenant_role(tenant_id, ARRAY['owner']) AND session_user <> 'authenticator' AND updated_by = (SELECT auth.uid()));
--> statement-breakpoint
CREATE POLICY tcc_delete_owner ON public.tenant_carrier_connections FOR DELETE TO authenticated
  USING (public.has_tenant_role(tenant_id, ARRAY['owner']) AND session_user <> 'authenticator');
--> statement-breakpoint

-- State changes: re-check the Owner role inside, change only the intended columns.
CREATE FUNCTION public.set_carrier_enabled(p_tenant uuid, p_provider text, p_enabled boolean)
RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_status text;
BEGIN
  IF NOT public.has_tenant_role(p_tenant, ARRAY['owner']) OR session_user = 'authenticator' THEN RETURN 'forbidden'; END IF;
  SELECT verification_status INTO v_status FROM public.tenant_carrier_connections
    WHERE tenant_id = p_tenant AND provider_code = p_provider FOR UPDATE;
  IF NOT FOUND THEN RETURN 'not_connected'; END IF;
  IF p_enabled AND v_status <> 'verified' THEN RETURN 'not_verified'; END IF;
  UPDATE public.tenant_carrier_connections
    SET enabled = p_enabled, is_default = CASE WHEN p_enabled THEN is_default ELSE false END
    WHERE tenant_id = p_tenant AND provider_code = p_provider;
  RETURN 'ok';
END
$$;
--> statement-breakpoint
CREATE FUNCTION public.set_carrier_default(p_tenant uuid, p_provider text, p_default boolean)
RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_enabled boolean;
BEGIN
  IF NOT public.has_tenant_role(p_tenant, ARRAY['owner']) OR session_user = 'authenticator' THEN RETURN 'forbidden'; END IF;
  SELECT enabled INTO v_enabled FROM public.tenant_carrier_connections
    WHERE tenant_id = p_tenant AND provider_code = p_provider FOR UPDATE;
  IF NOT FOUND THEN RETURN 'not_connected'; END IF;
  IF p_default AND NOT v_enabled THEN RETURN 'not_enabled'; END IF;
  IF p_default THEN
    UPDATE public.tenant_carrier_connections SET is_default = false WHERE tenant_id = p_tenant AND is_default AND provider_code <> p_provider;
  END IF;
  UPDATE public.tenant_carrier_connections SET is_default = p_default WHERE tenant_id = p_tenant AND provider_code = p_provider;
  RETURN 'ok';
END
$$;
--> statement-breakpoint
CREATE FUNCTION public.record_carrier_verification(p_tenant uuid, p_provider text, p_ok boolean, p_error text)
RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  IF NOT public.has_tenant_role(p_tenant, ARRAY['owner']) OR session_user = 'authenticator' THEN RETURN 'forbidden'; END IF;
  UPDATE public.tenant_carrier_connections
    SET verification_status = CASE WHEN p_ok THEN 'verified' ELSE 'failed' END,
        verified_at = CASE WHEN p_ok THEN now() ELSE NULL END,
        verification_error = CASE WHEN p_ok THEN NULL ELSE left(p_error, 200) END,
        enabled = CASE WHEN p_ok THEN enabled ELSE false END,
        is_default = CASE WHEN p_ok THEN is_default ELSE false END
    WHERE tenant_id = p_tenant AND provider_code = p_provider;
  IF NOT FOUND THEN RETURN 'not_connected'; END IF;
  RETURN 'ok';
END
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION public.set_carrier_enabled(uuid, text, boolean), public.set_carrier_default(uuid, text, boolean),
  public.record_carrier_verification(uuid, text, boolean, text) FROM public, anon;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION public.set_carrier_enabled(uuid, text, boolean), public.set_carrier_default(uuid, text, boolean),
  public.record_carrier_verification(uuid, text, boolean, text) TO authenticated;
--> statement-breakpoint

-- The only way the ciphertext leaves the table: pinned checkout role, own tenant only. Shipping needs one carrier (a given code)
-- or every carrier of the tenant (selection), so the provider is optional.
CREATE FUNCTION public.get_carrier_credentials(p_tenant uuid, p_provider text DEFAULT NULL)
RETURNS TABLE (
  provider_code text, settings jsonb, secrets_ciphertext text, iv text, auth_tag text, key_version smallint,
  enabled boolean, is_default boolean, verification_status text
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
  SELECT c.provider_code, c.settings, c.secrets_ciphertext, c.iv, c.auth_tag, c.key_version, c.enabled, c.is_default, c.verification_status
  FROM public.tenant_carrier_connections c
  WHERE c.tenant_id = p_tenant AND p_tenant = public.pinned_tenant_id() AND (p_provider IS NULL OR c.provider_code = p_provider)
  ORDER BY c.provider_code
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION public.get_carrier_credentials(uuid, text) FROM public, anon, authenticated;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION public.get_carrier_credentials(uuid, text) TO storeforge_checkout;
--> statement-breakpoint

-- Audit history -----------------------------------------------------------------------------------------------------------
CREATE TABLE "carrier_connection_events" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "tenant_id" uuid NOT NULL REFERENCES "tenants"("id") ON DELETE CASCADE,
  "provider_code" text NOT NULL,
  "action" text NOT NULL,
  "actor_id" uuid,
  "note" text,
  "created_at" timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT "cce_action_check" CHECK ("action" IN ('connect', 'update', 'verify', 'verify_failed', 'enable', 'disable', 'set_default', 'unset_default', 'disconnect')),
  CONSTRAINT "cce_provider_check" CHECK ("provider_code" ~ '^[a-z][a-z0-9_]{1,30}$'),
  CONSTRAINT "cce_note_check" CHECK ("note" IS NULL OR char_length("note") <= 300)
);
--> statement-breakpoint
CREATE INDEX "cce_tenant_created_idx" ON "carrier_connection_events" ("tenant_id", "created_at" DESC);
--> statement-breakpoint
ALTER TABLE "carrier_connection_events" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
REVOKE ALL ON "carrier_connection_events" FROM public, anon, authenticated;
--> statement-breakpoint
GRANT SELECT, INSERT ON "carrier_connection_events" TO authenticated;
--> statement-breakpoint
CREATE POLICY cce_select_owner ON public.carrier_connection_events FOR SELECT TO authenticated
  USING (public.has_tenant_role(tenant_id, ARRAY['owner']) AND session_user <> 'authenticator');
--> statement-breakpoint
CREATE POLICY cce_insert_owner ON public.carrier_connection_events FOR INSERT TO authenticated
  WITH CHECK (public.has_tenant_role(tenant_id, ARRAY['owner']) AND session_user <> 'authenticator' AND actor_id = (SELECT auth.uid()));
--> statement-breakpoint

-- Preferences -------------------------------------------------------------------------------------------------------------
CREATE TABLE "tenant_shipping_preferences" (
  "tenant_id" uuid PRIMARY KEY REFERENCES "tenants"("id") ON DELETE CASCADE,
  "selection_mode" text NOT NULL DEFAULT 'manual',
  "strategy" text NOT NULL DEFAULT 'lowest_cost',
  "updated_at" timestamp with time zone NOT NULL DEFAULT now(),
  "updated_by" uuid REFERENCES auth.users("id") ON DELETE SET NULL,
  CONSTRAINT "tsp_mode_check" CHECK ("selection_mode" IN ('manual', 'automatic')),
  CONSTRAINT "tsp_strategy_check" CHECK ("strategy" IN ('lowest_cost', 'fastest', 'preferred'))
);
--> statement-breakpoint
ALTER TABLE "tenant_shipping_preferences" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
REVOKE ALL ON "tenant_shipping_preferences" FROM public, anon, authenticated;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON "tenant_shipping_preferences" TO authenticated;
--> statement-breakpoint
CREATE POLICY tsp_select_owner ON public.tenant_shipping_preferences FOR SELECT TO authenticated
  USING (public.has_tenant_role(tenant_id, ARRAY['owner']) AND session_user <> 'authenticator');
--> statement-breakpoint
CREATE POLICY tsp_insert_owner ON public.tenant_shipping_preferences FOR INSERT TO authenticated
  WITH CHECK (public.has_tenant_role(tenant_id, ARRAY['owner']) AND session_user <> 'authenticator' AND updated_by = (SELECT auth.uid()));
--> statement-breakpoint
CREATE POLICY tsp_update_owner ON public.tenant_shipping_preferences FOR UPDATE TO authenticated
  USING (public.has_tenant_role(tenant_id, ARRAY['owner']) AND session_user <> 'authenticator')
  WITH CHECK (public.has_tenant_role(tenant_id, ARRAY['owner']) AND session_user <> 'authenticator' AND updated_by = (SELECT auth.uid()));
--> statement-breakpoint
GRANT SELECT ON "tenant_shipping_preferences" TO storeforge_checkout;
--> statement-breakpoint
CREATE POLICY tsp_checkout_pinned ON public.tenant_shipping_preferences FOR SELECT TO storeforge_checkout
  USING (tenant_id = public.pinned_tenant_id());
