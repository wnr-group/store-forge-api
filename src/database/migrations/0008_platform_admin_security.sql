-- Custom migration: admin-controlled tenancy.
--
--  * Public onboarding is removed: create_tenant_with_store() (callable by any signed-in user) is dropped.
--    Tenants are now created only by a Platform Admin through platform_provision_tenant().
--  * Platform Admins live in their own table (platform_admins), unreachable from the API (no grants,
--    no policies). is_platform_admin() answers only "is auth.uid() an admin?".
--  * Suspended tenants and disabled memberships lose all access: the two membership helpers that every
--    RLS policy calls now require tenants.status = 'active' and memberships.status = 'active'.
--  * Owners can deactivate members (memberships.status) but can never touch tenants.status; only the
--    Platform Admin functions below can suspend a company.
--  * Cross-user reads that RLS must not expose through ordinary SELECT (member e-mail addresses, the
--    platform company list) go through narrow SECURITY DEFINER functions that authorise the caller first.
-- Every function pins search_path, takes no caller-supplied identity (auth.uid() only) and is revoked
-- from public/anon. The privileged service-role key is never needed by the database layer.

-- Privileges: platform_admins is not reachable by anon/authenticated at all ----------------------------
REVOKE ALL ON public.platform_admins FROM public, anon, authenticated;
--> statement-breakpoint
GRANT UPDATE (status) ON public.memberships TO authenticated;
--> statement-breakpoint

CREATE FUNCTION public.is_platform_admin()
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
  SELECT EXISTS (SELECT 1 FROM public.platform_admins pa WHERE pa.user_id = (SELECT auth.uid()));
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION public.is_platform_admin() FROM public, anon;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION public.is_platform_admin() TO authenticated;
--> statement-breakpoint

-- Membership helpers: active membership in an active tenant ---------------------------------------------
CREATE OR REPLACE FUNCTION public.is_tenant_member(p_tenant_id uuid)
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
  );
$$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION public.has_tenant_role(p_tenant_id uuid, p_roles text[])
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
      AND m.role = ANY (p_roles)
      AND m.status = 'active'
      AND t.status = 'active'
  );
$$;
--> statement-breakpoint

-- A user is either a platform admin or a tenant member, never both ---------------------------------------
CREATE FUNCTION public.block_platform_admin_membership()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  IF TG_TABLE_NAME = 'memberships' THEN
    IF EXISTS (SELECT 1 FROM public.platform_admins pa WHERE pa.user_id = NEW.user_id) THEN
      RAISE EXCEPTION 'platform_admin_cannot_be_member' USING errcode = '42501';
    END IF;
  ELSIF EXISTS (SELECT 1 FROM public.memberships m WHERE m.user_id = NEW.user_id) THEN
    RAISE EXCEPTION 'member_cannot_be_platform_admin' USING errcode = '42501';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION public.block_platform_admin_membership() FROM public, anon, authenticated;
--> statement-breakpoint
CREATE TRIGGER memberships_block_platform_admins
  BEFORE INSERT ON public.memberships
  FOR EACH ROW EXECUTE FUNCTION public.block_platform_admin_membership();
--> statement-breakpoint
CREATE TRIGGER platform_admins_block_members
  BEFORE INSERT ON public.platform_admins
  FOR EACH ROW EXECUTE FUNCTION public.block_platform_admin_membership();
--> statement-breakpoint

-- Company provisioning (Platform Admin only) --------------------------------------------------------------
-- Replaces create_tenant_with_store(). The owner is an EXISTING auth user (created by the server with the
-- Admin Auth API just before this call). Atomic: tenant + owner membership + store in one function body.
-- Idempotent: repeating the call for the same owner and store slug returns the existing records.
DROP FUNCTION public.create_tenant_with_store(text, text, text, text);
--> statement-breakpoint
CREATE FUNCTION public.platform_provision_tenant(
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

  BEGIN
    INSERT INTO public.tenants (name, slug, contact_phone, address, created_by)
    VALUES (v_tenant_name, v_tenant_slug, v_phone, v_address, p_owner_id)
    RETURNING id INTO v_tenant_id;

    INSERT INTO public.memberships (tenant_id, user_id, role)
    VALUES (v_tenant_id, p_owner_id, 'owner');

    INSERT INTO public.stores (tenant_id, name, slug, description, contact_phone)
    VALUES (v_tenant_id, v_store_name, p_store_slug, v_description, v_phone)
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

-- Company list / details (Platform Admin only). Never exposes catalog, customer or order data. -----------
CREATE FUNCTION public.platform_list_tenants(p_tenant_id uuid DEFAULT NULL)
RETURNS TABLE (
  id uuid, name text, slug text, status text, contact_phone text, address text, created_at timestamptz,
  store_id uuid, store_name text, store_slug text,
  owner_id uuid, owner_name text, owner_email text, member_count bigint
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
  SELECT t.id, t.name, t.slug, t.status, t.contact_phone, t.address, t.created_at,
         s.id, s.name, s.slug,
         o.user_id, p.full_name, u.email::text,
         (SELECT count(*) FROM public.memberships mm WHERE mm.tenant_id = t.id)
  FROM public.tenants t
  LEFT JOIN LATERAL (
    SELECT s0.id, s0.name, s0.slug FROM public.stores s0
    WHERE s0.tenant_id = t.id ORDER BY s0.created_at, s0.id LIMIT 1) s ON true
  LEFT JOIN LATERAL (
    SELECT m0.user_id FROM public.memberships m0
    WHERE m0.tenant_id = t.id AND m0.role = 'owner' ORDER BY m0.created_at, m0.id LIMIT 1) o ON true
  LEFT JOIN public.profiles p ON p.id = o.user_id
  LEFT JOIN auth.users u ON u.id = o.user_id
  WHERE p_tenant_id IS NULL OR t.id = p_tenant_id
  ORDER BY t.created_at DESC, t.id;
END;
$$;
--> statement-breakpoint
CREATE FUNCTION public.platform_set_tenant_status(p_tenant_id uuid, p_status text)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  IF NOT public.is_platform_admin() THEN
    RAISE EXCEPTION 'not_platform_admin' USING errcode = '42501';
  END IF;
  IF p_status IS NULL OR p_status NOT IN ('active', 'suspended') THEN
    RAISE EXCEPTION 'invalid_input';
  END IF;
  UPDATE public.tenants SET status = p_status WHERE id = p_tenant_id;
  RETURN FOUND;
END;
$$;
--> statement-breakpoint

-- Team management (company Owner, or Platform Admin for read access) ---------------------------------------
CREATE FUNCTION public.list_tenant_team(p_tenant_id uuid)
RETURNS TABLE (user_id uuid, full_name text, email text, role text, status text, joined_at timestamptz)
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
  SELECT m.user_id, p.full_name, u.email::text, m.role, m.status, m.created_at
  FROM public.memberships m
  JOIN auth.users u ON u.id = m.user_id
  LEFT JOIN public.profiles p ON p.id = m.user_id
  WHERE m.tenant_id = p_tenant_id
  ORDER BY (m.role = 'owner') DESC, m.created_at, m.id;
END;
$$;
--> statement-breakpoint
CREATE FUNCTION public.update_team_member_name(p_tenant_id uuid, p_user_id uuid, p_full_name text)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_name text := btrim(coalesce(p_full_name, ''));
BEGIN
  IF NOT public.has_tenant_role(p_tenant_id, array['owner']) THEN
    RAISE EXCEPTION 'forbidden' USING errcode = '42501';
  END IF;
  IF char_length(v_name) NOT BETWEEN 2 AND 120 THEN
    RAISE EXCEPTION 'invalid_input';
  END IF;
  UPDATE public.profiles p SET full_name = v_name
  WHERE p.id = p_user_id
    AND EXISTS (
      SELECT 1 FROM public.memberships m
      WHERE m.tenant_id = p_tenant_id AND m.user_id = p_user_id AND m.role <> 'owner');
  IF NOT FOUND THEN
    RAISE EXCEPTION 'not_found';
  END IF;
END;
$$;
--> statement-breakpoint
-- Returns true when the user has no membership left anywhere (the caller may then delete the Auth account).
CREATE FUNCTION public.remove_team_member(p_tenant_id uuid, p_user_id uuid)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  IF NOT public.has_tenant_role(p_tenant_id, array['owner']) THEN
    RAISE EXCEPTION 'forbidden' USING errcode = '42501';
  END IF;
  IF p_user_id = (SELECT auth.uid()) THEN
    RAISE EXCEPTION 'cannot_remove_self';
  END IF;
  DELETE FROM public.memberships m
  WHERE m.tenant_id = p_tenant_id AND m.user_id = p_user_id AND m.role <> 'owner';
  IF NOT FOUND THEN
    RAISE EXCEPTION 'not_found';
  END IF;
  RETURN NOT EXISTS (SELECT 1 FROM public.memberships m WHERE m.user_id = p_user_id);
END;
$$;
--> statement-breakpoint

REVOKE ALL ON FUNCTION public.platform_provision_tenant(uuid, text, text, text, text, text, text) FROM public, anon;
--> statement-breakpoint
REVOKE ALL ON FUNCTION public.platform_list_tenants(uuid) FROM public, anon;
--> statement-breakpoint
REVOKE ALL ON FUNCTION public.platform_set_tenant_status(uuid, text) FROM public, anon;
--> statement-breakpoint
REVOKE ALL ON FUNCTION public.list_tenant_team(uuid) FROM public, anon;
--> statement-breakpoint
REVOKE ALL ON FUNCTION public.update_team_member_name(uuid, uuid, text) FROM public, anon;
--> statement-breakpoint
REVOKE ALL ON FUNCTION public.remove_team_member(uuid, uuid) FROM public, anon;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION public.platform_provision_tenant(uuid, text, text, text, text, text, text) TO authenticated;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION public.platform_list_tenants(uuid) TO authenticated;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION public.platform_set_tenant_status(uuid, text) TO authenticated;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION public.list_tenant_team(uuid) TO authenticated;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION public.update_team_member_name(uuid, uuid, text) TO authenticated;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION public.remove_team_member(uuid, uuid) TO authenticated;
