-- Custom migration: remove three admin features that are not needed.
--   * Support notes: the table and the three functions that used it.
--   * Per-organization store status controls (activate / deactivate / suspend a store): an organization is suspended or deleted instead.
--     The store's own status column stays (merchants still use it); only the Platform Admin function is removed.
--   * Admin-managed reserved store addresses: the setting, its check and helper, and the table read in is_valid_store_slug().
--     The built-in reserved list in is_valid_store_slug() is unchanged.
-- Nothing else is touched. The default currency, timezone and "new stores start as" settings stay.

-- Support notes ------------------------------------------------------------------------------------------------
DROP FUNCTION public.platform_add_support_note(uuid, text);
--> statement-breakpoint
DROP FUNCTION public.platform_update_support_note(uuid, text);
--> statement-breakpoint
DROP FUNCTION public.platform_list_support_notes(uuid, text, integer, integer);
--> statement-breakpoint
DROP TABLE public.organization_support_notes;
--> statement-breakpoint

-- Store status ---------------------------------------------------------------------------------------------------
DROP FUNCTION public.platform_set_store_status(uuid, uuid, text);
--> statement-breakpoint

-- Reserved store addresses --------------------------------------------------------------------------------------
-- Back to the built-in list only (the definition from the onboarding migration): no table is read any more.
CREATE OR REPLACE FUNCTION public.is_valid_store_slug(p_slug text)
RETURNS boolean
LANGUAGE sql
IMMUTABLE
SET search_path = ''
AS $$
  SELECT coalesce(
    p_slug ~ '^[a-z0-9][a-z0-9-]{1,38}[a-z0-9]$'
    AND p_slug !~ '--'
    AND p_slug <> ALL (array[
      'www', 'app', 'api', 'admin', 'dashboard', 'auth', 'login', 'register',
      'static', 'assets', 'cdn', 'mail', 'support', 'help', 'billing',
      'storeforge', 'status', 'blog', 'docs'
    ]),
    false);
$$;
--> statement-breakpoint
DROP FUNCTION public.platform_update_settings(text, text, text, text, text, text[]);
--> statement-breakpoint
DROP FUNCTION public.get_platform_settings();
--> statement-breakpoint
ALTER TABLE "platform_settings" DROP CONSTRAINT "platform_settings_reserved_check";
--> statement-breakpoint
ALTER TABLE "platform_settings" DROP COLUMN "reserved_subdomains";
--> statement-breakpoint
DROP FUNCTION public.is_valid_reserved_subdomains(text[]);
--> statement-breakpoint

CREATE FUNCTION public.get_platform_settings()
RETURNS TABLE (
  platform_name text, support_email text, default_currency text, default_timezone text, default_store_status text,
  updated_at timestamptz, updated_by_email text
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
  SELECT s.platform_name, s.support_email, s.default_currency, s.default_timezone, s.default_store_status,
         s.updated_at, u.email::text
  FROM public.platform_settings s
  LEFT JOIN auth.users u ON u.id = s.updated_by;
END;
$$;
--> statement-breakpoint

-- Super admins only. Validated here as well as in the app.
CREATE FUNCTION public.platform_update_settings(
  p_platform_name text, p_support_email text, p_default_currency text, p_default_timezone text, p_default_store_status text
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_email text := nullif(btrim(coalesce(p_support_email, '')), '');
BEGIN
  IF NOT public.is_super_admin() THEN
    RAISE EXCEPTION 'not_super_admin' USING errcode = '42501';
  END IF;
  IF char_length(btrim(coalesce(p_platform_name, ''))) NOT BETWEEN 2 AND 60
     OR btrim(coalesce(p_default_currency, '')) = '' OR btrim(coalesce(p_default_timezone, '')) = ''
     OR p_default_store_status IS NULL OR p_default_store_status NOT IN ('active', 'inactive')
     OR (v_email IS NOT NULL AND (char_length(v_email) > 254 OR position('@' in v_email) <= 1)) THEN
    RAISE EXCEPTION 'invalid_input';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_timezone_names z WHERE z.name = btrim(p_default_timezone)) THEN
    RAISE EXCEPTION 'invalid_input';
  END IF;
  UPDATE public.platform_settings
  SET platform_name = btrim(p_platform_name), support_email = v_email, default_currency = upper(btrim(p_default_currency)),
      default_timezone = btrim(p_default_timezone), default_store_status = p_default_store_status,
      updated_at = now(), updated_by = (SELECT auth.uid())
  WHERE id;
  RETURN FOUND;
EXCEPTION WHEN check_violation THEN
  RAISE EXCEPTION 'invalid_input';
END;
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION public.get_platform_settings() FROM public, anon;
--> statement-breakpoint
REVOKE ALL ON FUNCTION public.platform_update_settings(text, text, text, text, text) FROM public, anon;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION public.get_platform_settings() TO authenticated;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION public.platform_update_settings(text, text, text, text, text) TO authenticated;
