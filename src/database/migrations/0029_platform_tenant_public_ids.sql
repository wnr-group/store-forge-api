-- Custom migration: let Platform Admins read tenants.public_id (added in 0028) next to the organization lists.
--
-- platform_list_tenants(), platform_list_tenants_page() and platform_provision_tenant() return fixed columns, and a
-- Platform Admin has no direct SELECT on tenants (the only tenants policy is for members). Rather than rewrite those
-- functions (and change their return types), this adds one read-only lookup: tenant id -> public id, for the ids the
-- caller asks about. Nothing is written, no existing function, table or policy changes.

CREATE FUNCTION public.platform_tenant_public_ids(p_tenant_ids uuid[])
RETURNS TABLE (tenant_id uuid, public_id text)
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
  SELECT t.id, t.public_id FROM public.tenants t WHERE t.id = ANY (coalesce(p_tenant_ids, ARRAY[]::uuid[]));
END;
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION public.platform_tenant_public_ids(uuid[]) FROM public, anon;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION public.platform_tenant_public_ids(uuid[]) TO authenticated;
