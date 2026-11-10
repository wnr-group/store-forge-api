-- Custom migration: Platform Admin organization list, overview statistics and audit log.
--   * platform_list_tenants_page(): search / filter / sort / paginate organizations in SQL.
--   * platform_overview_stats(): the overview counts in SQL (no need to load every organization).
--   * admin_audit_logs: append-only audit trail, written and read only through admin-only functions.
-- Every function pins search_path, authorises the caller as a Platform Admin first, and is revoked from public/anon.

CREATE INDEX "tenants_created_idx" ON "tenants" USING btree ("created_at" DESC, "id");
--> statement-breakpoint

-- Organizations: one page, with the total ----------------------------------------------------------------
-- p_search matches name or slug (case-insensitive, LIKE wildcards in the input are escaped).
-- p_status: NULL (any), 'active' or 'suspended'.  p_sort: created_desc | created_asc | name_asc | name_desc.
-- p_limit is clamped to 1..100. Only the page's rows get the owner/store lookups.
CREATE FUNCTION public.platform_list_tenants_page(
  p_search text DEFAULT NULL,
  p_status text DEFAULT NULL,
  p_sort text DEFAULT 'created_desc',
  p_limit integer DEFAULT 20,
  p_offset integer DEFAULT 0
)
RETURNS TABLE (
  id uuid, name text, slug text, status text, contact_phone text, address text, created_at timestamptz,
  store_id uuid, store_name text, store_slug text,
  owner_id uuid, owner_name text, owner_email text, member_count bigint, total_count bigint
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
    SELECT t.id, t.name, t.slug, t.status, t.contact_phone, t.address, t.created_at,
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
  SELECT pg.id, pg.name, pg.slug, pg.status, pg.contact_phone, pg.address, pg.created_at,
         s.id, s.name, s.slug,
         o.user_id, p.full_name, u.email::text,
         (SELECT count(*) FROM public.memberships mm WHERE mm.tenant_id = pg.id),
         pg.total_count
  FROM page pg
  LEFT JOIN LATERAL (
    SELECT s0.id, s0.name, s0.slug FROM public.stores s0
    WHERE s0.tenant_id = pg.id ORDER BY s0.created_at, s0.id LIMIT 1) s ON true
  LEFT JOIN LATERAL (
    SELECT m0.user_id FROM public.memberships m0
    WHERE m0.tenant_id = pg.id AND m0.role = 'owner' ORDER BY m0.created_at, m0.id LIMIT 1) o ON true
  LEFT JOIN public.profiles p ON p.id = o.user_id
  LEFT JOIN auth.users u ON u.id = o.user_id
  ORDER BY pg.ord;
END;
$$;
--> statement-breakpoint

-- Overview counts ------------------------------------------------------------------------------------------
-- total_users counts distinct people (someone in two organizations counts once).
CREATE FUNCTION public.platform_overview_stats()
RETURNS TABLE (total_tenants bigint, active_tenants bigint, suspended_tenants bigint, total_users bigint)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  IF NOT public.is_platform_admin() THEN
    RAISE EXCEPTION 'not_platform_admin' USING errcode = '42501';
  END IF;
  RETURN QUERY
  SELECT count(*),
         count(*) FILTER (WHERE t.status = 'active'),
         count(*) FILTER (WHERE t.status = 'suspended'),
         (SELECT count(DISTINCT m.user_id) FROM public.memberships m)
  FROM public.tenants t;
END;
$$;
--> statement-breakpoint

-- Audit log -----------------------------------------------------------------------------------------------
CREATE TABLE "admin_audit_logs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"admin_user_id" uuid NOT NULL,
	"admin_email" text NOT NULL,
	"action" text NOT NULL,
	"entity_type" text NOT NULL,
	"entity_id" uuid,
	"organization_id" uuid,
	"organization_name" text,
	"description" text NOT NULL,
	"previous_data" jsonb,
	"new_data" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "admin_audit_logs_action_check" CHECK ("admin_audit_logs"."action" ~ '^[a-z_]+\.[a-z_]+$'),
	CONSTRAINT "admin_audit_logs_entity_type_check" CHECK ("admin_audit_logs"."entity_type" in ('organization', 'store', 'team_member', 'platform_admin', 'support_note', 'platform_settings')),
	CONSTRAINT "admin_audit_logs_description_check" CHECK (char_length("admin_audit_logs"."description") between 1 and 500)
);
--> statement-breakpoint
ALTER TABLE "admin_audit_logs" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE INDEX "admin_audit_logs_created_idx" ON "admin_audit_logs" USING btree ("created_at" DESC, "id" DESC);
--> statement-breakpoint
CREATE INDEX "admin_audit_logs_org_idx" ON "admin_audit_logs" USING btree ("organization_id", "created_at" DESC);
--> statement-breakpoint
CREATE INDEX "admin_audit_logs_admin_idx" ON "admin_audit_logs" USING btree ("admin_user_id", "created_at" DESC);
--> statement-breakpoint
CREATE INDEX "admin_audit_logs_action_idx" ON "admin_audit_logs" USING btree ("action", "created_at" DESC);
--> statement-breakpoint
-- No grants and no policies: unreachable from the API. Only the SECURITY DEFINER functions below touch it.
REVOKE ALL ON public.admin_audit_logs FROM public, anon, authenticated;
--> statement-breakpoint

-- History cannot be edited: reject UPDATE, DELETE and TRUNCATE for everyone, the table owner included.
CREATE FUNCTION public.admin_audit_logs_immutable()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = ''
AS $$
BEGIN
  RAISE EXCEPTION 'audit_log_immutable' USING errcode = '42501';
END;
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION public.admin_audit_logs_immutable() FROM public, anon, authenticated;
--> statement-breakpoint
CREATE TRIGGER admin_audit_logs_no_change
  BEFORE UPDATE OR DELETE ON public.admin_audit_logs
  FOR EACH ROW EXECUTE FUNCTION public.admin_audit_logs_immutable();
--> statement-breakpoint
CREATE TRIGGER admin_audit_logs_no_truncate
  BEFORE TRUNCATE ON public.admin_audit_logs
  FOR EACH STATEMENT EXECUTE FUNCTION public.admin_audit_logs_immutable();
--> statement-breakpoint

-- Removes anything that looks like a credential from the JSON that goes into a log row (any depth).
CREATE FUNCTION public.audit_redact(p jsonb)
RETURNS jsonb
LANGUAGE plpgsql
IMMUTABLE
SET search_path = ''
AS $$
DECLARE
  r jsonb;
  k text;
  v jsonb;
BEGIN
  IF p IS NULL THEN
    RETURN NULL;
  END IF;
  IF jsonb_typeof(p) = 'object' THEN
    r := '{}'::jsonb;
    FOR k, v IN SELECT * FROM jsonb_each(p) LOOP
      IF k ~* '(pass|secret|token|credential|api_?key|authorization|cookie)' THEN
        r := r || jsonb_build_object(k, '[redacted]');
      ELSE
        r := r || jsonb_build_object(k, public.audit_redact(v));
      END IF;
    END LOOP;
    RETURN r;
  ELSIF jsonb_typeof(p) = 'array' THEN
    RETURN coalesce((SELECT jsonb_agg(public.audit_redact(e)) FROM jsonb_array_elements(p) AS e), '[]'::jsonb);
  END IF;
  RETURN p;
END;
$$;
--> statement-breakpoint

-- Writes one row. The administrator is ALWAYS auth.uid() (never a caller-supplied id), and the e-mail and
-- organization name are copied in so the row stays meaningful after either is deleted.
CREATE FUNCTION public.platform_record_audit(
  p_action text,
  p_entity_type text,
  p_entity_id uuid,
  p_organization_id uuid,
  p_description text,
  p_previous jsonb DEFAULT NULL,
  p_new jsonb DEFAULT NULL
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_admin uuid := (SELECT auth.uid());
  v_email text;
  v_org_name text;
  v_prev jsonb := public.audit_redact(p_previous);
  v_next jsonb := public.audit_redact(p_new);
  v_id uuid;
BEGIN
  IF NOT public.is_platform_admin() THEN
    RAISE EXCEPTION 'not_platform_admin' USING errcode = '42501';
  END IF;
  IF p_action IS NULL OR p_action !~ '^[a-z_]+\.[a-z_]+$'
     OR p_entity_type IS NULL OR p_description IS NULL OR char_length(btrim(p_description)) NOT BETWEEN 1 AND 500
     OR octet_length(coalesce(v_prev::text, '')) > 20000 OR octet_length(coalesce(v_next::text, '')) > 20000 THEN
    RAISE EXCEPTION 'invalid_input';
  END IF;
  SELECT u.email::text INTO v_email FROM auth.users u WHERE u.id = v_admin;
  IF p_organization_id IS NOT NULL THEN
    SELECT t.name INTO v_org_name FROM public.tenants t WHERE t.id = p_organization_id;
  END IF;
  INSERT INTO public.admin_audit_logs
    (admin_user_id, admin_email, action, entity_type, entity_id, organization_id, organization_name, description, previous_data, new_data)
  VALUES
    (v_admin, coalesce(v_email, ''), p_action, p_entity_type, p_entity_id, p_organization_id, v_org_name, btrim(p_description), v_prev, v_next)
  RETURNING id INTO v_id;
  RETURN v_id;
END;
$$;
--> statement-breakpoint

-- Reads a page of the log, newest first. p_org matches one organization id; p_org_search matches the organization name
-- as it was when the action happened. p_from is inclusive and p_to exclusive. p_limit is clamped to 1..100.
CREATE FUNCTION public.platform_list_audit(
  p_action text DEFAULT NULL,
  p_admin uuid DEFAULT NULL,
  p_org uuid DEFAULT NULL,
  p_org_search text DEFAULT NULL,
  p_from timestamptz DEFAULT NULL,
  p_to timestamptz DEFAULT NULL,
  p_limit integer DEFAULT 20,
  p_offset integer DEFAULT 0
)
RETURNS TABLE (
  id uuid, admin_user_id uuid, admin_email text, action text, entity_type text, entity_id uuid,
  organization_id uuid, organization_name text, description text, previous_data jsonb, new_data jsonb,
  created_at timestamptz, total_count bigint
)
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
    WHEN nullif(btrim(p_org_search), '') IS NULL THEN NULL
    ELSE '%' || replace(replace(replace(btrim(p_org_search), '\', '\\'), '%', '\%'), '_', '\_') || '%'
  END;
  RETURN QUERY
  SELECT l.id, l.admin_user_id, l.admin_email, l.action, l.entity_type, l.entity_id,
         l.organization_id, l.organization_name, l.description, l.previous_data, l.new_data,
         l.created_at, count(*) OVER ()
  FROM public.admin_audit_logs l
  WHERE (p_action IS NULL OR l.action = p_action)
    AND (p_admin IS NULL OR l.admin_user_id = p_admin)
    AND (p_org IS NULL OR l.organization_id = p_org)
    AND (v_pattern IS NULL OR l.organization_name ILIKE v_pattern)
    AND (p_from IS NULL OR l.created_at >= p_from)
    AND (p_to IS NULL OR l.created_at < p_to)
  ORDER BY l.created_at DESC, l.id DESC
  LIMIT least(greatest(coalesce(p_limit, 20), 1), 100)
  OFFSET greatest(coalesce(p_offset, 0), 0);
END;
$$;
--> statement-breakpoint

-- The administrators that appear in the log, for the filter dropdown.
CREATE FUNCTION public.platform_audit_admins()
RETURNS TABLE (admin_user_id uuid, admin_email text)
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
  SELECT DISTINCT ON (l.admin_user_id) l.admin_user_id, l.admin_email
  FROM public.admin_audit_logs l
  ORDER BY l.admin_user_id, l.created_at DESC;
END;
$$;
--> statement-breakpoint

REVOKE ALL ON FUNCTION public.platform_list_tenants_page(text, text, text, integer, integer) FROM public, anon;
--> statement-breakpoint
REVOKE ALL ON FUNCTION public.platform_overview_stats() FROM public, anon;
--> statement-breakpoint
REVOKE ALL ON FUNCTION public.audit_redact(jsonb) FROM public, anon, authenticated;
--> statement-breakpoint
REVOKE ALL ON FUNCTION public.platform_record_audit(text, text, uuid, uuid, text, jsonb, jsonb) FROM public, anon;
--> statement-breakpoint
REVOKE ALL ON FUNCTION public.platform_list_audit(text, uuid, uuid, text, timestamptz, timestamptz, integer, integer) FROM public, anon;
--> statement-breakpoint
REVOKE ALL ON FUNCTION public.platform_audit_admins() FROM public, anon;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION public.platform_list_tenants_page(text, text, text, integer, integer) TO authenticated;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION public.platform_overview_stats() TO authenticated;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION public.platform_record_audit(text, text, uuid, uuid, text, jsonb, jsonb) TO authenticated;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION public.platform_list_audit(text, uuid, uuid, text, timestamptz, timestamptz, integer, integer) TO authenticated;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION public.platform_audit_admins() TO authenticated;
