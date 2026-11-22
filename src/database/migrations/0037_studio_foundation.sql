-- Custom migration: Studio foundation tables (rollout flag, legal wordings and approvals, attestations, media assets,
-- publish history). Hand-written like 0020 / 0032 / 0036; the CREATE TABLE statements mirror the Drizzle models.
--
-- Security model (same conventions as 0020, 0032 and 0036)
--  * Every tenant table carries tenant_id, a composite foreign key (tenant_id, store_id) -> stores(tenant_id, id),
--    RLS enabled with no policy for anything not listed (deny by default), and REVOKE ALL before explicit grants.
--  * Tables the app role must never touch (store_studio_rollout, store_studio_rollout_events, legal_wordings,
--    feature_approvals) have NO grants and NO policies. They are written only by Platform Admin SECURITY DEFINER
--    functions (search_path = '') and read through narrow functions.
--  * Append-only tables (store_studio_rollout_events, feature_approvals, attestations, studio_publishes) reject UPDATE,
--    DELETE and TRUNCATE for every role, the table owner included (BEFORE triggers, precedent: admin_audit_logs).
--    The one exception is the removal of a store (tenant deletion cascades to its history): a DELETE is allowed only
--    when the store row no longer exists, so history can never be deleted while its store lives.
--  * Nothing here inserts any legal wording or feature approval. No approval exists until a Platform Admin records one.

-- 1. Legal wordings ---------------------------------------------------------------------------------------------
CREATE TABLE "legal_wordings" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"key" text NOT NULL,
	"version" integer NOT NULL,
	"language_tag" text NOT NULL,
	"text" text NOT NULL,
	"status" text DEFAULT 'draft' NOT NULL,
	"created_by" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "legal_wordings_key_version_key" UNIQUE("key", "version"),
	CONSTRAINT "legal_wordings_key_check" CHECK ("key" ~ '^[a-z][a-z0-9_.-]{1,63}$'),
	CONSTRAINT "legal_wordings_version_check" CHECK ("version" >= 1),
	CONSTRAINT "legal_wordings_language_tag_check" CHECK ("language_tag" ~ '^[A-Za-z]{2,3}(-[A-Za-z0-9]{2,8})*$'),
	CONSTRAINT "legal_wordings_text_check" CHECK (char_length("text") between 1 and 5000),
	CONSTRAINT "legal_wordings_status_check" CHECK ("status" in ('draft', 'approved', 'retired'))
);
--> statement-breakpoint
ALTER TABLE "legal_wordings" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
REVOKE ALL ON public.legal_wordings FROM public, anon, authenticated;
--> statement-breakpoint

-- Approved wording is immutable: it can only be retired. Retired wording is frozen. Only a draft can be edited or
-- deleted. Applies to every role (table owner included).
CREATE FUNCTION public.legal_wordings_guard()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = ''
AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF OLD.status = 'draft' THEN
      RETURN OLD;
    END IF;
    RAISE EXCEPTION 'legal_wording_immutable' USING errcode = '42501';
  END IF;
  IF OLD.status = 'draft'
     AND (NEW.id, NEW.key, NEW.version, NEW.created_by, NEW.created_at)
         IS NOT DISTINCT FROM (OLD.id, OLD.key, OLD.version, OLD.created_by, OLD.created_at) THEN
    RETURN NEW;
  END IF;
  IF OLD.status = 'approved' AND NEW.status = 'retired'
     AND (NEW.id, NEW.key, NEW.version, NEW.language_tag, NEW."text", NEW.created_by, NEW.created_at)
         IS NOT DISTINCT FROM (OLD.id, OLD.key, OLD.version, OLD.language_tag, OLD."text", OLD.created_by, OLD.created_at) THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'legal_wording_immutable' USING errcode = '42501';
END;
$$;
--> statement-breakpoint
CREATE FUNCTION public.studio_no_truncate()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = ''
AS $$
BEGIN
  RAISE EXCEPTION 'studio_history_immutable' USING errcode = '42501';
END;
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION public.legal_wordings_guard() FROM public, anon, authenticated;
--> statement-breakpoint
REVOKE ALL ON FUNCTION public.studio_no_truncate() FROM public, anon, authenticated;
--> statement-breakpoint
CREATE TRIGGER legal_wordings_no_change
  BEFORE UPDATE OR DELETE ON public.legal_wordings
  FOR EACH ROW EXECUTE FUNCTION public.legal_wordings_guard();
--> statement-breakpoint
CREATE TRIGGER legal_wordings_no_truncate
  BEFORE TRUNCATE ON public.legal_wordings
  FOR EACH STATEMENT EXECUTE FUNCTION public.studio_no_truncate();
--> statement-breakpoint

-- 2. Feature approvals (append-only) ------------------------------------------------------------------------------
CREATE TABLE "feature_approvals" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"feature_key" text NOT NULL,
	"wording_key" text NOT NULL,
	"wording_version" integer NOT NULL,
	"approver_ref" text NOT NULL,
	"approved_at" timestamp with time zone NOT NULL,
	"release" text NOT NULL,
	"recorded_by" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "feature_approvals_feature_key_check" CHECK ("feature_key" ~ '^[a-z][a-z0-9_.-]{1,63}$'),
	CONSTRAINT "feature_approvals_approver_ref_check" CHECK (char_length("approver_ref") between 1 and 200),
	CONSTRAINT "feature_approvals_release_check" CHECK (char_length("release") between 1 and 100),
	CONSTRAINT "feature_approvals_wording_fk" FOREIGN KEY ("wording_key", "wording_version") REFERENCES "public"."legal_wordings"("key", "version") ON DELETE restrict ON UPDATE no action
);
--> statement-breakpoint
ALTER TABLE "feature_approvals" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE INDEX "feature_approvals_feature_idx" ON "feature_approvals" USING btree ("feature_key", "approved_at" DESC);
--> statement-breakpoint
REVOKE ALL ON public.feature_approvals FROM public, anon, authenticated;
--> statement-breakpoint

CREATE FUNCTION public.feature_approvals_guard()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  IF TG_OP <> 'INSERT' THEN
    RAISE EXCEPTION 'feature_approval_immutable' USING errcode = '42501';
  END IF;
  -- An approval must point at wording that is approved right now.
  IF NOT EXISTS (
    SELECT 1 FROM public.legal_wordings w
    WHERE w.key = NEW.wording_key AND w.version = NEW.wording_version AND w.status = 'approved'
  ) THEN
    RAISE EXCEPTION 'wording_not_approved' USING errcode = '23514';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION public.feature_approvals_guard() FROM public, anon, authenticated;
--> statement-breakpoint
CREATE TRIGGER feature_approvals_guard
  BEFORE INSERT OR UPDATE OR DELETE ON public.feature_approvals
  FOR EACH ROW EXECUTE FUNCTION public.feature_approvals_guard();
--> statement-breakpoint
CREATE TRIGGER feature_approvals_no_truncate
  BEFORE TRUNCATE ON public.feature_approvals
  FOR EACH STATEMENT EXECUTE FUNCTION public.studio_no_truncate();
--> statement-breakpoint

-- 3. Rollout flag and its history ---------------------------------------------------------------------------------
-- No row = disabled, so every existing and new store starts disabled without any backfill.
CREATE TABLE "store_studio_rollout" (
	"store_id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"enabled" boolean DEFAULT false NOT NULL,
	"enabled_at" timestamp with time zone,
	"enabled_by" uuid,
	"point_of_no_return_at" timestamp with time zone,
	"point_of_no_return_reason" text,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "store_studio_rollout_store_fk" FOREIGN KEY ("tenant_id", "store_id") REFERENCES "public"."stores"("tenant_id", "id") ON DELETE cascade ON UPDATE no action,
	CONSTRAINT "store_studio_rollout_ponr_pair_check" CHECK (("point_of_no_return_at" is null) = ("point_of_no_return_reason" is null))
);
--> statement-breakpoint
ALTER TABLE "store_studio_rollout" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE INDEX "store_studio_rollout_tenant_idx" ON "store_studio_rollout" USING btree ("tenant_id");
--> statement-breakpoint
REVOKE ALL ON public.store_studio_rollout FROM public, anon, authenticated;
--> statement-breakpoint

CREATE TABLE "store_studio_rollout_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"store_id" uuid NOT NULL,
	"actor_id" uuid NOT NULL,
	"action" text NOT NULL,
	"reason" text NOT NULL,
	"previous" jsonb,
	"new" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "store_studio_rollout_events_store_fk" FOREIGN KEY ("tenant_id", "store_id") REFERENCES "public"."stores"("tenant_id", "id") ON DELETE cascade ON UPDATE no action,
	CONSTRAINT "store_studio_rollout_events_action_check" CHECK ("action" ~ '^[a-z_]+$'),
	CONSTRAINT "store_studio_rollout_events_reason_check" CHECK (char_length("reason") between 1 and 500)
);
--> statement-breakpoint
ALTER TABLE "store_studio_rollout_events" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE INDEX "store_studio_rollout_events_store_idx" ON "store_studio_rollout_events" USING btree ("tenant_id", "store_id", "created_at" DESC);
--> statement-breakpoint
REVOKE ALL ON public.store_studio_rollout_events FROM public, anon, authenticated;
--> statement-breakpoint

-- Shared by every append-only table that belongs to a store: refuses UPDATE, DELETE and TRUNCATE for every role, unless
-- the store itself is already gone (the cascade of a store / organization deletion). SECURITY DEFINER so the store
-- lookup is not hidden by the caller's RLS.
CREATE FUNCTION public.studio_history_guard()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  IF TG_OP = 'DELETE' AND NOT EXISTS (SELECT 1 FROM public.stores s WHERE s.id = OLD.store_id) THEN
    RETURN OLD;
  END IF;
  RAISE EXCEPTION 'studio_history_immutable' USING errcode = '42501';
END;
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION public.studio_history_guard() FROM public, anon, authenticated;
--> statement-breakpoint
CREATE TRIGGER store_studio_rollout_events_no_change
  BEFORE UPDATE OR DELETE ON public.store_studio_rollout_events
  FOR EACH ROW EXECUTE FUNCTION public.studio_history_guard();
--> statement-breakpoint
CREATE TRIGGER store_studio_rollout_events_no_truncate
  BEFORE TRUNCATE ON public.store_studio_rollout_events
  FOR EACH STATEMENT EXECUTE FUNCTION public.studio_no_truncate();
--> statement-breakpoint

-- 4. Attestations (append-only) -----------------------------------------------------------------------------------
-- user_id, asset_id and import_id are deliberately not foreign keys: the record must outlive the account, the file and
-- the import. wording_id pins the exact wording version that was accepted.
CREATE TABLE "attestations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"store_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"type" text NOT NULL,
	"wording_id" uuid NOT NULL,
	"accepted_at" timestamp with time zone DEFAULT now() NOT NULL,
	"asset_id" uuid,
	"import_id" uuid,
	"context" jsonb DEFAULT '{}'::jsonb NOT NULL,
	CONSTRAINT "attestations_tenant_id_id_key" UNIQUE("tenant_id", "id"),
	CONSTRAINT "attestations_store_fk" FOREIGN KEY ("tenant_id", "store_id") REFERENCES "public"."stores"("tenant_id", "id") ON DELETE cascade ON UPDATE no action,
	CONSTRAINT "attestations_wording_fk" FOREIGN KEY ("wording_id") REFERENCES "public"."legal_wordings"("id") ON DELETE restrict ON UPDATE no action,
	CONSTRAINT "attestations_type_check" CHECK ("type" in ('badge_upload', 'review_import')),
	CONSTRAINT "attestations_subject_check" CHECK (
		("type" = 'badge_upload' and "import_id" is null) or ("type" = 'review_import' and "asset_id" is null)
	),
	CONSTRAINT "attestations_context_check" CHECK (jsonb_typeof("context") = 'object' and octet_length("context"::text) <= 4096)
);
--> statement-breakpoint
ALTER TABLE "attestations" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE INDEX "attestations_store_idx" ON "attestations" USING btree ("tenant_id", "store_id", "accepted_at" DESC);
--> statement-breakpoint
CREATE INDEX "attestations_wording_idx" ON "attestations" USING btree ("wording_id");
--> statement-breakpoint
REVOKE ALL ON public.attestations FROM public, anon, authenticated;
--> statement-breakpoint
GRANT SELECT ON public.attestations TO authenticated;
--> statement-breakpoint
-- id and accepted_at are never client-written (default / trigger).
GRANT INSERT (tenant_id, store_id, user_id, type, wording_id, asset_id, import_id, context) ON public.attestations TO authenticated;
--> statement-breakpoint

CREATE POLICY attestations_select ON public.attestations
  FOR SELECT TO authenticated
  USING (
    public.has_module_access(tenant_id, 'design', 'read')
    OR (user_id = (SELECT auth.uid()) AND public.is_tenant_member(tenant_id))
  );
--> statement-breakpoint
-- The attesting person is always the signed-in user, and needs the 'attest' capability (the Owner holds it).
CREATE POLICY attestations_insert ON public.attestations
  FOR INSERT TO authenticated
  WITH CHECK (
    user_id = (SELECT auth.uid())
    AND public.has_member_capability(tenant_id, 'attest')
  );
--> statement-breakpoint

CREATE FUNCTION public.attestations_before_insert()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM public.legal_wordings w WHERE w.id = NEW.wording_id AND w.status = 'approved') THEN
    RAISE EXCEPTION 'wording_not_approved' USING errcode = '23514';
  END IF;
  IF NEW.asset_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM public.media_assets a
    WHERE a.id = NEW.asset_id AND a.tenant_id = NEW.tenant_id AND a.store_id = NEW.store_id
  ) THEN
    RAISE EXCEPTION 'asset_not_found' USING errcode = '23503';
  END IF;
  NEW.accepted_at := now();
  RETURN NEW;
END;
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION public.attestations_before_insert() FROM public, anon, authenticated;
--> statement-breakpoint
CREATE TRIGGER attestations_before_insert
  BEFORE INSERT ON public.attestations
  FOR EACH ROW EXECUTE FUNCTION public.attestations_before_insert();
--> statement-breakpoint
CREATE TRIGGER attestations_no_change
  BEFORE UPDATE OR DELETE ON public.attestations
  FOR EACH ROW EXECUTE FUNCTION public.studio_history_guard();
--> statement-breakpoint
CREATE TRIGGER attestations_no_truncate
  BEFORE TRUNCATE ON public.attestations
  FOR EACH STATEMENT EXECUTE FUNCTION public.studio_no_truncate();
--> statement-breakpoint

-- 5. Media assets -------------------------------------------------------------------------------------------------
-- Layout: {tenant_id}/{file} (a direct child of the tenant folder). JPEG, PNG and WebP only: no SVG, ever.
-- size_bytes is capped at 5 MiB: the `products` bucket limit (migration 0006) and the API's IMAGE_MAX_BYTES. The
-- older product_images check allows 10 MB but the bucket stops anything above 5 MiB first.
CREATE TABLE "media_assets" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"store_id" uuid NOT NULL,
	"owner_user_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"storage_path" text NOT NULL,
	"mime_type" text NOT NULL,
	"size_bytes" integer NOT NULL,
	"width" integer NOT NULL,
	"height" integer NOT NULL,
	"alt_text" text,
	"attestation_id" uuid,
	"finalized_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "media_assets_storage_path_key" UNIQUE("storage_path"),
	CONSTRAINT "media_assets_tenant_id_id_key" UNIQUE("tenant_id", "id"),
	CONSTRAINT "media_assets_store_fk" FOREIGN KEY ("tenant_id", "store_id") REFERENCES "public"."stores"("tenant_id", "id") ON DELETE cascade ON UPDATE no action,
	CONSTRAINT "media_assets_owner_user_id_users_id_fk" FOREIGN KEY ("owner_user_id") REFERENCES "auth"."users"("id") ON DELETE cascade ON UPDATE no action,
	CONSTRAINT "media_assets_attestation_fk" FOREIGN KEY ("tenant_id", "attestation_id") REFERENCES "public"."attestations"("tenant_id", "id") ON DELETE cascade ON UPDATE no action,
	CONSTRAINT "media_assets_kind_check" CHECK ("kind" in ('badge_image')),
	CONSTRAINT "media_assets_mime_type_check" CHECK ("mime_type" in ('image/jpeg', 'image/png', 'image/webp')),
	CONSTRAINT "media_assets_size_check" CHECK ("size_bytes" between 1 and 5242880),
	CONSTRAINT "media_assets_width_check" CHECK ("width" between 1 and 8192),
	CONSTRAINT "media_assets_height_check" CHECK ("height" between 1 and 8192),
	CONSTRAINT "media_assets_alt_text_check" CHECK ("alt_text" is null or char_length("alt_text") <= 300),
	CONSTRAINT "media_assets_path_check" CHECK (
		"storage_path" ~ ('^' || "tenant_id"::text || '/[A-Za-z0-9._-]{1,120}$')
		and "storage_path" !~ '\.\.'
		and (
			("mime_type" = 'image/jpeg' and "storage_path" ~ '\.jpg$')
			or ("mime_type" = 'image/png' and "storage_path" ~ '\.png$')
			or ("mime_type" = 'image/webp' and "storage_path" ~ '\.webp$')
		)
	)
);
--> statement-breakpoint
ALTER TABLE "media_assets" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE INDEX "media_assets_store_idx" ON "media_assets" USING btree ("tenant_id", "store_id", "created_at" DESC);
--> statement-breakpoint
REVOKE ALL ON public.media_assets FROM public, anon, authenticated;
--> statement-breakpoint
GRANT SELECT, DELETE ON public.media_assets TO authenticated;
--> statement-breakpoint
GRANT INSERT (tenant_id, store_id, owner_user_id, kind, storage_path, mime_type, size_bytes, width, height, alt_text) ON public.media_assets TO authenticated;
--> statement-breakpoint
-- Finalizing records what Storage really holds (type, size) and links the attestation, once.
GRANT UPDATE (mime_type, size_bytes, alt_text, attestation_id, finalized_at) ON public.media_assets TO authenticated;
--> statement-breakpoint

CREATE POLICY media_assets_select ON public.media_assets
  FOR SELECT TO authenticated
  USING (public.has_module_access(tenant_id, 'design', 'read'));
--> statement-breakpoint
CREATE POLICY media_assets_insert ON public.media_assets
  FOR INSERT TO authenticated
  WITH CHECK (
    public.has_module_access(tenant_id, 'design', 'write')
    AND owner_user_id = (SELECT auth.uid())
  );
--> statement-breakpoint
CREATE POLICY media_assets_update ON public.media_assets
  FOR UPDATE TO authenticated
  USING (public.has_module_access(tenant_id, 'design', 'write'))
  WITH CHECK (public.has_module_access(tenant_id, 'design', 'write'));
--> statement-breakpoint
CREATE POLICY media_assets_delete ON public.media_assets
  FOR DELETE TO authenticated
  USING (public.has_module_access(tenant_id, 'design', 'write'));
--> statement-breakpoint

-- The attestation link is set once, and only to an attestation of the same store, the same person and the same file.
CREATE FUNCTION public.media_assets_before_update()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  IF OLD.attestation_id IS NOT NULL AND NEW.attestation_id IS DISTINCT FROM OLD.attestation_id THEN
    RAISE EXCEPTION 'attestation_already_linked' USING errcode = '23514';
  END IF;
  IF NEW.attestation_id IS NOT NULL AND NEW.attestation_id IS DISTINCT FROM OLD.attestation_id AND NOT EXISTS (
    SELECT 1 FROM public.attestations a
    WHERE a.id = NEW.attestation_id AND a.tenant_id = NEW.tenant_id AND a.store_id = NEW.store_id
      AND a.user_id = NEW.owner_user_id AND a.type = 'badge_upload' AND a.asset_id = NEW.id
  ) THEN
    RAISE EXCEPTION 'attestation_mismatch' USING errcode = '23514';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION public.media_assets_before_update() FROM public, anon, authenticated;
--> statement-breakpoint
CREATE TRIGGER media_assets_before_update
  BEFORE UPDATE ON public.media_assets
  FOR EACH ROW EXECUTE FUNCTION public.media_assets_before_update();
--> statement-breakpoint

-- Storage: files directly under the tenant folder are Studio media and need design:write (they used to fall into the
-- products:write branch). `{tenant}/store/...` keeps settings:write, everything deeper keeps products:write.
CREATE OR REPLACE FUNCTION public.can_write_storage_object(p_name text)
RETURNS boolean
LANGUAGE sql
STABLE
SET search_path = ''
AS $$
  SELECT public.has_module_access(
    public.storage_path_tenant(p_name),
    CASE
      WHEN split_part(p_name, '/', 2) = 'store' THEN 'settings'
      WHEN split_part(p_name, '/', 3) = '' THEN 'design'
      ELSE 'products'
    END,
    'write'
  );
$$;
--> statement-breakpoint

-- 6. Studio publish history (append-only) -------------------------------------------------------------------------
-- Rows are written inside the publish transaction by the readiness task; this migration only creates table and policies.
CREATE TABLE "studio_publishes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"store_id" uuid NOT NULL,
	"published_by" uuid NOT NULL,
	"published_at" timestamp with time zone DEFAULT now() NOT NULL,
	"items" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"warning_acknowledgements" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"readiness_summary" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"fingerprint" text,
	"studio_schema_version" integer NOT NULL,
	CONSTRAINT "studio_publishes_store_fk" FOREIGN KEY ("tenant_id", "store_id") REFERENCES "public"."stores"("tenant_id", "id") ON DELETE cascade ON UPDATE no action,
	CONSTRAINT "studio_publishes_items_check" CHECK (jsonb_typeof("items") = 'array' and octet_length("items"::text) <= 262144),
	CONSTRAINT "studio_publishes_ack_check" CHECK (jsonb_typeof("warning_acknowledgements") = 'array' and octet_length("warning_acknowledgements"::text) <= 65536),
	CONSTRAINT "studio_publishes_readiness_check" CHECK (jsonb_typeof("readiness_summary") = 'object' and octet_length("readiness_summary"::text) <= 65536),
	CONSTRAINT "studio_publishes_fingerprint_check" CHECK ("fingerprint" is null or char_length("fingerprint") between 1 and 200),
	CONSTRAINT "studio_publishes_schema_version_check" CHECK ("studio_schema_version" >= 1)
);
--> statement-breakpoint
ALTER TABLE "studio_publishes" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE INDEX "studio_publishes_store_idx" ON "studio_publishes" USING btree ("tenant_id", "store_id", "published_at" DESC);
--> statement-breakpoint
REVOKE ALL ON public.studio_publishes FROM public, anon, authenticated;
--> statement-breakpoint
GRANT SELECT ON public.studio_publishes TO authenticated;
--> statement-breakpoint
GRANT INSERT (tenant_id, store_id, published_by, items, warning_acknowledgements, readiness_summary, fingerprint, studio_schema_version) ON public.studio_publishes TO authenticated;
--> statement-breakpoint
CREATE POLICY studio_publishes_select ON public.studio_publishes
  FOR SELECT TO authenticated
  USING (public.has_module_access(tenant_id, 'design', 'read'));
--> statement-breakpoint
CREATE POLICY studio_publishes_insert ON public.studio_publishes
  FOR INSERT TO authenticated
  WITH CHECK (
    public.has_module_access(tenant_id, 'design', 'publish')
    AND published_by = (SELECT auth.uid())
  );
--> statement-breakpoint
-- The publish time is the database's, not the client's.
CREATE FUNCTION public.studio_publishes_before_insert()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = ''
AS $$
BEGIN
  NEW.published_at := now();
  RETURN NEW;
END;
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION public.studio_publishes_before_insert() FROM public, anon, authenticated;
--> statement-breakpoint
CREATE TRIGGER studio_publishes_before_insert
  BEFORE INSERT ON public.studio_publishes
  FOR EACH ROW EXECUTE FUNCTION public.studio_publishes_before_insert();
--> statement-breakpoint
CREATE TRIGGER studio_publishes_no_change
  BEFORE UPDATE OR DELETE ON public.studio_publishes
  FOR EACH ROW EXECUTE FUNCTION public.studio_history_guard();
--> statement-breakpoint
CREATE TRIGGER studio_publishes_no_truncate
  BEFORE TRUNCATE ON public.studio_publishes
  FOR EACH STATEMENT EXECUTE FUNCTION public.studio_no_truncate();
--> statement-breakpoint

-- 7. Rollout functions --------------------------------------------------------------------------------------------
-- Platform Admin: turn Studio on or off for an organization's store (its oldest store, like everywhere else). A reason
-- is required. The change, its history row and the admin audit entry are written in one transaction. Turning it off
-- never touches any other data.
CREATE FUNCTION public.platform_set_studio_rollout(p_tenant_id uuid, p_enabled boolean, p_reason text)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_store uuid;
  v_reason text := btrim(coalesce(p_reason, ''));
  v_before boolean;
  v_row public.store_studio_rollout;
BEGIN
  IF NOT public.is_platform_admin() THEN
    RAISE EXCEPTION 'not_platform_admin' USING errcode = '42501';
  END IF;
  IF p_tenant_id IS NULL OR p_enabled IS NULL OR char_length(v_reason) NOT BETWEEN 1 AND 500 THEN
    RAISE EXCEPTION 'invalid_input';
  END IF;
  SELECT s.id INTO v_store FROM public.stores s WHERE s.tenant_id = p_tenant_id ORDER BY s.created_at, s.id LIMIT 1;
  IF v_store IS NULL THEN
    RAISE EXCEPTION 'not_found';
  END IF;

  INSERT INTO public.store_studio_rollout (store_id, tenant_id) VALUES (v_store, p_tenant_id)
  ON CONFLICT (store_id) DO NOTHING;
  SELECT r.enabled INTO v_before FROM public.store_studio_rollout r WHERE r.store_id = v_store FOR UPDATE;

  UPDATE public.store_studio_rollout r
  SET enabled = p_enabled,
      enabled_at = CASE WHEN p_enabled THEN now() ELSE r.enabled_at END,
      enabled_by = CASE WHEN p_enabled THEN (SELECT auth.uid()) ELSE r.enabled_by END,
      updated_at = now()
  WHERE r.store_id = v_store
  RETURNING r.* INTO v_row;

  INSERT INTO public.store_studio_rollout_events (tenant_id, store_id, actor_id, action, reason, previous, new)
  VALUES (p_tenant_id, v_store, (SELECT auth.uid()), CASE WHEN p_enabled THEN 'enabled' ELSE 'disabled' END, v_reason,
          jsonb_build_object('enabled', v_before), jsonb_build_object('enabled', p_enabled));

  PERFORM public.platform_record_audit(
    'store.studio_rollout_changed', 'store', v_store, p_tenant_id,
    CASE WHEN p_enabled THEN 'Studio enabled for the store' ELSE 'Studio disabled for the store' END,
    jsonb_build_object('enabled', v_before),
    jsonb_build_object('enabled', p_enabled, 'reason', v_reason));

  RETURN jsonb_build_object(
    'storeId', v_store, 'enabled', v_row.enabled, 'enabledAt', v_row.enabled_at,
    'pointOfNoReturnAt', v_row.point_of_no_return_at);
END;
$$;
--> statement-breakpoint

CREATE FUNCTION public.platform_list_studio_rollout_events(p_tenant_id uuid, p_limit integer DEFAULT 20, p_offset integer DEFAULT 0)
RETURNS TABLE (
  id uuid, store_id uuid, actor_id uuid, action text, reason text, previous jsonb, new jsonb,
  created_at timestamptz, total_count bigint
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
#variable_conflict use_column
BEGIN
  IF NOT public.is_platform_admin() THEN
    RAISE EXCEPTION 'not_platform_admin' USING errcode = '42501';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.tenants t WHERE t.id = p_tenant_id) THEN
    RAISE EXCEPTION 'not_found';
  END IF;
  RETURN QUERY
  SELECT e.id, e.store_id, e.actor_id, e.action, e.reason, e.previous, e.new, e.created_at, count(*) OVER ()
  FROM public.store_studio_rollout_events e
  WHERE e.tenant_id = p_tenant_id
  ORDER BY e.created_at DESC, e.id DESC
  LIMIT least(greatest(coalesce(p_limit, 20), 1), 100)
  OFFSET greatest(coalesce(p_offset, 0), 0);
END;
$$;
--> statement-breakpoint

-- A member reads their own organization's state (no row = disabled). The API narrows this with design:view.
CREATE FUNCTION public.studio_rollout_status(p_tenant_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_store uuid;
  v_enabled boolean;
  v_ponr timestamptz;
BEGIN
  IF NOT public.is_tenant_member(p_tenant_id) THEN
    RAISE EXCEPTION 'forbidden' USING errcode = '42501';
  END IF;
  SELECT s.id INTO v_store FROM public.stores s WHERE s.tenant_id = p_tenant_id ORDER BY s.created_at, s.id LIMIT 1;
  IF v_store IS NULL THEN
    RAISE EXCEPTION 'not_found';
  END IF;
  SELECT r.enabled, r.point_of_no_return_at INTO v_enabled, v_ponr FROM public.store_studio_rollout r WHERE r.store_id = v_store;
  RETURN jsonb_build_object('storeId', v_store, 'enabled', coalesce(v_enabled, false), 'pointOfNoReturnAt', v_ponr);
END;
$$;
--> statement-breakpoint

-- 8. Legal functions ----------------------------------------------------------------------------------------------
-- Platform Admin: add the next version of a wording. Approved wording can never be edited afterwards.
CREATE FUNCTION public.platform_create_legal_wording(p_key text, p_language_tag text, p_text text, p_status text DEFAULT 'draft')
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_version integer;
  v_row public.legal_wordings;
BEGIN
  IF NOT public.is_platform_admin() THEN
    RAISE EXCEPTION 'not_platform_admin' USING errcode = '42501';
  END IF;
  IF p_status IS NULL OR p_status NOT IN ('draft', 'approved') OR p_key IS NULL OR p_language_tag IS NULL OR p_text IS NULL THEN
    RAISE EXCEPTION 'invalid_input';
  END IF;
  PERFORM pg_advisory_xact_lock(hashtext('legal_wordings:' || p_key));
  SELECT coalesce(max(w.version), 0) + 1 INTO v_version FROM public.legal_wordings w WHERE w.key = p_key;
  INSERT INTO public.legal_wordings (key, version, language_tag, "text", status, created_by)
  VALUES (p_key, v_version, p_language_tag, p_text, p_status, (SELECT auth.uid()))
  RETURNING * INTO v_row;
  RETURN jsonb_build_object(
    'id', v_row.id, 'key', v_row.key, 'version', v_row.version, 'languageTag', v_row.language_tag,
    'text', v_row."text", 'status', v_row.status, 'createdAt', v_row.created_at);
END;
$$;
--> statement-breakpoint

-- Platform Admin: record that legal approved a feature against an approved wording version. The only way to create an
-- approval row; nothing in the migrations creates one.
CREATE FUNCTION public.platform_record_feature_approval(
  p_feature_key text, p_wording_key text, p_wording_version integer, p_approver_ref text, p_approved_at timestamptz, p_release text)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_row public.feature_approvals;
BEGIN
  IF NOT public.is_platform_admin() THEN
    RAISE EXCEPTION 'not_platform_admin' USING errcode = '42501';
  END IF;
  IF p_feature_key IS NULL OR p_wording_key IS NULL OR p_wording_version IS NULL OR p_approver_ref IS NULL
     OR p_approved_at IS NULL OR p_release IS NULL OR p_approved_at > now() + interval '5 minutes' THEN
    RAISE EXCEPTION 'invalid_input';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.legal_wordings w WHERE w.key = p_wording_key AND w.version = p_wording_version AND w.status = 'approved') THEN
    RAISE EXCEPTION 'wording_not_approved' USING errcode = '23514';
  END IF;
  INSERT INTO public.feature_approvals (feature_key, wording_key, wording_version, approver_ref, approved_at, release, recorded_by)
  VALUES (p_feature_key, p_wording_key, p_wording_version, btrim(p_approver_ref), p_approved_at, btrim(p_release), (SELECT auth.uid()))
  RETURNING * INTO v_row;
  RETURN jsonb_build_object(
    'id', v_row.id, 'featureKey', v_row.feature_key, 'wordingKey', v_row.wording_key,
    'wordingVersion', v_row.wording_version, 'approverRef', v_row.approver_ref,
    'approvedAt', v_row.approved_at, 'release', v_row.release, 'createdAt', v_row.created_at);
END;
$$;
--> statement-breakpoint

-- Is the feature legally approved? True only when an approval row exists whose wording is still approved.
CREATE FUNCTION public.is_feature_approved(p_feature_key text)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
  SELECT EXISTS (
    SELECT 1
    FROM public.feature_approvals a
    JOIN public.legal_wordings w ON w.key = a.wording_key AND w.version = a.wording_version
    WHERE a.feature_key = p_feature_key AND w.status = 'approved'
  );
$$;
--> statement-breakpoint

-- The newest approved version of a wording, for any signed-in member (or Platform Admin). NULL when none is approved.
CREATE FUNCTION public.get_approved_legal_wording(p_key text)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_row public.legal_wordings;
BEGIN
  IF NOT (
    public.is_platform_admin()
    OR EXISTS (SELECT 1 FROM public.memberships m WHERE m.user_id = (SELECT auth.uid()) AND m.status = 'active')
  ) THEN
    RAISE EXCEPTION 'forbidden' USING errcode = '42501';
  END IF;
  SELECT w.* INTO v_row FROM public.legal_wordings w WHERE w.key = p_key AND w.status = 'approved' ORDER BY w.version DESC LIMIT 1;
  IF v_row.id IS NULL THEN
    RETURN NULL;
  END IF;
  RETURN jsonb_build_object(
    'id', v_row.id, 'key', v_row.key, 'version', v_row.version, 'languageTag', v_row.language_tag,
    'text', v_row."text", 'status', v_row.status, 'createdAt', v_row.created_at);
END;
$$;
--> statement-breakpoint

-- The exact wording version an attestation will record: only approved wording resolves. Any signed-in member.
CREATE FUNCTION public.resolve_approved_legal_wording(p_key text, p_version integer)
RETURNS uuid
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM public.memberships m WHERE m.user_id = (SELECT auth.uid()) AND m.status = 'active') THEN
    RAISE EXCEPTION 'forbidden' USING errcode = '42501';
  END IF;
  RETURN (SELECT w.id FROM public.legal_wordings w WHERE w.key = p_key AND w.version = p_version AND w.status = 'approved');
END;
$$;
--> statement-breakpoint

REVOKE ALL ON FUNCTION public.platform_set_studio_rollout(uuid, boolean, text) FROM public, anon;
--> statement-breakpoint
REVOKE ALL ON FUNCTION public.platform_list_studio_rollout_events(uuid, integer, integer) FROM public, anon;
--> statement-breakpoint
REVOKE ALL ON FUNCTION public.studio_rollout_status(uuid) FROM public, anon;
--> statement-breakpoint
REVOKE ALL ON FUNCTION public.platform_create_legal_wording(text, text, text, text) FROM public, anon;
--> statement-breakpoint
REVOKE ALL ON FUNCTION public.platform_record_feature_approval(text, text, integer, text, timestamptz, text) FROM public, anon;
--> statement-breakpoint
REVOKE ALL ON FUNCTION public.is_feature_approved(text) FROM public, anon;
--> statement-breakpoint
REVOKE ALL ON FUNCTION public.get_approved_legal_wording(text) FROM public, anon;
--> statement-breakpoint
REVOKE ALL ON FUNCTION public.resolve_approved_legal_wording(text, integer) FROM public, anon;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION public.platform_set_studio_rollout(uuid, boolean, text) TO authenticated;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION public.platform_list_studio_rollout_events(uuid, integer, integer) TO authenticated;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION public.studio_rollout_status(uuid) TO authenticated;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION public.platform_create_legal_wording(text, text, text, text) TO authenticated;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION public.platform_record_feature_approval(text, text, integer, text, timestamptz, text) TO authenticated;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION public.is_feature_approved(text) TO authenticated;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION public.get_approved_legal_wording(text) TO authenticated;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION public.resolve_approved_legal_wording(text, integer) TO authenticated;
