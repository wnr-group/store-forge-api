-- Platform Admin: add a Manager/Staff member to any company.
-- Owners already do this through RLS (memberships_insert_managers requires the Owner role of the tenant),
-- which a Platform Admin deliberately does not have. This narrow SECURITY DEFINER function authorises the
-- caller as a Platform Admin first, fixes the allowed roles (never 'owner') and links an EXISTING auth user
-- (created by the server with the Admin Auth API just before this call).
CREATE FUNCTION public.platform_add_member(p_tenant_id uuid, p_user_id uuid, p_role text)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  IF NOT public.is_platform_admin() THEN
    RAISE EXCEPTION 'not_platform_admin' USING errcode = '42501';
  END IF;
  IF p_tenant_id IS NULL OR p_user_id IS NULL OR p_role IS NULL OR p_role NOT IN ('admin', 'staff') THEN
    RAISE EXCEPTION 'invalid_input';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.tenants t WHERE t.id = p_tenant_id) THEN
    RAISE EXCEPTION 'not_found';
  END IF;
  INSERT INTO public.memberships (tenant_id, user_id, role) VALUES (p_tenant_id, p_user_id, p_role);
END;
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION public.platform_add_member(uuid, uuid, text) FROM public, anon;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION public.platform_add_member(uuid, uuid, text) TO authenticated;
