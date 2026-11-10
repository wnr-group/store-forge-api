-- Custom migration: Row Level Security policies, helper functions and grants.
-- (ENABLE ROW LEVEL SECURITY is emitted by the baseline from `.enableRLS()` in the schema.)
--
-- Design notes
--  * Policies never query the table they protect directly (that would recurse).
--    Membership checks go through the two helper functions below.
--  * The helpers are SECURITY DEFINER so they can read `memberships` without
--    re-entering its RLS policies. They are safe because they (a) pin
--    search_path, (b) only ever look at auth.uid() - never a caller-supplied
--    user id - and (c) return a boolean about the caller's own membership.
--  * Table privileges are explicit. anon gets nothing. authenticated gets only
--    what the policies can then further restrict, with column-level UPDATE
--    grants so immutable columns (tenant_id, user_id, created_by) can't change.
--  * Tenants/memberships are created ONLY by create_tenant_with_store()
--    (next migration); there is deliberately no INSERT policy on tenants.

CREATE FUNCTION public.is_tenant_member(p_tenant_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.memberships m
    WHERE m.tenant_id = p_tenant_id
      AND m.user_id = (SELECT auth.uid())
  );
$$;
--> statement-breakpoint
CREATE FUNCTION public.has_tenant_role(p_tenant_id uuid, p_roles text[])
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.memberships m
    WHERE m.tenant_id = p_tenant_id
      AND m.user_id = (SELECT auth.uid())
      AND m.role = ANY (p_roles)
  );
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION public.is_tenant_member(uuid) FROM public, anon;
--> statement-breakpoint
REVOKE ALL ON FUNCTION public.has_tenant_role(uuid, text[]) FROM public, anon;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION public.is_tenant_member(uuid) TO authenticated;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION public.has_tenant_role(uuid, text[]) TO authenticated;
--> statement-breakpoint

-- Privileges
REVOKE ALL ON public.profiles, public.tenants, public.memberships, public.stores
  FROM public, anon, authenticated;
--> statement-breakpoint
GRANT SELECT ON public.profiles TO authenticated;
--> statement-breakpoint
GRANT UPDATE (full_name, avatar_url) ON public.profiles TO authenticated;
--> statement-breakpoint
GRANT SELECT, DELETE ON public.tenants TO authenticated;
--> statement-breakpoint
GRANT UPDATE (name, slug) ON public.tenants TO authenticated;
--> statement-breakpoint
GRANT SELECT, INSERT, DELETE ON public.memberships TO authenticated;
--> statement-breakpoint
GRANT UPDATE (role) ON public.memberships TO authenticated;
--> statement-breakpoint
GRANT SELECT, INSERT, DELETE ON public.stores TO authenticated;
--> statement-breakpoint
GRANT UPDATE (name, slug, description, logo_url, currency, timezone, status)
  ON public.stores TO authenticated;
--> statement-breakpoint

-- profiles: own row only
CREATE POLICY profiles_select_own ON public.profiles
  FOR SELECT TO authenticated
  USING (id = (SELECT auth.uid()));
--> statement-breakpoint
CREATE POLICY profiles_update_own ON public.profiles
  FOR UPDATE TO authenticated
  USING (id = (SELECT auth.uid()))
  WITH CHECK (id = (SELECT auth.uid()));
--> statement-breakpoint

-- tenants
CREATE POLICY tenants_select_members ON public.tenants
  FOR SELECT TO authenticated
  USING (public.is_tenant_member(id));
--> statement-breakpoint
CREATE POLICY tenants_update_admins ON public.tenants
  FOR UPDATE TO authenticated
  USING (public.has_tenant_role(id, array['owner', 'admin']))
  WITH CHECK (public.has_tenant_role(id, array['owner', 'admin']));
--> statement-breakpoint
CREATE POLICY tenants_delete_owner ON public.tenants
  FOR DELETE TO authenticated
  USING (public.has_tenant_role(id, array['owner']));
--> statement-breakpoint

-- memberships
--  * The 'owner' role can never be granted, changed or removed through RLS
--    (owner rows are created only by the onboarding function).
--  * Owners manage admins/staff; admins manage staff only.
--  * Nobody can modify their own role.
CREATE POLICY memberships_select_members ON public.memberships
  FOR SELECT TO authenticated
  USING (public.is_tenant_member(tenant_id));
--> statement-breakpoint
CREATE POLICY memberships_insert_managers ON public.memberships
  FOR INSERT TO authenticated
  WITH CHECK (
    user_id <> (SELECT auth.uid())
    AND (
      (role = 'staff' AND public.has_tenant_role(tenant_id, array['owner', 'admin']))
      OR (role = 'admin' AND public.has_tenant_role(tenant_id, array['owner']))
    )
  );
--> statement-breakpoint
CREATE POLICY memberships_update_owner ON public.memberships
  FOR UPDATE TO authenticated
  USING (
    role <> 'owner'
    AND user_id <> (SELECT auth.uid())
    AND public.has_tenant_role(tenant_id, array['owner'])
  )
  WITH CHECK (
    role IN ('admin', 'staff')
    AND public.has_tenant_role(tenant_id, array['owner'])
  );
--> statement-breakpoint
CREATE POLICY memberships_delete ON public.memberships
  FOR DELETE TO authenticated
  USING (
    role <> 'owner'
    AND (
      user_id = (SELECT auth.uid())  -- leave a tenant voluntarily
      OR (role = 'staff' AND public.has_tenant_role(tenant_id, array['owner', 'admin']))
      OR (role = 'admin' AND public.has_tenant_role(tenant_id, array['owner']))
    )
  );
--> statement-breakpoint

-- stores
CREATE POLICY stores_select_members ON public.stores
  FOR SELECT TO authenticated
  USING (public.is_tenant_member(tenant_id));
--> statement-breakpoint
CREATE POLICY stores_insert_admins ON public.stores
  FOR INSERT TO authenticated
  WITH CHECK (public.has_tenant_role(tenant_id, array['owner', 'admin']));
--> statement-breakpoint
CREATE POLICY stores_update_admins ON public.stores
  FOR UPDATE TO authenticated
  USING (public.has_tenant_role(tenant_id, array['owner', 'admin']))
  WITH CHECK (public.has_tenant_role(tenant_id, array['owner', 'admin']));
--> statement-breakpoint
CREATE POLICY stores_delete_owner ON public.stores
  FOR DELETE TO authenticated
  USING (public.has_tenant_role(tenant_id, array['owner']));
