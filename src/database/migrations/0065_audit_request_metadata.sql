-- Custom migration: request metadata on the platform audit log, and an entity-type filter.
--
--   * admin_audit_logs gets ip, user_agent and request_id: where an action came from and which request it was, so an entry can be
--     matched to the application logs. They are written once with the row like every other column; the append-only triggers
--     (no UPDATE, DELETE or TRUNCATE for anyone) are unchanged and cover them. Old rows keep NULL.
--   * platform_record_audit() takes an optional metadata object ({ip, userAgent, requestId}); the 7-argument calls that already exist
--     (including the one in the Studio functions) keep working because the new parameter has a default.
--   * platform_list_audit() can filter by entity type and returns the metadata.
-- The administrator is still ALWAYS auth.uid(); metadata is descriptive and never decides anything.

ALTER TABLE "admin_audit_logs" ADD COLUMN "ip" text;
--> statement-breakpoint
ALTER TABLE "admin_audit_logs" ADD COLUMN "user_agent" text;
--> statement-breakpoint
ALTER TABLE "admin_audit_logs" ADD COLUMN "request_id" text;
--> statement-breakpoint
ALTER TABLE "admin_audit_logs" ADD CONSTRAINT "admin_audit_logs_meta_check" CHECK (("ip" is null or char_length("ip") <= 64) and ("user_agent" is null or char_length("user_agent") <= 300) and ("request_id" is null or char_length("request_id") <= 100));
--> statement-breakpoint

DROP FUNCTION public.platform_record_audit(text, text, uuid, uuid, text, jsonb, jsonb);
--> statement-breakpoint
CREATE FUNCTION public.platform_record_audit(
  p_action text,
  p_entity_type text,
  p_entity_id uuid,
  p_organization_id uuid,
  p_description text,
  p_previous jsonb DEFAULT NULL,
  p_new jsonb DEFAULT NULL,
  p_meta jsonb DEFAULT NULL
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
    (admin_user_id, admin_email, action, entity_type, entity_id, organization_id, organization_name, description,
     previous_data, new_data, ip, user_agent, request_id)
  VALUES
    (v_admin, coalesce(v_email, ''), p_action, p_entity_type, p_entity_id, p_organization_id, v_org_name, btrim(p_description),
     v_prev, v_next, left(p_meta ->> 'ip', 64), left(p_meta ->> 'userAgent', 300), left(p_meta ->> 'requestId', 100))
  RETURNING id INTO v_id;
  RETURN v_id;
END;
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION public.platform_record_audit(text, text, uuid, uuid, text, jsonb, jsonb, jsonb) FROM public, anon;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION public.platform_record_audit(text, text, uuid, uuid, text, jsonb, jsonb, jsonb) TO authenticated;
--> statement-breakpoint

DROP FUNCTION public.platform_list_audit(text, uuid, uuid, text, timestamptz, timestamptz, integer, integer);
--> statement-breakpoint
CREATE FUNCTION public.platform_list_audit(
  p_action text DEFAULT NULL,
  p_admin uuid DEFAULT NULL,
  p_org uuid DEFAULT NULL,
  p_org_search text DEFAULT NULL,
  p_from timestamptz DEFAULT NULL,
  p_to timestamptz DEFAULT NULL,
  p_limit integer DEFAULT 20,
  p_offset integer DEFAULT 0,
  p_entity text DEFAULT NULL
)
RETURNS TABLE (
  id uuid, admin_user_id uuid, admin_email text, action text, entity_type text, entity_id uuid,
  organization_id uuid, organization_name text, description text, previous_data jsonb, new_data jsonb,
  created_at timestamptz, ip text, user_agent text, request_id text, total_count bigint
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
         l.created_at, l.ip, l.user_agent, l.request_id, count(*) OVER ()
  FROM public.admin_audit_logs l
  WHERE (p_action IS NULL OR l.action = p_action)
    AND (p_entity IS NULL OR l.entity_type = p_entity)
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
REVOKE ALL ON FUNCTION public.platform_list_audit(text, uuid, uuid, text, timestamptz, timestamptz, integer, integer, text) FROM public, anon;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION public.platform_list_audit(text, uuid, uuid, text, timestamptz, timestamptz, integer, integer, text) TO authenticated;
