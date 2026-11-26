-- Custom migration: Billing Admin and Support Admin platform roles.
--
-- platform_admins.role becomes one of super_admin | admin | billing_admin | support_admin. `admin` keeps its meaning (Platform Admin).
-- Existing rows are untouched. Only a super admin can add or change admins, and the LAST super admin can never be demoted
-- or removed (platform_remove_admin is unchanged). What each role may do is decided by the API (platform-permissions.ts):
-- routes that declare no permission stay closed to the two new roles.

ALTER TABLE "platform_admins" DROP CONSTRAINT "platform_admins_role_check";
--> statement-breakpoint
ALTER TABLE "platform_admins" ADD CONSTRAINT "platform_admins_role_check" CHECK ("platform_admins"."role" in ('super_admin', 'admin', 'billing_admin', 'support_admin'));
--> statement-breakpoint

CREATE OR REPLACE FUNCTION public.platform_add_admin(p_user_id uuid, p_role text)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  IF NOT public.is_super_admin() THEN
    RAISE EXCEPTION 'not_super_admin' USING errcode = '42501';
  END IF;
  IF p_user_id IS NULL OR p_role IS NULL OR p_role NOT IN ('super_admin', 'admin', 'billing_admin', 'support_admin') THEN
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

CREATE OR REPLACE FUNCTION public.platform_set_admin_role(p_user_id uuid, p_role text)
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
  IF p_user_id IS NULL OR p_role IS NULL OR p_role NOT IN ('super_admin', 'admin', 'billing_admin', 'support_admin') THEN
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
