-- Custom migration: Platform Admin management, usage analytics, support notes and platform settings.
--
--   * platform_admins gets a role (super_admin | admin) and a created_by. Only a super admin can add, change or remove
--     admins or edit the platform settings, and the LAST super admin can never be removed or demoted. Every admin that
--     exists today becomes a super admin, so nobody loses access.
--   * Usage functions return AGGREGATES only (counts, bytes, timestamps): no merchant record is ever returned.
--   * organization_support_notes: internal notes, unreachable by organizations (no grants, no policies).
--   * platform_settings: one row of values that used to be hardcoded, applied when organizations and stores are created.
-- Every function pins search_path, authorises the caller first, takes no caller-supplied identity, and is revoked from public/anon.

-- Platform Admin roles --------------------------------------------------------------------------------------
ALTER TABLE "platform_admins" ADD COLUMN "role" text DEFAULT 'admin' NOT NULL;
--> statement-breakpoint
ALTER TABLE "platform_admins" ADD COLUMN "created_by" uuid;
--> statement-breakpoint
ALTER TABLE "platform_admins" ADD CONSTRAINT "platform_admins_role_check" CHECK ("platform_admins"."role" in ('super_admin', 'admin'));
--> statement-breakpoint
UPDATE public.platform_admins SET role = 'super_admin';
--> statement-breakpoint

CREATE FUNCTION public.is_super_admin()
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
  SELECT EXISTS (SELECT 1 FROM public.platform_admins pa WHERE pa.user_id = (SELECT auth.uid()) AND pa.role = 'super_admin');
$$;
--> statement-breakpoint

-- The caller's own level ('super_admin', 'admin') or NULL when they are not a Platform Admin.
CREATE FUNCTION public.platform_admin_role()
RETURNS text
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
  SELECT pa.role FROM public.platform_admins pa WHERE pa.user_id = (SELECT auth.uid());
$$;
--> statement-breakpoint

CREATE FUNCTION public.platform_list_admins()
RETURNS TABLE (user_id uuid, email text, full_name text, role text, created_at timestamptz, created_by uuid, created_by_email text)
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
  RETURN QUERY
  SELECT pa.user_id, u.email::text, p.full_name, pa.role, pa.created_at, pa.created_by, cb.email::text
  FROM public.platform_admins pa
  JOIN auth.users u ON u.id = pa.user_id
  LEFT JOIN public.profiles p ON p.id = pa.user_id
  LEFT JOIN auth.users cb ON cb.id = pa.created_by
  ORDER BY (pa.role = 'super_admin') DESC, pa.created_at, pa.user_id;
END;
$$;
--> statement-breakpoint

-- Makes an EXISTING account (created by the server just before) a Platform Admin. The membership trigger still refuses
-- anyone who belongs to an organization. created_by is always the caller.
CREATE FUNCTION public.platform_add_admin(p_user_id uuid, p_role text)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  IF NOT public.is_super_admin() THEN
    RAISE EXCEPTION 'not_super_admin' USING errcode = '42501';
  END IF;
  IF p_user_id IS NULL OR p_role IS NULL OR p_role NOT IN ('super_admin', 'admin') THEN
    RAISE EXCEPTION 'invalid_input';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM auth.users u WHERE u.id = p_user_id) THEN
    RAISE EXCEPTION 'not_found';
  END IF;
  IF EXISTS (SELECT 1 FROM public.platform_admins pa WHERE pa.user_id = p_user_id) THEN
    RAISE EXCEPTION 'already_admin';
  END IF;
  INSERT INTO public.platform_admins (user_id, role, created_by) VALUES (p_user_id, p_role, (SELECT auth.uid()));
END;
$$;
--> statement-breakpoint

-- Changes a level. Returns the previous one. The last super admin cannot be demoted.
CREATE FUNCTION public.platform_set_admin_role(p_user_id uuid, p_role text)
RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_prev text;
  v_supers integer;
BEGIN
  IF NOT public.is_super_admin() THEN
    RAISE EXCEPTION 'not_super_admin' USING errcode = '42501';
  END IF;
  IF p_user_id IS NULL OR p_role IS NULL OR p_role NOT IN ('super_admin', 'admin') THEN
    RAISE EXCEPTION 'invalid_input';
  END IF;
  -- Serialise changes to the set of super admins so two demotions cannot both pass the check.
  PERFORM 1 FROM public.platform_admins pa WHERE pa.role = 'super_admin' FOR UPDATE;
  SELECT pa.role INTO v_prev FROM public.platform_admins pa WHERE pa.user_id = p_user_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'not_found';
  END IF;
  IF v_prev = 'super_admin' AND p_role <> 'super_admin' THEN
    SELECT count(*) INTO v_supers FROM public.platform_admins pa WHERE pa.role = 'super_admin';
    IF v_supers <= 1 THEN
      RAISE EXCEPTION 'last_super_admin';
    END IF;
  END IF;
  UPDATE public.platform_admins SET role = p_role WHERE user_id = p_user_id;
  RETURN v_prev;
END;
$$;
--> statement-breakpoint

-- Removes Platform Admin access (also for yourself) unless that would leave no super admin.
CREATE FUNCTION public.platform_remove_admin(p_user_id uuid)
RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_role text;
  v_supers integer;
BEGIN
  IF NOT public.is_super_admin() THEN
    RAISE EXCEPTION 'not_super_admin' USING errcode = '42501';
  END IF;
  PERFORM 1 FROM public.platform_admins pa WHERE pa.role = 'super_admin' FOR UPDATE;
  SELECT pa.role INTO v_role FROM public.platform_admins pa WHERE pa.user_id = p_user_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'not_found';
  END IF;
  IF v_role = 'super_admin' THEN
    SELECT count(*) INTO v_supers FROM public.platform_admins pa WHERE pa.role = 'super_admin';
    IF v_supers <= 1 THEN
      RAISE EXCEPTION 'last_super_admin';
    END IF;
  END IF;
  DELETE FROM public.platform_admins WHERE user_id = p_user_id;
  RETURN v_role;
END;
$$;
--> statement-breakpoint

-- Support notes ---------------------------------------------------------------------------------------------
CREATE TABLE "organization_support_notes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"author_id" uuid NOT NULL,
	"author_email" text NOT NULL,
	"body" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "organization_support_notes_body_check" CHECK (char_length(btrim("organization_support_notes"."body")) between 1 and 2000)
);
--> statement-breakpoint
ALTER TABLE "organization_support_notes" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "organization_support_notes" ADD CONSTRAINT "organization_support_notes_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
CREATE INDEX "organization_support_notes_tenant_idx" ON "organization_support_notes" USING btree ("tenant_id", "created_at" DESC);
--> statement-breakpoint
CREATE INDEX "organization_support_notes_created_idx" ON "organization_support_notes" USING btree ("created_at" DESC);
--> statement-breakpoint
-- No grants and no policies: an organization (or any signed-in user) cannot read or write notes.
REVOKE ALL ON public.organization_support_notes FROM public, anon, authenticated;
--> statement-breakpoint
CREATE TRIGGER organization_support_notes_set_updated_at BEFORE UPDATE ON public.organization_support_notes
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();
--> statement-breakpoint

CREATE FUNCTION public.platform_add_support_note(p_tenant_id uuid, p_body text)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_admin uuid := (SELECT auth.uid());
  v_email text;
  v_id uuid;
BEGIN
  IF NOT public.is_platform_admin() THEN
    RAISE EXCEPTION 'not_platform_admin' USING errcode = '42501';
  END IF;
  IF p_tenant_id IS NULL OR char_length(btrim(coalesce(p_body, ''))) NOT BETWEEN 1 AND 2000 THEN
    RAISE EXCEPTION 'invalid_input';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.tenants t WHERE t.id = p_tenant_id) THEN
    RAISE EXCEPTION 'not_found';
  END IF;
  SELECT u.email::text INTO v_email FROM auth.users u WHERE u.id = v_admin;
  INSERT INTO public.organization_support_notes (tenant_id, author_id, author_email, body)
  VALUES (p_tenant_id, v_admin, coalesce(v_email, ''), btrim(p_body))
  RETURNING id INTO v_id;
  RETURN v_id;
END;
$$;
--> statement-breakpoint

-- Only the author can edit a note. Returns the organization and the previous text, for the audit entry.
CREATE FUNCTION public.platform_update_support_note(p_note_id uuid, p_body text)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_note public.organization_support_notes%ROWTYPE;
BEGIN
  IF NOT public.is_platform_admin() THEN
    RAISE EXCEPTION 'not_platform_admin' USING errcode = '42501';
  END IF;
  IF p_note_id IS NULL OR char_length(btrim(coalesce(p_body, ''))) NOT BETWEEN 1 AND 2000 THEN
    RAISE EXCEPTION 'invalid_input';
  END IF;
  SELECT * INTO v_note FROM public.organization_support_notes n WHERE n.id = p_note_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'not_found';
  END IF;
  IF v_note.author_id <> (SELECT auth.uid()) THEN
    RAISE EXCEPTION 'not_note_author' USING errcode = '42501';
  END IF;
  UPDATE public.organization_support_notes SET body = btrim(p_body) WHERE id = p_note_id;
  RETURN jsonb_build_object('tenant_id', v_note.tenant_id, 'previous_body', v_note.body);
END;
$$;
--> statement-breakpoint

-- Notes, newest first: one organization, or all of them (the Support page). p_search matches the organization name or the note.
CREATE FUNCTION public.platform_list_support_notes(p_tenant_id uuid DEFAULT NULL, p_search text DEFAULT NULL, p_limit integer DEFAULT 20, p_offset integer DEFAULT 0)
RETURNS TABLE (id uuid, tenant_id uuid, tenant_name text, author_id uuid, author_email text, body text, created_at timestamptz, updated_at timestamptz, total_count bigint)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
#variable_conflict use_column
DECLARE
  v_pattern text;
BEGIN
  IF NOT public.is_platform_admin() THEN
    RAISE EXCEPTION 'not_platform_admin' USING errcode = '42501';
  END IF;
  v_pattern := CASE
    WHEN nullif(btrim(p_search), '') IS NULL THEN NULL
    ELSE '%' || replace(replace(replace(btrim(p_search), '\', '\\'), '%', '\%'), '_', '\_') || '%'
  END;
  RETURN QUERY
  SELECT n.id, n.tenant_id, t.name, n.author_id, n.author_email, n.body, n.created_at, n.updated_at, count(*) OVER ()
  FROM public.organization_support_notes n
  JOIN public.tenants t ON t.id = n.tenant_id
  WHERE (p_tenant_id IS NULL OR n.tenant_id = p_tenant_id)
    AND (v_pattern IS NULL OR t.name ILIKE v_pattern OR n.body ILIKE v_pattern)
  ORDER BY n.created_at DESC, n.id DESC
  LIMIT least(greatest(coalesce(p_limit, 20), 1), 100)
  OFFSET greatest(coalesce(p_offset, 0), 0);
END;
$$;
--> statement-breakpoint

-- Usage (aggregates only) ---------------------------------------------------------------------------------
-- Bytes in the products bucket under this organization's folder. NULL (not 0) when Storage is not available at all.
CREATE FUNCTION public.tenant_storage_bytes(p_tenant_id uuid)
RETURNS bigint
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v bigint;
BEGIN
  IF to_regclass('storage.objects') IS NULL THEN
    RETURN NULL;
  END IF;
  EXECUTE 'SELECT coalesce(sum((o.metadata ->> ''size'')::bigint), 0) FROM storage.objects o WHERE o.bucket_id = ''products'' AND o.name LIKE $1'
    INTO v USING p_tenant_id::text || '/%';
  RETURN v;
END;
$$;
--> statement-breakpoint

-- True when merchant data of this organization changed since p_since: products, customers, orders, stock, categories or
-- collections. Platform Admin edits to the organization or store do not count.
CREATE FUNCTION public.tenant_has_activity_since(p_tenant_id uuid, p_since timestamptz)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
  SELECT EXISTS (SELECT 1 FROM public.products x WHERE x.tenant_id = p_tenant_id AND x.updated_at >= p_since)
      OR EXISTS (SELECT 1 FROM public.customers x WHERE x.tenant_id = p_tenant_id AND x.updated_at >= p_since)
      OR EXISTS (SELECT 1 FROM public.orders x WHERE x.tenant_id = p_tenant_id AND x.placed_at >= p_since)
      OR EXISTS (SELECT 1 FROM public.inventory_adjustments x WHERE x.tenant_id = p_tenant_id AND x.created_at >= p_since)
      OR EXISTS (SELECT 1 FROM public.categories x WHERE x.tenant_id = p_tenant_id AND x.updated_at >= p_since)
      OR EXISTS (SELECT 1 FROM public.collections x WHERE x.tenant_id = p_tenant_id AND x.updated_at >= p_since);
$$;
--> statement-breakpoint

-- Most recent such change, or NULL when there has been none.
CREATE FUNCTION public.tenant_last_activity(p_tenant_id uuid)
RETURNS timestamptz
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
  SELECT max(t) FROM (
    SELECT max(x.updated_at) AS t FROM public.products x WHERE x.tenant_id = p_tenant_id
    UNION ALL SELECT max(x.updated_at) FROM public.customers x WHERE x.tenant_id = p_tenant_id
    UNION ALL SELECT max(x.placed_at) FROM public.orders x WHERE x.tenant_id = p_tenant_id
    UNION ALL SELECT max(x.created_at) FROM public.inventory_adjustments x WHERE x.tenant_id = p_tenant_id
    UNION ALL SELECT max(x.updated_at) FROM public.categories x WHERE x.tenant_id = p_tenant_id
    UNION ALL SELECT max(x.updated_at) FROM public.collections x WHERE x.tenant_id = p_tenant_id
  ) a;
$$;
--> statement-breakpoint

CREATE FUNCTION public.platform_tenant_usage(p_tenant_id uuid)
RETURNS TABLE (products bigint, customers bigint, orders bigint, storage_bytes bigint, last_activity timestamptz, created_at timestamptz, status text)
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
  RETURN QUERY
  SELECT (SELECT count(*) FROM public.products x WHERE x.tenant_id = t.id),
         (SELECT count(*) FROM public.customers x WHERE x.tenant_id = t.id),
         (SELECT count(*) FROM public.orders x WHERE x.tenant_id = t.id),
         public.tenant_storage_bytes(t.id),
         public.tenant_last_activity(t.id),
         t.created_at, t.status
  FROM public.tenants t WHERE t.id = p_tenant_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'not_found';
  END IF;
END;
$$;
--> statement-breakpoint

-- One page of organizations with their usage. Same search / status / sort rules as platform_list_tenants_page; the usage
-- numbers are computed for the rows of the page only.
CREATE FUNCTION public.platform_usage_page(
  p_search text DEFAULT NULL, p_status text DEFAULT NULL, p_sort text DEFAULT 'created_desc', p_limit integer DEFAULT 20, p_offset integer DEFAULT 0
)
RETURNS TABLE (
  id uuid, name text, slug text, status text, created_at timestamptz,
  products bigint, customers bigint, orders bigint, storage_bytes bigint, last_activity timestamptz, total_count bigint
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
#variable_conflict use_column
DECLARE
  v_pattern text;
  v_limit integer;
  v_offset integer;
BEGIN
  IF NOT public.is_platform_admin() THEN
    RAISE EXCEPTION 'not_platform_admin' USING errcode = '42501';
  END IF;
  IF p_status IS NOT NULL AND p_status NOT IN ('active', 'suspended') THEN
    RAISE EXCEPTION 'invalid_input';
  END IF;
  IF p_sort IS NULL OR p_sort NOT IN ('created_desc', 'created_asc', 'name_asc', 'name_desc') THEN
    RAISE EXCEPTION 'invalid_input';
  END IF;
  v_limit := least(greatest(coalesce(p_limit, 20), 1), 100);
  v_offset := greatest(coalesce(p_offset, 0), 0);
  v_pattern := CASE
    WHEN nullif(btrim(p_search), '') IS NULL THEN NULL
    ELSE '%' || replace(replace(replace(btrim(p_search), '\', '\\'), '%', '\%'), '_', '\_') || '%'
  END;
  RETURN QUERY
  WITH filtered AS (
    SELECT t.id, t.name, t.slug, t.status, t.created_at,
           count(*) OVER () AS total_count,
           row_number() OVER (
             ORDER BY
               CASE WHEN p_sort = 'name_asc' THEN lower(t.name) END ASC,
               CASE WHEN p_sort = 'name_desc' THEN lower(t.name) END DESC,
               CASE WHEN p_sort = 'created_asc' THEN t.created_at END ASC,
               CASE WHEN p_sort = 'created_desc' THEN t.created_at END DESC,
               t.id
           ) AS ord
    FROM public.tenants t
    WHERE (p_status IS NULL OR t.status = p_status)
      AND (v_pattern IS NULL OR t.name ILIKE v_pattern OR t.slug ILIKE v_pattern)
  ),
  page AS (
    SELECT * FROM filtered f WHERE f.ord > v_offset AND f.ord <= v_offset + v_limit
  )
  SELECT pg.id, pg.name, pg.slug, pg.status, pg.created_at,
         (SELECT count(*) FROM public.products x WHERE x.tenant_id = pg.id),
         (SELECT count(*) FROM public.customers x WHERE x.tenant_id = pg.id),
         (SELECT count(*) FROM public.orders x WHERE x.tenant_id = pg.id),
         public.tenant_storage_bytes(pg.id),
         public.tenant_last_activity(pg.id),
         pg.total_count
  FROM page pg
  ORDER BY pg.ord;
END;
$$;
--> statement-breakpoint

-- Platform totals. inactive_orgs: created before the cutoff and with no merchant activity since it (a brand-new organization
-- is not "inactive"). storage_total_bytes is NULL when Storage is not available.
CREATE FUNCTION public.platform_usage_summary(p_inactive_days integer DEFAULT 30)
RETURNS TABLE (total_orgs bigint, active_orgs bigint, suspended_orgs bigint, inactive_orgs bigint, storage_total_bytes bigint)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_cutoff timestamptz := now() - make_interval(days => least(greatest(coalesce(p_inactive_days, 30), 1), 3650));
  v_storage bigint;
BEGIN
  IF NOT public.is_platform_admin() THEN
    RAISE EXCEPTION 'not_platform_admin' USING errcode = '42501';
  END IF;
  IF to_regclass('storage.objects') IS NOT NULL THEN
    EXECUTE 'SELECT coalesce(sum((o.metadata ->> ''size'')::bigint), 0) FROM storage.objects o WHERE o.bucket_id = ''products''' INTO v_storage;
  END IF;
  RETURN QUERY
  SELECT count(*),
         count(*) FILTER (WHERE t.status = 'active'),
         count(*) FILTER (WHERE t.status = 'suspended'),
         count(*) FILTER (WHERE t.created_at < v_cutoff AND NOT public.tenant_has_activity_since(t.id, v_cutoff)),
         v_storage
  FROM public.tenants t;
END;
$$;
--> statement-breakpoint

-- Organizations with no recent merchant activity, least active first (never active ones first).
CREATE FUNCTION public.platform_inactive_organizations(p_days integer DEFAULT 30, p_limit integer DEFAULT 10, p_offset integer DEFAULT 0)
RETURNS TABLE (id uuid, name text, slug text, status text, created_at timestamptz, last_activity timestamptz, total_count bigint)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
#variable_conflict use_column
DECLARE
  v_cutoff timestamptz := now() - make_interval(days => least(greatest(coalesce(p_days, 30), 1), 3650));
BEGIN
  IF NOT public.is_platform_admin() THEN
    RAISE EXCEPTION 'not_platform_admin' USING errcode = '42501';
  END IF;
  RETURN QUERY
  WITH idle AS (
    SELECT t.id, t.name, t.slug, t.status, t.created_at, public.tenant_last_activity(t.id) AS last_activity
    FROM public.tenants t
    WHERE t.created_at < v_cutoff AND NOT public.tenant_has_activity_since(t.id, v_cutoff)
  )
  SELECT i.id, i.name, i.slug, i.status, i.created_at, i.last_activity, count(*) OVER ()
  FROM idle i
  ORDER BY i.last_activity ASC NULLS FIRST, i.created_at ASC, i.id
  LIMIT least(greatest(coalesce(p_limit, 10), 1), 100)
  OFFSET greatest(coalesce(p_offset, 0), 0);
END;
$$;
--> statement-breakpoint

-- Organizations created per day / week / month, zero-filled, between two dates (both inclusive).
CREATE FUNCTION public.platform_new_organizations_series(p_from date, p_to date, p_bucket text DEFAULT 'day')
RETURNS TABLE (bucket_start date, created bigint)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_first timestamp;
  v_last timestamp;
  v_step interval;
BEGIN
  IF NOT public.is_platform_admin() THEN
    RAISE EXCEPTION 'not_platform_admin' USING errcode = '42501';
  END IF;
  IF p_from IS NULL OR p_to IS NULL OR p_to < p_from OR p_bucket IS NULL OR p_bucket NOT IN ('day', 'week', 'month') THEN
    RAISE EXCEPTION 'invalid_input';
  END IF;
  v_step := ('1 ' || p_bucket)::interval;
  v_first := date_trunc(p_bucket, p_from::timestamp);
  v_last := date_trunc(p_bucket, p_to::timestamp);
  IF ((SELECT count(*) FROM generate_series(v_first, v_last, v_step))) > 400 THEN
    RAISE EXCEPTION 'invalid_input';
  END IF;
  RETURN QUERY
  SELECT b.start::date, count(t.id)
  FROM generate_series(v_first, v_last, v_step) AS b(start)
  LEFT JOIN public.tenants t
    ON t.created_at >= (b.start AT TIME ZONE 'UTC') AND t.created_at < ((b.start + v_step) AT TIME ZONE 'UTC')
  GROUP BY b.start
  ORDER BY b.start;
END;
$$;
--> statement-breakpoint

-- Platform settings ---------------------------------------------------------------------------------------
CREATE FUNCTION public.is_valid_reserved_subdomains(p text[])
RETURNS boolean
LANGUAGE sql
IMMUTABLE
SET search_path = ''
AS $$
  SELECT p IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM unnest(p) AS s WHERE s IS NULL OR s !~ '^[a-z0-9][a-z0-9-]{0,38}[a-z0-9]$' OR s ~ '--'
  );
$$;
--> statement-breakpoint
CREATE TABLE "platform_settings" (
	"id" boolean PRIMARY KEY DEFAULT true NOT NULL,
	"platform_name" text DEFAULT 'StoreForge' NOT NULL,
	"support_email" text,
	"default_currency" text DEFAULT 'INR' NOT NULL,
	"default_timezone" text DEFAULT 'Asia/Kolkata' NOT NULL,
	"default_store_status" text DEFAULT 'active' NOT NULL,
	"reserved_subdomains" text[] DEFAULT '{}'::text[] NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" uuid,
	CONSTRAINT "platform_settings_singleton_check" CHECK ("platform_settings"."id"),
	CONSTRAINT "platform_settings_name_check" CHECK (char_length(btrim("platform_settings"."platform_name")) between 2 and 60),
	CONSTRAINT "platform_settings_support_email_check" CHECK ("platform_settings"."support_email" is null or (char_length("platform_settings"."support_email") <= 254 and position('@' in "platform_settings"."support_email") > 1)),
	CONSTRAINT "platform_settings_currency_check" CHECK ("platform_settings"."default_currency" ~ '^[A-Z]{3}$'),
	CONSTRAINT "platform_settings_store_status_check" CHECK ("platform_settings"."default_store_status" in ('active', 'inactive')),
	CONSTRAINT "platform_settings_reserved_check" CHECK (cardinality("platform_settings"."reserved_subdomains") <= 200 and public.is_valid_reserved_subdomains("platform_settings"."reserved_subdomains"))
);
--> statement-breakpoint
ALTER TABLE "platform_settings" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
REVOKE ALL ON public.platform_settings FROM public, anon, authenticated;
--> statement-breakpoint
INSERT INTO public.platform_settings DEFAULT VALUES;
--> statement-breakpoint

CREATE FUNCTION public.get_platform_settings()
RETURNS TABLE (
  platform_name text, support_email text, default_currency text, default_timezone text, default_store_status text,
  reserved_subdomains text[], updated_at timestamptz, updated_by_email text
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
  RETURN QUERY
  SELECT s.platform_name, s.support_email, s.default_currency, s.default_timezone, s.default_store_status,
         s.reserved_subdomains, s.updated_at, u.email::text
  FROM public.platform_settings s
  LEFT JOIN auth.users u ON u.id = s.updated_by;
END;
$$;
--> statement-breakpoint

-- Public branding only: the platform name and a support contact. Safe for signed-out pages (called with no user).
CREATE FUNCTION public.get_public_platform_settings()
RETURNS TABLE (platform_name text, support_email text)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
  SELECT s.platform_name, s.support_email FROM public.platform_settings s;
$$;
--> statement-breakpoint

-- Super admins only. Everything is validated here as well as in the app; reserved names are lower-cased, de-duplicated and
-- must be valid store addresses. They are ADDED to the built-in reserved list, which can never shrink.
CREATE FUNCTION public.platform_update_settings(
  p_platform_name text, p_support_email text, p_default_currency text, p_default_timezone text,
  p_default_store_status text, p_reserved_subdomains text[]
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_reserved text[];
  v_email text := nullif(btrim(coalesce(p_support_email, '')), '');
BEGIN
  IF NOT public.is_super_admin() THEN
    RAISE EXCEPTION 'not_super_admin' USING errcode = '42501';
  END IF;
  IF char_length(btrim(coalesce(p_platform_name, ''))) NOT BETWEEN 2 AND 60
     OR btrim(coalesce(p_default_currency, '')) = '' OR btrim(coalesce(p_default_timezone, '')) = ''
     OR p_default_store_status IS NULL OR p_default_store_status NOT IN ('active', 'inactive')
     OR (v_email IS NOT NULL AND (char_length(v_email) > 254 OR position('@' in v_email) <= 1)) THEN
    RAISE EXCEPTION 'invalid_input';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_timezone_names z WHERE z.name = btrim(p_default_timezone)) THEN
    RAISE EXCEPTION 'invalid_input';
  END IF;
  SELECT coalesce(array_agg(q.v ORDER BY q.v), '{}') INTO v_reserved
  FROM (SELECT DISTINCT lower(btrim(x)) AS v FROM unnest(coalesce(p_reserved_subdomains, '{}')) AS x WHERE btrim(x) <> '') q;
  IF cardinality(v_reserved) > 200 OR NOT public.is_valid_reserved_subdomains(v_reserved) THEN
    RAISE EXCEPTION 'invalid_input';
  END IF;
  UPDATE public.platform_settings
  SET platform_name = btrim(p_platform_name), support_email = v_email, default_currency = upper(btrim(p_default_currency)),
      default_timezone = btrim(p_default_timezone), default_store_status = p_default_store_status,
      reserved_subdomains = v_reserved, updated_at = now(), updated_by = (SELECT auth.uid())
  WHERE id;
  RETURN FOUND;
EXCEPTION WHEN check_violation THEN
  RAISE EXCEPTION 'invalid_input';
END;
$$;
--> statement-breakpoint

-- A store address is reserved when it is in the built-in list OR in the admin-managed list.
CREATE OR REPLACE FUNCTION public.is_valid_store_slug(p_slug text)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
  SELECT coalesce(
    p_slug ~ '^[a-z0-9][a-z0-9-]{1,38}[a-z0-9]$'
    AND p_slug !~ '--'
    AND p_slug <> ALL (array[
      'www', 'app', 'api', 'admin', 'dashboard', 'auth', 'login', 'register',
      'static', 'assets', 'cdn', 'mail', 'support', 'help', 'billing',
      'storeforge', 'status', 'blog', 'docs'
    ])
    AND NOT EXISTS (SELECT 1 FROM public.platform_settings s WHERE p_slug = ANY (s.reserved_subdomains)),
    false);
$$;
--> statement-breakpoint

-- Organization creation now starts the store with the platform defaults (currency, timezone, status). Same behaviour as
-- before otherwise: idempotent for the same owner and store address, atomic, Platform Admin only.
CREATE OR REPLACE FUNCTION public.platform_provision_tenant(
  p_owner_id           uuid,
  p_tenant_name        text,
  p_store_name         text,
  p_store_slug         text,
  p_store_description  text DEFAULT NULL,
  p_contact_phone      text DEFAULT NULL,
  p_address            text DEFAULT NULL
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
  v_tenant_id   uuid;
  v_store_id    uuid;
  v_tenant_slug text;
  v_currency    text := 'INR';
  v_timezone    text := 'Asia/Kolkata';
  v_status      text := 'active';
BEGIN
  IF (SELECT auth.uid()) IS NULL OR NOT public.is_platform_admin() THEN
    RAISE EXCEPTION 'not_platform_admin' USING errcode = '42501';
  END IF;

  IF p_owner_id IS NULL OR NOT EXISTS (SELECT 1 FROM auth.users u WHERE u.id = p_owner_id) THEN
    RAISE EXCEPTION 'owner_not_found';
  END IF;

  IF char_length(v_tenant_name) NOT BETWEEN 2 AND 80
     OR char_length(v_store_name) NOT BETWEEN 2 AND 80
     OR char_length(coalesce(v_description, '')) > 500
     OR (v_phone IS NOT NULL AND char_length(v_phone) NOT BETWEEN 4 AND 32)
     OR char_length(coalesce(v_address, '')) > 300 THEN
    RAISE EXCEPTION 'invalid_input';
  END IF;

  IF NOT public.is_valid_store_slug(p_store_slug) THEN
    RAISE EXCEPTION 'invalid_slug';
  END IF;

  PERFORM pg_advisory_xact_lock(hashtextextended(p_owner_id::text, 42));

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

  SELECT s.default_currency, s.default_timezone, s.default_store_status INTO v_currency, v_timezone, v_status
  FROM public.platform_settings s;

  BEGIN
    INSERT INTO public.tenants (name, slug, contact_phone, address, created_by)
    VALUES (v_tenant_name, v_tenant_slug, v_phone, v_address, p_owner_id)
    RETURNING id INTO v_tenant_id;

    INSERT INTO public.memberships (tenant_id, user_id, role)
    VALUES (v_tenant_id, p_owner_id, 'owner');

    INSERT INTO public.stores (tenant_id, name, slug, description, contact_phone, currency, timezone, status)
    VALUES (v_tenant_id, v_store_name, p_store_slug, v_description, v_phone, v_currency, v_timezone, v_status)
    RETURNING id INTO v_store_id;
  EXCEPTION WHEN unique_violation THEN
    RAISE EXCEPTION 'slug_taken';
  END;

  RETURN jsonb_build_object(
    'tenant_id', v_tenant_id, 'store_id', v_store_id,
    'store_slug', p_store_slug, 'created', true);
END;
$$;
--> statement-breakpoint

-- Privileges: admin-only functions are executable by `authenticated` (they check the caller themselves); the internal
-- helpers are not executable by anyone but the functions that call them.
REVOKE ALL ON FUNCTION public.is_super_admin() FROM public, anon;
--> statement-breakpoint
REVOKE ALL ON FUNCTION public.platform_admin_role() FROM public, anon;
--> statement-breakpoint
REVOKE ALL ON FUNCTION public.platform_list_admins() FROM public, anon;
--> statement-breakpoint
REVOKE ALL ON FUNCTION public.platform_add_admin(uuid, text) FROM public, anon;
--> statement-breakpoint
REVOKE ALL ON FUNCTION public.platform_set_admin_role(uuid, text) FROM public, anon;
--> statement-breakpoint
REVOKE ALL ON FUNCTION public.platform_remove_admin(uuid) FROM public, anon;
--> statement-breakpoint
REVOKE ALL ON FUNCTION public.platform_add_support_note(uuid, text) FROM public, anon;
--> statement-breakpoint
REVOKE ALL ON FUNCTION public.platform_update_support_note(uuid, text) FROM public, anon;
--> statement-breakpoint
REVOKE ALL ON FUNCTION public.platform_list_support_notes(uuid, text, integer, integer) FROM public, anon;
--> statement-breakpoint
REVOKE ALL ON FUNCTION public.tenant_storage_bytes(uuid) FROM public, anon, authenticated;
--> statement-breakpoint
REVOKE ALL ON FUNCTION public.tenant_has_activity_since(uuid, timestamptz) FROM public, anon, authenticated;
--> statement-breakpoint
REVOKE ALL ON FUNCTION public.tenant_last_activity(uuid) FROM public, anon, authenticated;
--> statement-breakpoint
REVOKE ALL ON FUNCTION public.platform_tenant_usage(uuid) FROM public, anon;
--> statement-breakpoint
REVOKE ALL ON FUNCTION public.platform_usage_page(text, text, text, integer, integer) FROM public, anon;
--> statement-breakpoint
REVOKE ALL ON FUNCTION public.platform_usage_summary(integer) FROM public, anon;
--> statement-breakpoint
REVOKE ALL ON FUNCTION public.platform_inactive_organizations(integer, integer, integer) FROM public, anon;
--> statement-breakpoint
REVOKE ALL ON FUNCTION public.platform_new_organizations_series(date, date, text) FROM public, anon;
--> statement-breakpoint
REVOKE ALL ON FUNCTION public.is_valid_reserved_subdomains(text[]) FROM public, anon;
--> statement-breakpoint
REVOKE ALL ON FUNCTION public.get_platform_settings() FROM public, anon;
--> statement-breakpoint
REVOKE ALL ON FUNCTION public.get_public_platform_settings() FROM public, anon;
--> statement-breakpoint
REVOKE ALL ON FUNCTION public.platform_update_settings(text, text, text, text, text, text[]) FROM public, anon;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION public.is_super_admin() TO authenticated;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION public.platform_admin_role() TO authenticated;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION public.platform_list_admins() TO authenticated;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION public.platform_add_admin(uuid, text) TO authenticated;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION public.platform_set_admin_role(uuid, text) TO authenticated;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION public.platform_remove_admin(uuid) TO authenticated;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION public.platform_add_support_note(uuid, text) TO authenticated;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION public.platform_update_support_note(uuid, text) TO authenticated;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION public.platform_list_support_notes(uuid, text, integer, integer) TO authenticated;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION public.platform_tenant_usage(uuid) TO authenticated;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION public.platform_usage_page(text, text, text, integer, integer) TO authenticated;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION public.platform_usage_summary(integer) TO authenticated;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION public.platform_inactive_organizations(integer, integer, integer) TO authenticated;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION public.platform_new_organizations_series(date, date, text) TO authenticated;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION public.is_valid_reserved_subdomains(text[]) TO authenticated;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION public.get_platform_settings() TO authenticated;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION public.get_public_platform_settings() TO authenticated;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION public.platform_update_settings(text, text, text, text, text, text[]) TO authenticated;
