-- Custom migration: a Platform Admin can delete an organization.
--
-- platform_delete_tenant() removes the tenant row; every tenant-owned table references tenants(id) with
-- ON DELETE CASCADE, so memberships, stores, the catalog, customers and orders all go in the same transaction.
-- It returns (as a JSON array of user ids) the people who are left with no membership anywhere, so the server can
-- delete their Auth accounts too. Someone who also belongs to another organization is NOT returned and keeps
-- their account. Nothing is returned for the Platform Admin themself (a Platform Admin is never a member).
CREATE FUNCTION public.platform_delete_tenant(p_tenant_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_users uuid[];
  v_orphans uuid[];
BEGIN
  IF NOT public.is_platform_admin() THEN
    RAISE EXCEPTION 'not_platform_admin' USING errcode = '42501';
  END IF;
  IF p_tenant_id IS NULL THEN
    RAISE EXCEPTION 'invalid_input';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.tenants t WHERE t.id = p_tenant_id) THEN
    RAISE EXCEPTION 'not_found';
  END IF;

  SELECT coalesce(array_agg(m.user_id), '{}') INTO v_users FROM public.memberships m WHERE m.tenant_id = p_tenant_id;

  DELETE FROM public.tenants WHERE id = p_tenant_id;

  SELECT coalesce(array_agg(u), '{}') INTO v_orphans
  FROM unnest(v_users) AS u
  WHERE NOT EXISTS (SELECT 1 FROM public.memberships m WHERE m.user_id = u);

  RETURN to_jsonb(v_orphans);
END;
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION public.platform_delete_tenant(uuid) FROM public, anon;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION public.platform_delete_tenant(uuid) TO authenticated;
--> statement-breakpoint

-- Storage: so the deleted organization's files can be removed with the Platform Admin's OWN session (the
-- service-role key is never used for Storage). A Platform Admin may list and delete objects in the products
-- bucket; they cannot upload or overwrite anything.
DO $storage$
BEGIN
  IF to_regclass('storage.objects') IS NULL THEN
    RETURN;
  END IF;
  DROP POLICY IF EXISTS products_objects_platform_select ON storage.objects;
  DROP POLICY IF EXISTS products_objects_platform_delete ON storage.objects;
  CREATE POLICY products_objects_platform_select ON storage.objects FOR SELECT TO authenticated
    USING (bucket_id = 'products' AND public.is_platform_admin());
  CREATE POLICY products_objects_platform_delete ON storage.objects FOR DELETE TO authenticated
    USING (bucket_id = 'products' AND public.is_platform_admin());
END
$storage$;
