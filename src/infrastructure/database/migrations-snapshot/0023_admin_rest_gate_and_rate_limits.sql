-- Custom migration: keep Platform Admin powers off the public REST API, and add rate limiting.
--
-- 1. The public schema is exposed by Supabase's REST API (PostgREST). Every function granted to `authenticated` can therefore be
--    called directly with a signed-in user's token, skipping the application (its audit entries, its rate limits, its validation).
--    A Platform Admin's own token would pass each function's admin check. PostgREST always connects to the database as the login
--    role `authenticator`; this application connects as `storeforge_app`. `session_user` is not changed by SET ROLE, so it tells the
--    two paths apart and cannot be forged by the caller. is_platform_admin() and is_super_admin() are the first check of every admin
--    function (and of the admin Storage policies), so making them false for the REST path closes it for all of them at once.
--    Organization members and owners are unaffected: they do not use these checks.
-- 2. rate_limits: fixed-window counters shared by every server instance, used for sensitive admin operations and sign-in attempts.
-- 3. Two older functions were left executable by everyone (the default for new functions). Anonymous visitors lose that access:
--    set_updated_at() is a trigger function (triggers do not need the privilege when they fire), and is_valid_member_permissions()
--    is used by a table constraint, so signed-in users keep it.

CREATE OR REPLACE FUNCTION public.is_platform_admin()
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
  SELECT session_user <> 'authenticator'
    AND EXISTS (SELECT 1 FROM public.platform_admins pa WHERE pa.user_id = (SELECT auth.uid()));
$$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION public.is_super_admin()
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
  SELECT session_user <> 'authenticator'
    AND EXISTS (SELECT 1 FROM public.platform_admins pa WHERE pa.user_id = (SELECT auth.uid()) AND pa.role = 'super_admin');
$$;
--> statement-breakpoint
-- The caller's own level, for the admin screens only. Same rule: nothing over REST.
CREATE OR REPLACE FUNCTION public.platform_admin_role()
RETURNS text
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
  SELECT pa.role FROM public.platform_admins pa WHERE pa.user_id = (SELECT auth.uid()) AND session_user <> 'authenticator';
$$;
--> statement-breakpoint

REVOKE ALL ON FUNCTION public.set_updated_at() FROM public, anon, authenticated;
--> statement-breakpoint
REVOKE ALL ON FUNCTION public.is_valid_member_permissions(jsonb) FROM public, anon;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION public.is_valid_member_permissions(jsonb) TO authenticated;
--> statement-breakpoint

-- Rate limiting ------------------------------------------------------------------------------------------------
CREATE TABLE "rate_limits" (
	"key" text NOT NULL,
	"window_start" timestamp with time zone NOT NULL,
	"hits" integer DEFAULT 0 NOT NULL,
	CONSTRAINT "rate_limits_pkey" PRIMARY KEY("key","window_start")
);
--> statement-breakpoint
ALTER TABLE "rate_limits" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
REVOKE ALL ON public.rate_limits FROM public, anon, authenticated;
--> statement-breakpoint

-- Counts one attempt by the calling Platform Admin in `bucket` and says whether it is allowed. The subject is ALWAYS auth.uid(): a
-- caller cannot spend or reset anyone else's allowance. Attempts over the limit keep counting inside the window, which stays fixed.
-- Bucket names, limits and windows are validated so a bad caller cannot create odd rows.
CREATE FUNCTION public.rate_limit_admin(p_bucket text, p_limit integer, p_window_seconds integer)
RETURNS TABLE (allowed boolean, remaining integer, retry_after_seconds integer)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_window timestamptz;
  v_hits integer;
BEGIN
  IF NOT public.is_platform_admin() THEN
    RAISE EXCEPTION 'not_platform_admin' USING errcode = '42501';
  END IF;
  IF p_bucket IS NULL OR p_bucket !~ '^[a-z_.]{1,40}$' OR p_limit IS NULL OR p_limit NOT BETWEEN 1 AND 1000
     OR p_window_seconds IS NULL OR p_window_seconds NOT BETWEEN 1 AND 86400 THEN
    RAISE EXCEPTION 'invalid_input';
  END IF;
  v_window := to_timestamp(floor(extract(epoch FROM now()) / p_window_seconds) * p_window_seconds);
  INSERT INTO public.rate_limits AS r (key, window_start, hits)
  VALUES (p_bucket || ':' || (SELECT auth.uid())::text, v_window, 1)
  ON CONFLICT (key, window_start) DO UPDATE SET hits = r.hits + 1
  RETURNING r.hits INTO v_hits;
  IF random() < 0.01 THEN
    DELETE FROM public.rate_limits WHERE window_start < now() - interval '2 days';
  END IF;
  RETURN QUERY SELECT v_hits <= p_limit, greatest(p_limit - v_hits, 0),
                      greatest(ceil(extract(epoch FROM (v_window + make_interval(secs => p_window_seconds) - now())))::integer, 1);
END;
$$;
--> statement-breakpoint

-- Sign-in attempts, before anyone is signed in. The subject must be a SHA-256 / HMAC hex digest (the app never sends a raw address or
-- e-mail), the limits are fixed here: 8 attempts per 15 minutes for one address + e-mail, 40 per 15 minutes for one address.
-- p_kind: 'email' (address + e-mail) or 'ip' (address only).
CREATE FUNCTION public.rate_limit_login(p_subject text, p_kind text)
RETURNS TABLE (allowed boolean, remaining integer, retry_after_seconds integer)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_limit integer;
  v_window timestamptz;
  v_hits integer;
  c_seconds CONSTANT integer := 900;
BEGIN
  IF p_subject IS NULL OR p_subject !~ '^[0-9a-f]{64}$' OR p_kind IS NULL OR p_kind NOT IN ('email', 'ip') THEN
    RAISE EXCEPTION 'invalid_input';
  END IF;
  v_limit := CASE p_kind WHEN 'email' THEN 8 ELSE 40 END;
  v_window := to_timestamp(floor(extract(epoch FROM now()) / c_seconds) * c_seconds);
  INSERT INTO public.rate_limits AS r (key, window_start, hits)
  VALUES ('login:' || p_kind || ':' || p_subject, v_window, 1)
  ON CONFLICT (key, window_start) DO UPDATE SET hits = r.hits + 1
  RETURNING r.hits INTO v_hits;
  IF random() < 0.01 THEN
    DELETE FROM public.rate_limits WHERE window_start < now() - interval '2 days';
  END IF;
  RETURN QUERY SELECT v_hits <= v_limit, greatest(v_limit - v_hits, 0),
                      greatest(ceil(extract(epoch FROM (v_window + make_interval(secs => c_seconds) - now())))::integer, 1);
END;
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION public.rate_limit_admin(text, integer, integer) FROM public, anon;
--> statement-breakpoint
REVOKE ALL ON FUNCTION public.rate_limit_login(text, text) FROM public, anon;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION public.rate_limit_admin(text, integer, integer) TO authenticated;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION public.rate_limit_login(text, text) TO authenticated;
