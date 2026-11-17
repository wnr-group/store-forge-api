-- Custom migration: atomic, idempotent merchant onboarding.
--
-- create_tenant_with_store() creates tenant + owner membership + first store in
-- ONE transaction (a function body is atomic: any RAISE rolls everything back).
-- It is SECURITY DEFINER because there is intentionally no INSERT policy on
-- tenants/memberships. Authorization is strict: the acting user is always
-- auth.uid() from the request context - the function takes NO user-id argument,
-- and it additionally requires that user to exist in auth.users.

CREATE FUNCTION public.is_valid_store_slug(p_slug text)
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

-- Existence check for the onboarding form. SECURITY DEFINER because RLS hides
-- other tenants' stores; it reveals only whether a slug is taken.
CREATE FUNCTION public.is_store_slug_available(p_slug text)
RETURNS boolean
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  IF (SELECT auth.uid()) IS NULL THEN
    RAISE EXCEPTION 'not_authenticated' USING errcode = '28000';
  END IF;
  RETURN public.is_valid_store_slug(p_slug)
    AND NOT EXISTS (SELECT 1 FROM public.stores s WHERE s.slug = p_slug);
END;
$$;
--> statement-breakpoint

CREATE FUNCTION public.create_tenant_with_store(
  p_tenant_name        text,
  p_store_name         text,
  p_store_slug         text,
  p_store_description  text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_uid         uuid := (SELECT auth.uid());
  v_tenant_name text := btrim(coalesce(p_tenant_name, ''));
  v_store_name  text := btrim(coalesce(p_store_name, ''));
  v_description text := nullif(btrim(coalesce(p_store_description, '')), '');
  v_tenant_id   uuid;
  v_store_id    uuid;
  v_tenant_slug text;
BEGIN
  -- Identity: must be present AND a real Supabase Auth user.
  IF v_uid IS NULL OR NOT EXISTS (SELECT 1 FROM auth.users u WHERE u.id = v_uid) THEN
    RAISE EXCEPTION 'not_authenticated' USING errcode = '28000';
  END IF;

  IF char_length(v_tenant_name) NOT BETWEEN 2 AND 80
     OR char_length(v_store_name) NOT BETWEEN 2 AND 80
     OR char_length(coalesce(v_description, '')) > 500 THEN
    RAISE EXCEPTION 'invalid_input';
  END IF;

  IF NOT public.is_valid_store_slug(p_store_slug) THEN
    RAISE EXCEPTION 'invalid_slug';
  END IF;

  -- Serialise concurrent/repeated onboarding for the same user so a double
  -- submit can never create two tenants.
  PERFORM pg_advisory_xact_lock(hashtextextended(v_uid::text, 42));

  -- Idempotent retry: this user already onboarded with this exact store slug.
  SELECT t.id, s.id INTO v_tenant_id, v_store_id
  FROM public.stores s
  JOIN public.tenants t ON t.id = s.tenant_id
  JOIN public.memberships m ON m.tenant_id = t.id
  WHERE s.slug = p_store_slug
    AND m.user_id = v_uid
    AND m.role = 'owner';

  IF v_store_id IS NOT NULL THEN
    RETURN jsonb_build_object(
      'tenant_id', v_tenant_id, 'store_id', v_store_id,
      'store_slug', p_store_slug, 'created', false);
  END IF;

  IF EXISTS (SELECT 1 FROM public.stores s WHERE s.slug = p_store_slug) THEN
    RAISE EXCEPTION 'slug_taken';
  END IF;

  -- Tenant slug defaults to the store slug; fall back to a suffix on collision.
  v_tenant_slug := p_store_slug;
  IF EXISTS (SELECT 1 FROM public.tenants t WHERE t.slug = v_tenant_slug) THEN
    v_tenant_slug := left(p_store_slug, 31) || '-' || substr(replace(gen_random_uuid()::text, '-', ''), 1, 6);
  END IF;

  BEGIN
    INSERT INTO public.tenants (name, slug, created_by)
    VALUES (v_tenant_name, v_tenant_slug, v_uid)
    RETURNING id INTO v_tenant_id;

    INSERT INTO public.memberships (tenant_id, user_id, role)
    VALUES (v_tenant_id, v_uid, 'owner');

    INSERT INTO public.stores (tenant_id, name, slug, description)
    VALUES (v_tenant_id, v_store_name, p_store_slug, v_description)
    RETURNING id INTO v_store_id;
  EXCEPTION WHEN unique_violation THEN
    -- Lost a race on the slug; the sub-transaction rolls the inserts back.
    RAISE EXCEPTION 'slug_taken';
  END;

  RETURN jsonb_build_object(
    'tenant_id', v_tenant_id, 'store_id', v_store_id,
    'store_slug', p_store_slug, 'created', true);
END;
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION public.is_valid_store_slug(text) FROM public, anon;
--> statement-breakpoint
REVOKE ALL ON FUNCTION public.is_store_slug_available(text) FROM public, anon;
--> statement-breakpoint
REVOKE ALL ON FUNCTION public.create_tenant_with_store(text, text, text, text) FROM public, anon;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION public.is_valid_store_slug(text) TO authenticated;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION public.is_store_slug_available(text) TO authenticated;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION public.create_tenant_with_store(text, text, text, text) TO authenticated;
