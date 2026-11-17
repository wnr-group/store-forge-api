-- Custom migration: Platform Admin organization and store editing, team member management and ownership changes.
--
-- Every function: SECURITY DEFINER, search_path pinned, authorises the caller as a Platform Admin FIRST, takes no
-- caller-supplied identity, and is revoked from public/anon. Each one changes exactly one thing; the app writes the
-- audit entry in the same transaction (see services/platform.service.ts).
--
-- Organization status (tenants.status) and store status (stores.status) are separate columns changed by separate
-- functions: changing one never touches the other.

-- At most one Owner per organization (the ownership function below also locks the organization row). -------------
CREATE UNIQUE INDEX "memberships_one_owner_idx" ON "memberships" USING btree ("tenant_id") WHERE "memberships"."role" = 'owner';
--> statement-breakpoint

-- Organization: name, contact phone and address. The slug and status are not editable here. ----------------------
CREATE FUNCTION public.platform_update_tenant(p_tenant_id uuid, p_name text, p_contact_phone text, p_address text)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  IF NOT public.is_platform_admin() THEN
    RAISE EXCEPTION 'not_platform_admin' USING errcode = '42501';
  END IF;
  IF p_tenant_id IS NULL OR btrim(coalesce(p_name, '')) = '' THEN
    RAISE EXCEPTION 'invalid_input';
  END IF;
  UPDATE public.tenants
  SET name = btrim(p_name), contact_phone = nullif(btrim(coalesce(p_contact_phone, '')), ''), address = nullif(btrim(coalesce(p_address, '')), '')
  WHERE id = p_tenant_id;
  RETURN FOUND;
EXCEPTION WHEN check_violation THEN
  RAISE EXCEPTION 'invalid_input';
END;
$$;
--> statement-breakpoint

-- Store: details of the organization's primary store, plus whether prices already exist (which locks the currency).
CREATE FUNCTION public.platform_get_tenant_store(p_tenant_id uuid)
RETURNS TABLE (
  id uuid, name text, slug text, description text, currency text, timezone text, status text,
  contact_email text, contact_phone text, has_money_data boolean
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
  SELECT s.id, s.name, s.slug, s.description, s.currency, s.timezone, s.status, s.contact_email, s.contact_phone,
         (EXISTS (SELECT 1 FROM public.products p WHERE p.tenant_id = s.tenant_id)
          OR EXISTS (SELECT 1 FROM public.orders o WHERE o.tenant_id = s.tenant_id))
  FROM public.stores s
  WHERE s.tenant_id = p_tenant_id
  ORDER BY s.created_at, s.id
  LIMIT 1;
END;
$$;
--> statement-breakpoint

-- Store: name, description, contact details, currency and timezone. The address (slug) and logo are not editable here.
-- Same rule as the merchant settings page: the currency is fixed once products or orders exist.
CREATE FUNCTION public.platform_update_store(
  p_tenant_id uuid, p_store_id uuid, p_name text, p_description text,
  p_contact_email text, p_contact_phone text, p_currency text, p_timezone text
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_store public.stores%ROWTYPE;
BEGIN
  IF NOT public.is_platform_admin() THEN
    RAISE EXCEPTION 'not_platform_admin' USING errcode = '42501';
  END IF;
  IF p_tenant_id IS NULL OR p_store_id IS NULL OR btrim(coalesce(p_name, '')) = '' OR btrim(coalesce(p_currency, '')) = '' OR btrim(coalesce(p_timezone, '')) = '' THEN
    RAISE EXCEPTION 'invalid_input';
  END IF;
  SELECT * INTO v_store FROM public.stores s WHERE s.id = p_store_id AND s.tenant_id = p_tenant_id FOR UPDATE;
  IF NOT FOUND THEN
    RETURN false;
  END IF;
  IF upper(btrim(p_currency)) <> v_store.currency
     AND (EXISTS (SELECT 1 FROM public.products p WHERE p.tenant_id = p_tenant_id)
          OR EXISTS (SELECT 1 FROM public.orders o WHERE o.tenant_id = p_tenant_id)) THEN
    RAISE EXCEPTION 'currency_locked';
  END IF;
  IF btrim(p_timezone) <> v_store.timezone AND NOT EXISTS (SELECT 1 FROM pg_catalog.pg_timezone_names z WHERE z.name = btrim(p_timezone)) THEN
    RAISE EXCEPTION 'invalid_input';
  END IF;
  UPDATE public.stores
  SET name = btrim(p_name),
      description = nullif(btrim(coalesce(p_description, '')), ''),
      contact_email = nullif(btrim(coalesce(p_contact_email, '')), ''),
      contact_phone = nullif(btrim(coalesce(p_contact_phone, '')), ''),
      currency = upper(btrim(p_currency)),
      timezone = btrim(p_timezone)
  WHERE id = p_store_id AND tenant_id = p_tenant_id;
  RETURN true;
EXCEPTION WHEN check_violation THEN
  RAISE EXCEPTION 'invalid_input';
END;
$$;
--> statement-breakpoint

-- Store status only: active | inactive | suspended. Never touches tenants.status.
CREATE FUNCTION public.platform_set_store_status(p_tenant_id uuid, p_store_id uuid, p_status text)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  IF NOT public.is_platform_admin() THEN
    RAISE EXCEPTION 'not_platform_admin' USING errcode = '42501';
  END IF;
  IF p_status IS NULL OR p_status NOT IN ('active', 'inactive', 'suspended') THEN
    RAISE EXCEPTION 'invalid_input';
  END IF;
  UPDATE public.stores SET status = p_status WHERE id = p_store_id AND tenant_id = p_tenant_id;
  RETURN FOUND;
END;
$$;
--> statement-breakpoint

-- Team: disable or reactivate a member. The Owner can never be disabled (transfer ownership first). ---------------
CREATE FUNCTION public.platform_set_member_status(p_tenant_id uuid, p_user_id uuid, p_status text)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_role text;
BEGIN
  IF NOT public.is_platform_admin() THEN
    RAISE EXCEPTION 'not_platform_admin' USING errcode = '42501';
  END IF;
  IF p_status IS NULL OR p_status NOT IN ('active', 'disabled') THEN
    RAISE EXCEPTION 'invalid_input';
  END IF;
  SELECT m.role INTO v_role FROM public.memberships m WHERE m.tenant_id = p_tenant_id AND m.user_id = p_user_id FOR UPDATE;
  IF NOT FOUND THEN
    RETURN false;
  END IF;
  IF v_role = 'owner' THEN
    RAISE EXCEPTION 'cannot_change_owner';
  END IF;
  UPDATE public.memberships SET status = p_status WHERE tenant_id = p_tenant_id AND user_id = p_user_id;
  RETURN true;
END;
$$;
--> statement-breakpoint

-- Team: remove a member. The Owner can never be removed. Returns true when the person now belongs to no organization,
-- so the server can delete their Auth account too.
CREATE FUNCTION public.platform_remove_member(p_tenant_id uuid, p_user_id uuid)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_role text;
BEGIN
  IF NOT public.is_platform_admin() THEN
    RAISE EXCEPTION 'not_platform_admin' USING errcode = '42501';
  END IF;
  SELECT m.role INTO v_role FROM public.memberships m WHERE m.tenant_id = p_tenant_id AND m.user_id = p_user_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'not_found';
  END IF;
  IF v_role = 'owner' THEN
    RAISE EXCEPTION 'cannot_change_owner';
  END IF;
  DELETE FROM public.memberships WHERE tenant_id = p_tenant_id AND user_id = p_user_id;
  RETURN NOT EXISTS (SELECT 1 FROM public.memberships m WHERE m.user_id = p_user_id);
END;
$$;
--> statement-breakpoint

-- Ownership: make p_user_id the Owner, in ONE transaction. Covers both
--   * a planned transfer (p_user_id is an active team member), and
--   * owner recovery (the organization has no Owner, or the Owner is lost: p_user_id is a member, or a brand-new account
--     that belongs to no organization yet).
-- The organization row is locked, the current Owner (if any) becomes a Manager-level team member (kept active or
-- disabled, as chosen), and the new Owner gets the 'owner' role. There is never a moment with two Owners, and the
-- function either completes or changes nothing.
CREATE FUNCTION public.platform_assign_owner(p_tenant_id uuid, p_user_id uuid, p_previous_owner_status text DEFAULT 'active')
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_old uuid;
  v_member public.memberships%ROWTYPE;
  v_is_member boolean;
BEGIN
  IF NOT public.is_platform_admin() THEN
    RAISE EXCEPTION 'not_platform_admin' USING errcode = '42501';
  END IF;
  IF p_tenant_id IS NULL OR p_user_id IS NULL OR p_previous_owner_status IS NULL OR p_previous_owner_status NOT IN ('active', 'disabled') THEN
    RAISE EXCEPTION 'invalid_input';
  END IF;
  PERFORM 1 FROM public.tenants t WHERE t.id = p_tenant_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'not_found';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM auth.users u WHERE u.id = p_user_id) THEN
    RAISE EXCEPTION 'not_found';
  END IF;

  SELECT m.user_id INTO v_old FROM public.memberships m WHERE m.tenant_id = p_tenant_id AND m.role = 'owner';
  IF v_old = p_user_id THEN
    RAISE EXCEPTION 'already_owner';
  END IF;

  SELECT * INTO v_member FROM public.memberships m WHERE m.tenant_id = p_tenant_id AND m.user_id = p_user_id FOR UPDATE;
  v_is_member := FOUND;
  IF v_is_member AND (v_member.role <> 'admin' OR v_member.status <> 'active') THEN
    RAISE EXCEPTION 'not_eligible';
  END IF;
  -- Someone who is not a member here must be a brand-new account (no membership anywhere): an existing member or owner
  -- of another organization cannot be pulled into this one.
  IF NOT v_is_member AND EXISTS (SELECT 1 FROM public.memberships m WHERE m.user_id = p_user_id) THEN
    RAISE EXCEPTION 'not_eligible';
  END IF;

  IF v_old IS NOT NULL THEN
    UPDATE public.memberships
    SET role = 'admin', status = p_previous_owner_status,
        permissions = '{"products":"write","orders":"read","customers":"write","settings":"write"}'::jsonb
    WHERE tenant_id = p_tenant_id AND user_id = v_old;
  END IF;

  IF v_is_member THEN
    UPDATE public.memberships SET role = 'owner', status = 'active', permissions = '{}'::jsonb
    WHERE tenant_id = p_tenant_id AND user_id = p_user_id;
  ELSE
    INSERT INTO public.memberships (tenant_id, user_id, role, status, permissions)
    VALUES (p_tenant_id, p_user_id, 'owner', 'active', '{}'::jsonb);
  END IF;

  RETURN jsonb_build_object('previous_owner_id', v_old, 'new_owner_id', p_user_id, 'created_membership', NOT v_is_member);
END;
$$;
--> statement-breakpoint

REVOKE ALL ON FUNCTION public.platform_update_tenant(uuid, text, text, text) FROM public, anon;
--> statement-breakpoint
REVOKE ALL ON FUNCTION public.platform_get_tenant_store(uuid) FROM public, anon;
--> statement-breakpoint
REVOKE ALL ON FUNCTION public.platform_update_store(uuid, uuid, text, text, text, text, text, text) FROM public, anon;
--> statement-breakpoint
REVOKE ALL ON FUNCTION public.platform_set_store_status(uuid, uuid, text) FROM public, anon;
--> statement-breakpoint
REVOKE ALL ON FUNCTION public.platform_set_member_status(uuid, uuid, text) FROM public, anon;
--> statement-breakpoint
REVOKE ALL ON FUNCTION public.platform_remove_member(uuid, uuid) FROM public, anon;
--> statement-breakpoint
REVOKE ALL ON FUNCTION public.platform_assign_owner(uuid, uuid, text) FROM public, anon;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION public.platform_update_tenant(uuid, text, text, text) TO authenticated;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION public.platform_get_tenant_store(uuid) TO authenticated;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION public.platform_update_store(uuid, uuid, text, text, text, text, text, text) TO authenticated;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION public.platform_set_store_status(uuid, uuid, text) TO authenticated;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION public.platform_set_member_status(uuid, uuid, text) TO authenticated;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION public.platform_remove_member(uuid, uuid) TO authenticated;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION public.platform_assign_owner(uuid, uuid, text) TO authenticated;
