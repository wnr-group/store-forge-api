-- Custom migration: per-module permissions an Owner grants and revokes for each team member.
--
-- Model
--  * memberships.permissions is a jsonb object {module: 'none' | 'read' | 'write'} for the modules
--    products (catalog, stock, collections), orders, customers and settings (store settings).
--    'write' includes 'read'. A missing module means no access. The Owner always has full access.
--  * The existing role policies stay as they are. Each tenant table additionally gets RESTRICTIVE policies
--    that require has_module_access(); a restrictive policy is ANDed with the permissive ones, so a member
--    needs both. Team members are stored with role 'admin' (the broadest non-owner role) so that the role
--    policies never get in the way and the permissions alone decide what a member can do.
--  * settings: store/tenant rows stay readable by every member (the dashboard needs them); only writes
--    are gated.
--  * Only the Owner can add or remove memberships. Previously a role-'admin' member could add 'staff'
--    rows; with permissions that would let a member hand out access, so it is now Owner-only.

-- Validation ------------------------------------------------------------------------------------------
CREATE FUNCTION public.is_valid_member_permissions(p jsonb)
RETURNS boolean
LANGUAGE sql
IMMUTABLE
SET search_path = ''
AS $$
  SELECT jsonb_typeof(p) = 'object'
    AND NOT EXISTS (
      SELECT 1 FROM jsonb_each(p) e
      WHERE e.key NOT IN ('products', 'orders', 'customers', 'settings')
         OR jsonb_typeof(e.value) <> 'string'
         OR (e.value #>> '{}') NOT IN ('none', 'read', 'write')
    );
$$;
--> statement-breakpoint
ALTER TABLE "memberships" ADD COLUMN "permissions" jsonb DEFAULT '{}'::jsonb NOT NULL;
--> statement-breakpoint

-- Backfill: carry today's role over as an explicit permission set, then fold 'staff' into 'admin'.
-- (Former Staff could not delete; 'write' now includes delete, so the Owner may want to review them.)
UPDATE public.memberships SET permissions = CASE role
  WHEN 'staff' THEN '{"products":"write","orders":"read","customers":"write","settings":"read"}'::jsonb
  ELSE '{"products":"write","orders":"write","customers":"write","settings":"write"}'::jsonb
END;
--> statement-breakpoint
UPDATE public.memberships SET role = 'admin' WHERE role = 'staff';
--> statement-breakpoint
ALTER TABLE "memberships" ADD CONSTRAINT "memberships_permissions_check" CHECK (public.is_valid_member_permissions("memberships"."permissions"));
--> statement-breakpoint
GRANT UPDATE (permissions) ON public.memberships TO authenticated;
--> statement-breakpoint

-- Access check ------------------------------------------------------------------------------------------
CREATE FUNCTION public.has_module_access(p_tenant_id uuid, p_module text, p_level text)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
  SELECT EXISTS (
    SELECT 1
    FROM public.memberships m
    JOIN public.tenants t ON t.id = m.tenant_id
    WHERE m.tenant_id = p_tenant_id
      AND m.user_id = (SELECT auth.uid())
      AND m.status = 'active'
      AND t.status = 'active'
      AND (
        m.role = 'owner'
        OR CASE m.permissions ->> p_module
             WHEN 'write' THEN true
             WHEN 'read' THEN p_level = 'read'
             ELSE false
           END
      )
  );
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION public.has_module_access(uuid, text, text) FROM public, anon;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION public.has_module_access(uuid, text, text) TO authenticated;
--> statement-breakpoint

-- Restrictive policies ------------------------------------------------------------------------------------
DO $perm$
DECLARE
  t record;
BEGIN
  FOR t IN
    SELECT * FROM (VALUES
      ('categories', 'products', 'tenant_id', true),
      ('collections', 'products', 'tenant_id', true),
      ('collection_products', 'products', 'tenant_id', true),
      ('products', 'products', 'tenant_id', true),
      ('product_images', 'products', 'tenant_id', true),
      ('product_options', 'products', 'tenant_id', true),
      ('product_variants', 'products', 'tenant_id', true),
      ('inventory_adjustments', 'products', 'tenant_id', true),
      ('customers', 'customers', 'tenant_id', true),
      ('orders', 'orders', 'tenant_id', true),
      ('order_items', 'orders', 'tenant_id', true),
      ('stores', 'settings', 'tenant_id', false),
      ('tenants', 'settings', 'id', false)
    ) AS v(tbl, module, col, gate_read)
  LOOP
    IF t.gate_read THEN
      EXECUTE format(
        'CREATE POLICY %I ON public.%I AS RESTRICTIVE FOR SELECT TO authenticated USING (public.has_module_access(%I, %L, ''read''))',
        t.tbl || '_perm_select', t.tbl, t.col, t.module);
    END IF;
    EXECUTE format(
      'CREATE POLICY %I ON public.%I AS RESTRICTIVE FOR INSERT TO authenticated WITH CHECK (public.has_module_access(%I, %L, ''write''))',
      t.tbl || '_perm_insert', t.tbl, t.col, t.module);
    EXECUTE format(
      'CREATE POLICY %I ON public.%I AS RESTRICTIVE FOR UPDATE TO authenticated USING (public.has_module_access(%I, %L, ''write'')) WITH CHECK (public.has_module_access(%I, %L, ''write''))',
      t.tbl || '_perm_update', t.tbl, t.col, t.module, t.col, t.module);
    EXECUTE format(
      'CREATE POLICY %I ON public.%I AS RESTRICTIVE FOR DELETE TO authenticated USING (public.has_module_access(%I, %L, ''write''))',
      t.tbl || '_perm_delete', t.tbl, t.col, t.module);
  END LOOP;
END
$perm$;
--> statement-breakpoint

-- Only the Owner adds or removes memberships (members may still leave a company themselves).
CREATE POLICY memberships_perm_insert ON public.memberships AS RESTRICTIVE
  FOR INSERT TO authenticated
  WITH CHECK (public.has_tenant_role(tenant_id, array['owner']));
--> statement-breakpoint
CREATE POLICY memberships_perm_delete ON public.memberships AS RESTRICTIVE
  FOR DELETE TO authenticated
  USING (user_id = (SELECT auth.uid()) OR public.has_tenant_role(tenant_id, array['owner']));
--> statement-breakpoint

-- Storage: catalog media needs products:write, the store's own assets (`{tenant}/store/...`) settings:write.
CREATE OR REPLACE FUNCTION public.can_write_storage_object(p_name text)
RETURNS boolean
LANGUAGE sql
STABLE
SET search_path = ''
AS $$
  SELECT public.has_module_access(
    public.storage_path_tenant(p_name),
    CASE WHEN split_part(p_name, '/', 2) = 'store' THEN 'settings' ELSE 'products' END,
    'write'
  );
$$;
--> statement-breakpoint
DO $storage$
BEGIN
  IF to_regclass('storage.objects') IS NULL THEN
    RETURN;
  END IF;
  DROP POLICY IF EXISTS products_objects_update ON storage.objects;
  CREATE POLICY products_objects_update ON storage.objects FOR UPDATE TO authenticated
    USING (bucket_id = 'products' AND public.can_write_storage_object(name))
    WITH CHECK (bucket_id = 'products' AND public.can_write_storage_object(name));
END
$storage$;
--> statement-breakpoint

-- Team reads and the Platform Admin "add member" function now carry the permissions ---------------------
DROP FUNCTION public.list_tenant_team(uuid);
--> statement-breakpoint
CREATE FUNCTION public.list_tenant_team(p_tenant_id uuid)
RETURNS TABLE (user_id uuid, full_name text, email text, role text, status text, joined_at timestamptz, permissions jsonb)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
#variable_conflict use_column
BEGIN
  IF NOT (public.is_platform_admin() OR public.has_tenant_role(p_tenant_id, array['owner'])) THEN
    RAISE EXCEPTION 'forbidden' USING errcode = '42501';
  END IF;
  RETURN QUERY
  SELECT m.user_id, p.full_name, u.email::text, m.role, m.status, m.created_at, m.permissions
  FROM public.memberships m
  JOIN auth.users u ON u.id = m.user_id
  LEFT JOIN public.profiles p ON p.id = m.user_id
  WHERE m.tenant_id = p_tenant_id
  ORDER BY (m.role = 'owner') DESC, m.created_at, m.id;
END;
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION public.list_tenant_team(uuid) FROM public, anon;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION public.list_tenant_team(uuid) TO authenticated;
--> statement-breakpoint

DROP FUNCTION public.platform_add_member(uuid, uuid, text);
--> statement-breakpoint
CREATE FUNCTION public.platform_add_member(p_tenant_id uuid, p_user_id uuid, p_permissions jsonb)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  IF NOT public.is_platform_admin() THEN
    RAISE EXCEPTION 'not_platform_admin' USING errcode = '42501';
  END IF;
  IF p_tenant_id IS NULL OR p_user_id IS NULL OR NOT public.is_valid_member_permissions(p_permissions) THEN
    RAISE EXCEPTION 'invalid_input';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.tenants t WHERE t.id = p_tenant_id) THEN
    RAISE EXCEPTION 'not_found';
  END IF;
  INSERT INTO public.memberships (tenant_id, user_id, role, permissions) VALUES (p_tenant_id, p_user_id, 'admin', p_permissions);
END;
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION public.platform_add_member(uuid, uuid, jsonb) FROM public, anon;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION public.platform_add_member(uuid, uuid, jsonb) TO authenticated;
