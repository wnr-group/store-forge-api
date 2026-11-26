-- Custom migration: a platform logo. Super admins upload one image in Settings; it replaces the built-in mark on the sign-in page,
-- the public site and the dashboards.
--
-- The image lives in its own public Storage bucket (`platform-assets`, read by anyone like store images, written only by super admins);
-- platform_settings keeps just its path. The path is read through get_platform_settings() (admins) and get_public_platform_settings()
-- (everyone, it is branding) and written only by platform_set_logo() (super admins).

ALTER TABLE "platform_settings" ADD COLUMN "logo_path" text;
--> statement-breakpoint
ALTER TABLE "platform_settings" ADD CONSTRAINT "platform_settings_logo_path_check"
  CHECK ("logo_path" IS NULL OR "logo_path" ~ '^logo/[A-Za-z0-9._-]{1,120}$');
--> statement-breakpoint

DROP FUNCTION public.get_platform_settings();
--> statement-breakpoint
CREATE FUNCTION public.get_platform_settings()
RETURNS TABLE (
  platform_name text, support_email text, default_currency text, default_timezone text, default_store_status text,
  updated_at timestamptz, updated_by_email text, logo_path text
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
         s.updated_at, u.email::text, s.logo_path
  FROM public.platform_settings s
  LEFT JOIN auth.users u ON u.id = s.updated_by;
END;
$$;
--> statement-breakpoint
DROP FUNCTION public.get_public_platform_settings();
--> statement-breakpoint
CREATE FUNCTION public.get_public_platform_settings()
RETURNS TABLE (platform_name text, support_email text, logo_path text)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
  SELECT s.platform_name, s.support_email, s.logo_path FROM public.platform_settings s;
$$;
--> statement-breakpoint

-- Super admins only. Pass NULL to go back to the built-in logo. Returns the path it replaced so the caller can delete that file.
CREATE FUNCTION public.platform_set_logo(p_path text)
RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_previous text;
BEGIN
  IF NOT public.is_super_admin() THEN
    RAISE EXCEPTION 'not_super_admin' USING errcode = '42501';
  END IF;
  IF p_path IS NOT NULL AND p_path !~ '^logo/[A-Za-z0-9._-]{1,120}$' THEN
    RAISE EXCEPTION 'invalid_input';
  END IF;
  SELECT s.logo_path INTO v_previous FROM public.platform_settings s WHERE s.id;
  UPDATE public.platform_settings
  SET logo_path = p_path, updated_at = now(), updated_by = (SELECT auth.uid())
  WHERE id;
  RETURN v_previous;
END;
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION public.get_platform_settings() FROM public, anon;
--> statement-breakpoint
REVOKE ALL ON FUNCTION public.get_public_platform_settings() FROM public, anon;
--> statement-breakpoint
REVOKE ALL ON FUNCTION public.platform_set_logo(text) FROM public, anon;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION public.get_platform_settings() TO authenticated;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION public.get_public_platform_settings() TO authenticated;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION public.platform_set_logo(text) TO authenticated;
--> statement-breakpoint

-- Bucket + policies. Skipped where Supabase Storage does not exist (the PGlite test database). Public READ works through the bucket's
-- `public` flag; the policies below govern listing and every WRITE and allow super admins only.
DO $storage$
BEGIN
  IF to_regclass('storage.objects') IS NULL THEN
    RAISE NOTICE 'storage.objects not found - skipping platform-assets bucket and policies';
    RETURN;
  END IF;

  INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
  VALUES ('platform-assets', 'platform-assets', true, 2097152, ARRAY['image/jpeg', 'image/png', 'image/webp'])
  ON CONFLICT (id) DO UPDATE
    SET public = true, file_size_limit = 2097152,
        allowed_mime_types = ARRAY['image/jpeg', 'image/png', 'image/webp'];

  DROP POLICY IF EXISTS platform_assets_select ON storage.objects;
  DROP POLICY IF EXISTS platform_assets_insert ON storage.objects;
  DROP POLICY IF EXISTS platform_assets_update ON storage.objects;
  DROP POLICY IF EXISTS platform_assets_delete ON storage.objects;

  CREATE POLICY platform_assets_select ON storage.objects FOR SELECT TO authenticated
    USING (bucket_id = 'platform-assets' AND public.is_super_admin());
  CREATE POLICY platform_assets_insert ON storage.objects FOR INSERT TO authenticated
    WITH CHECK (bucket_id = 'platform-assets' AND public.is_super_admin() AND name ~ '^logo/[A-Za-z0-9._-]{1,120}$');
  CREATE POLICY platform_assets_update ON storage.objects FOR UPDATE TO authenticated
    USING (bucket_id = 'platform-assets' AND public.is_super_admin())
    WITH CHECK (bucket_id = 'platform-assets' AND public.is_super_admin() AND name ~ '^logo/[A-Za-z0-9._-]{1,120}$');
  CREATE POLICY platform_assets_delete ON storage.objects FOR DELETE TO authenticated
    USING (bucket_id = 'platform-assets' AND public.is_super_admin());
END
$storage$;
