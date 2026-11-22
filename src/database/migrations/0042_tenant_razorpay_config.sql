-- Custom migration: per-tenant Razorpay credentials, encrypted at rest.
--
-- One row per tenant. The Key ID is stored as entered (it is not secret); the Key Secret is stored ONLY as AES-256-GCM
-- ciphertext (base64) with its IV, authentication tag and the key version used, encrypted by the API with the tenant UUID as
-- authenticated additional data. No SQL function decrypts it and the application role cannot read the secret columns.
--
-- Access control, in three layers:
--   * column privileges: the request role may SELECT only tenant_id, key_id, updated_at and updated_by, so a secret column can
--     never be read, not even with `select *` and not even by the tenant Owner. INSERT and UPDATE are limited to the columns the
--     API writes.
--   * RLS: only an active Owner of an active tenant (has_tenant_role) reaches a row. Admins, staff, platform admins and other
--     tenants' Owners get nothing. updated_by must be the caller, so the audit field cannot be forged.
--   * every policy also requires session_user <> 'authenticator'. Supabase's PostgREST connects as `authenticator` and then
--     switches role, whereas the API connects as `storeforge_app`; this keeps the table unreachable through PostgREST even for
--     an Owner holding a valid JWT, so the only path is the API.
-- The ciphertext cap (2048 base64 characters) is also enforced by the DTO and the encryption helper; the CHECK is the last line.

CREATE TABLE "tenant_razorpay_config" (
	"tenant_id" uuid PRIMARY KEY REFERENCES "tenants"("id") ON DELETE CASCADE,
	"key_id" text NOT NULL,
	"secret_ciphertext" text NOT NULL,
	"iv" text NOT NULL,
	"auth_tag" text NOT NULL,
	"key_version" smallint NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" uuid REFERENCES auth.users("id") ON DELETE SET NULL,
	CONSTRAINT "trc_key_id_check" CHECK ("key_id" ~ '^rzp_(test|live)_[A-Za-z0-9]{8,}$'),
	CONSTRAINT "trc_key_version_check" CHECK ("key_version" >= 1),
	CONSTRAINT "trc_iv_check" CHECK ("iv" ~ '^[A-Za-z0-9+/]{16}$'),
	CONSTRAINT "trc_auth_tag_check" CHECK ("auth_tag" ~ '^[A-Za-z0-9+/]{22}==$'),
	CONSTRAINT "trc_ciphertext_check" CHECK ("secret_ciphertext" ~ '^[A-Za-z0-9+/]+={0,2}$' AND char_length("secret_ciphertext") <= 2048)
);
--> statement-breakpoint
ALTER TABLE "tenant_razorpay_config" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint

REVOKE ALL ON public.tenant_razorpay_config FROM public, anon, authenticated;
--> statement-breakpoint
GRANT SELECT (tenant_id, key_id, updated_at, updated_by) ON public.tenant_razorpay_config TO authenticated;
--> statement-breakpoint
GRANT INSERT (tenant_id, key_id, secret_ciphertext, iv, auth_tag, key_version, updated_at, updated_by) ON public.tenant_razorpay_config TO authenticated;
--> statement-breakpoint
GRANT UPDATE (key_id, secret_ciphertext, iv, auth_tag, key_version, updated_at, updated_by) ON public.tenant_razorpay_config TO authenticated;
--> statement-breakpoint
GRANT DELETE ON public.tenant_razorpay_config TO authenticated;
--> statement-breakpoint

CREATE POLICY tenant_razorpay_config_select_owner ON public.tenant_razorpay_config FOR SELECT TO authenticated
  USING (public.has_tenant_role(tenant_id, ARRAY['owner']) AND session_user <> 'authenticator');
--> statement-breakpoint
CREATE POLICY tenant_razorpay_config_insert_owner ON public.tenant_razorpay_config FOR INSERT TO authenticated
  WITH CHECK (
    public.has_tenant_role(tenant_id, ARRAY['owner'])
    AND session_user <> 'authenticator'
    AND updated_by = (SELECT auth.uid())
  );
--> statement-breakpoint
CREATE POLICY tenant_razorpay_config_update_owner ON public.tenant_razorpay_config FOR UPDATE TO authenticated
  USING (public.has_tenant_role(tenant_id, ARRAY['owner']) AND session_user <> 'authenticator')
  WITH CHECK (
    public.has_tenant_role(tenant_id, ARRAY['owner'])
    AND session_user <> 'authenticator'
    AND updated_by = (SELECT auth.uid())
  );
--> statement-breakpoint
CREATE POLICY tenant_razorpay_config_delete_owner ON public.tenant_razorpay_config FOR DELETE TO authenticated
  USING (public.has_tenant_role(tenant_id, ARRAY['owner']) AND session_user <> 'authenticator');
